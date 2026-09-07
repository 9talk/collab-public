import type { WebSocket } from "ws";

export interface Peer {
  ws: WebSocket;
  deviceId: string;
  role: "host" | "client";
  displayName?: string;
}

export class Rooms {
  // deviceId -> host peer (one host connection per device)
  private hosts = new Map<string, Peer>();
  // ws -> peer (reverse lookup for drop())
  private byWs = new Map<WebSocket, Peer>();
  // deviceId -> client peer (null = paired in the past, waiting for re-join)
  private rooms = new Map<string, Peer | null>();

  // v2 语义固定单 host 单 client,参数仅保留以兼容既有构造调用
  constructor(_opts: { maxClients?: number } = {}) {}

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
   * Client dials a host by deviceId (from its credential file). The relay only
   * guarantees: host online + host currently has no active client. Signature
   * verification is done by the host itself.
   */
  joinHost(hostId: string, client: Peer):
    | { ok: true; host: Peer }
    | { ok: false; code: "host-unavailable" | "in-use" } {
    const host = this.hosts.get(hostId);
    if (!host) {
      // host 暂未注册(relay 重启或 host 重连中):暂态,client 端自动重试
      return { ok: false, code: "host-unavailable" };
    }
    const existing = this.rooms.get(hostId);
    if (
      existing &&
      existing.ws !== client.ws &&
      existing.ws.readyState === existing.ws.OPEN
    ) {
      return { ok: false, code: "in-use" };
    }
    this.rooms.set(hostId, client);
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

  snapshot(): { rooms: { deviceId: string; hasClient: boolean }[] } {
    return {
      rooms: [...this.rooms.entries()].map(([deviceId, client]) => ({
        deviceId,
        hasClient: client !== null,
      })),
    };
  }

  restore(snapshot: { rooms: { deviceId: string; hasClient: boolean }[] }): void {
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
