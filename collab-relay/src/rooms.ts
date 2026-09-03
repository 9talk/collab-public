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

const DEFAULT_TTL_MINUTES = 10;
const TTL_MIN_MINUTES = 1;
const TTL_MAX_MINUTES = 1440;
const MAX_CODE_ATTEMPTS = 5;

export interface CreatePairOptions {
  /** 作废该 deviceId 现存活码并换新；缺省幂等复用活码（兼容旧 Host） */
  force?: boolean;
  /** 新码有效分钟数，clamp 1~1440；缺省 10 分钟 */
  ttlMinutes?: number;
}

function clampTtlMinutes(minutes?: number): number {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return DEFAULT_TTL_MINUTES;
  return Math.min(TTL_MAX_MINUTES, Math.max(TTL_MIN_MINUTES, Math.round(n)));
}

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

  /**
   * Host asks for a fresh pairing code.
   * - 缺省幂等：复用该 deviceId 的活码（兼容旧 Host 的既有行为）
   * - force: true → 作废现存活码换新码（Host 轮询换新 / 立即刷新）
   * - ttlMinutes 决定新码 TTL（clamp 1~1440，缺省 10 分钟）
   */
  createPairCode(
    deviceId: string,
    opts: CreatePairOptions = {},
  ): { code: string; ttlSec: number } {
    const ttlMinutes = clampTtlMinutes(opts.ttlMinutes);
    let live: PairRecord | null = null;
    for (const rec of this.codes.values()) {
      if (rec.deviceId === deviceId && rec.expiresAt > Date.now()) {
        live = rec;
        break;
      }
    }
    if (live && !opts.force) {
      return {
        code: live.code,
        ttlSec: Math.max(1, Math.round((live.expiresAt - Date.now()) / 1000)),
      };
    }
    if (live && opts.force) {
      // 作废旧码：客户端若在途会用旧码连不上，重连需新码（Host 已推送新码）
      this.codes.delete(live.code);
    }
    let code = randomCode();
    while (this.codes.has(code)) code = randomCode();
    const expiresAt = Date.now() + ttlMinutes * 60_000;
    this.codes.set(code, { code, deviceId, expiresAt });
    return { code, ttlSec: ttlMinutes * 60 };
  }

  /** Client joins the room bound to a pair code. */
  join(pairCode: string, client: Peer):
    | { ok: true; host: Peer }
    | {
        ok: false;
        code:
          | "invalid-pair-code"
          | "pair-code-expired"
          | "pair-code-in-use"
          | "host-unavailable";
      } {
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
      // host 暂未注册（relay 重启或 host 自身重连中）：码保留，
      // client 端应将此视为暂态并自动重试，而不是当无效码放弃
      return { ok: false, code: "host-unavailable" };
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
