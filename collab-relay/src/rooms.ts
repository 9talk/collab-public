import type { WebSocket } from "ws";

export interface Peer {
  ws: WebSocket;
  deviceId: string;
  role: "host" | "client";
  displayName?: string;
}

export interface PairRecord {
  code: string;
  deviceId: string;
  expiresAt: number;
}

const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

// 6-digit code avoiding visually-confusing digits (0/O, 1/I).
const CODE_ALPHABET = "23456789";

function randomCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

export class Rooms {
  // deviceId -> host peer (one host connection per device)
  private hosts = new Map<string, Peer>();
  // pairCode -> pairing record
  private codes = new Map<string, PairRecord>();
  // ws -> peer (reverse lookup for drop())
  private byWs = new Map<WebSocket, Peer>();
  // deviceId -> client peer (null = paired in the past, waiting for re-join)
  private rooms = new Map<string, Peer | null>();
  // pairCode -> failed join attempts
  private attempts = new Map<string, number>();
  private maxClients: number;

  constructor(opts: { maxClients?: number } = {}) {
    this.maxClients = opts.maxClients ?? 1;
  }

  getPeer(ws: WebSocket): Peer | null {
    return this.byWs.get(ws) ?? null;
  }

  registerHost(peer: Peer): void {
    const prev = this.hosts.get(peer.deviceId);
    if (prev && prev.ws !== peer.ws) {
      this.byWs.delete(prev.ws);
    }
    this.hosts.set(peer.deviceId, peer);
    this.byWs.set(peer.ws, peer);
    // Host reconnected while a client was still waiting — re-pair both sides.
    const client = this.rooms.get(peer.deviceId) ?? null;
    if (client && client.ws.readyState === client.ws.OPEN) {
      this.send(client.ws, {
        v: 1,
        type: "peer-connected",
        peer: { role: "host", deviceId: peer.deviceId, displayName: peer.displayName },
      });
      this.send(peer.ws, {
        v: 1,
        type: "peer-connected",
        peer: { role: "client", deviceId: client.deviceId, displayName: client.displayName },
      });
    }
  }

  /** Host asks for a fresh pairing code. Idempotent: reuses a live code. */
  createPairCode(deviceId: string): { code: string; ttlSec: number } {
    for (const [code, rec] of this.codes) {
      if (rec.deviceId === deviceId && rec.expiresAt > Date.now()) {
        return { code, ttlSec: Math.max(1, Math.round((rec.expiresAt - Date.now()) / 1000)) };
      }
    }
    let code = randomCode();
    while (this.codes.has(code)) code = randomCode();
    this.codes.set(code, { code, deviceId, expiresAt: Date.now() + PAIR_TTL_MS });
    return { code, ttlSec: PAIR_TTL_MS / 1000 };
  }

  /** Client joins the room bound to a pair code. */
  join(pairCode: string, client: Peer):
    | { ok: true; host: Peer }
    | { ok: false; code: "invalid-pair-code" | "pair-code-expired" | "pair-code-in-use" } {
    const rec = this.codes.get(pairCode);
    if (!rec) {
      this.bumpAttempt(pairCode);
      return { ok: false, code: "invalid-pair-code" };
    }
    if (rec.expiresAt <= Date.now()) {
      this.codes.delete(pairCode);
      return { ok: false, code: "pair-code-expired" };
    }
    const host = this.hosts.get(rec.deviceId);
    if (!host) {
      // host 暂未注册（正在重连中），保留码让 client 稍后重试
      return { ok: false, code: "invalid-pair-code" };
    }
    if (this.rooms.get(rec.deviceId) && this.maxClients === 1) {
      return { ok: false, code: "pair-code-in-use" };
    }
    const prevClient = this.rooms.get(rec.deviceId);
    if (prevClient && prevClient.ws !== client.ws && prevClient.ws.readyState === prevClient.ws.OPEN) {
      return { ok: false, code: "pair-code-in-use" };
    }
    // 码保留到 TTL 过期：client 断线重连或 relay 重启恢复时可用同码重连
    this.attempts.delete(pairCode);
    this.rooms.set(rec.deviceId, client);
    this.byWs.set(client.ws, client);
    return { ok: true, host };
  }

  /** Returns the peer socket paired with this ws, if any. */
  peerOf(ws: WebSocket): WebSocket | null {
    const peer = this.byWs.get(ws);
    if (!peer) return null;
    const hostDeviceId = peer.role === "host" ? peer.deviceId : this.hostOfClient(peer);
    if (!hostDeviceId) return null;
    if (peer.role === "client") {
      return this.hosts.get(hostDeviceId)?.ws ?? null;
    }
    return this.rooms.get(hostDeviceId)?.ws ?? null;
  }

  private hostOfClient(client: Peer): string | null {
    for (const [deviceId, c] of this.rooms) {
      if (c === client) return deviceId;
    }
    return null;
  }

  drop(ws: WebSocket, reason: "peer-close" | "timeout"): void {
    const peer = this.byWs.get(ws);
    if (!peer) {
      this.byWs.delete(ws);
      return;
    }
    this.byWs.delete(ws);
    if (peer.role === "host") {
      const client = this.rooms.get(peer.deviceId) ?? null;
      if (this.hosts.get(peer.deviceId) === peer) this.hosts.delete(peer.deviceId);
      if (client && client.ws.readyState === client.ws.OPEN) {
        this.send(client.ws, { v: 1, type: "peer-disconnected", reason });
      }
      // 配对码保留到 TTL 过期：host 短暂断开重连后 client 可用旧码重连
      // （relay 重启恢复、host 网络波动等场景），滥用由 TTL 与锁码兜底。
    } else {
      const hostDeviceId = this.hostOfClient(peer);
      if (hostDeviceId) {
        this.rooms.set(hostDeviceId, null);
        const host = this.hosts.get(hostDeviceId);
        if (host && host.ws.readyState === host.ws.OPEN) {
          this.send(host.ws, { v: 1, type: "peer-disconnected", reason });
        }
      }
    }
  }

  /** True if the pair code is currently under brute-force attack. */
  isCodeLocked(code: string): boolean {
    return (this.attempts.get(code) ?? 0) >= MAX_CODE_ATTEMPTS;
  }

  private bumpAttempt(code: string): void {
    this.attempts.set(code, (this.attempts.get(code) ?? 0) + 1);
    if (this.isCodeLocked(code)) {
      this.codes.delete(code);
    }
  }

  snapshot(): { codes: PairRecord[]; rooms: { deviceId: string; hasClient: boolean }[] } {
    const now = Date.now();
    return {
      codes: [...this.codes.values()]
        .filter((r) => r.expiresAt > now)
        .map((r) => ({ ...r })),
      rooms: [...this.rooms.entries()].map(([deviceId, client]) => ({
        deviceId,
        hasClient: client !== null,
      })),
    };
  }

  restore(snapshot: { codes: PairRecord[]; rooms: { deviceId: string; hasClient: boolean }[] }): void {
    const now = Date.now();
    for (const rec of snapshot.codes) {
      if (rec.expiresAt > now) this.codes.set(rec.code, rec);
    }
    for (const r of snapshot.rooms) {
      if (r.hasClient) {
        // Client connections are gone after a relay restart; the room stays
        // reserved so the host knows a client may return.
        this.rooms.set(r.deviceId, null);
      }
    }
  }

  private send(ws: WebSocket, msg: Record<string, unknown>): void {
    ws.send(JSON.stringify(msg));
  }
}
