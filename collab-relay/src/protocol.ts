// Wire protocol between relay and Collaborator endpoints (host/client).
// Text frames carry JSON control/business messages; binary frames carry
// PTY data (A->B). The relay never inspects business payloads (zero-knowledge).

export const PROTOCOL_VERSION = 1 as const;

export interface AuthFrame {
  v: 1;
  type: "auth";
  role: "host" | "client";
  deviceToken?: string;
  pairCode?: string;
  deviceName?: string;
  appVersion?: string;
}

export interface AuthOkFrame {
  v: 1;
  type: "auth-ok";
  deviceId: string;
  role: "host" | "client";
  displayName?: string;
}

export interface AuthErrorFrame {
  v: 1;
  type: "auth-error";
  code:
    | "invalid-token"
    | "invalid-pair-code"
    | "pair-code-expired"
    | "pair-code-in-use"
    | "relay-full"
    | "malformed";
  message: string;
}

export interface PairCreateFrame {
  v: 1;
  type: "pair-create";
}

export interface PairCreatedFrame {
  v: 1;
  type: "pair-created";
  code: string;
  ttlSec: number;
}

export interface PeerConnectedFrame {
  v: 1;
  type: "peer-connected";
  peer: { role: "host" | "client"; deviceId: string; displayName?: string };
}

export interface PeerDisconnectedFrame {
  v: 1;
  type: "peer-disconnected";
  reason: "peer-close" | "timeout" | "relay-shutdown";
}

export interface RpcFrame {
  v: 1;
  type: "rpc";
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResultFrame {
  v: 1;
  type: "rpc-result";
  id: number;
  result?: unknown;
}

export interface RpcErrorFrame {
  v: 1;
  type: "rpc-error";
  id: number;
  code: number;
  message: string;
}

export interface EventFrame {
  v: 1;
  type: "event";
  channel: string;
  args: unknown[];
}

export type RelayFrame =
  | AuthFrame
  | AuthOkFrame
  | AuthErrorFrame
  | PairCreateFrame
  | PairCreatedFrame
  | PeerConnectedFrame
  | PeerDisconnectedFrame
  | RpcFrame
  | RpcResultFrame
  | RpcErrorFrame
  | EventFrame;

// Frames the relay accepts from an authenticated endpoint and forwards
// verbatim to the peer (zero-knowledge pass-through).
export type PassthroughFrame =
  | RpcFrame
  | RpcResultFrame
  | RpcErrorFrame
  | EventFrame;

export function parseFrame(raw: string): RelayFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (rec.v !== PROTOCOL_VERSION) return null;
  if (typeof rec.type !== "string") return null;
  switch (rec.type) {
    case "auth":
      return {
        v: 1,
        type: "auth",
        role: rec.role === "client" ? "client" : "host",
        deviceToken:
          typeof rec.deviceToken === "string" ? rec.deviceToken : undefined,
        pairCode: typeof rec.pairCode === "string" ? rec.pairCode : undefined,
        deviceName:
          typeof rec.deviceName === "string" ? rec.deviceName : undefined,
        appVersion:
          typeof rec.appVersion === "string" ? rec.appVersion : undefined,
      };
    case "pair-create":
      return { v: 1, type: "pair-create" };
    case "rpc":
      return {
        v: 1,
        type: "rpc",
        id: Number(rec.id),
        method: String(rec.method),
        params: rec.params,
      };
    case "rpc-result":
      return { v: 1, type: "rpc-result", id: Number(rec.id), result: rec.result };
    case "rpc-error":
      return {
        v: 1,
        type: "rpc-error",
        id: Number(rec.id),
        code: Number(rec.code),
        message: String(rec.message),
      };
    case "event":
      return {
        v: 1,
        type: "event",
        channel: String(rec.channel),
        args: Array.isArray(rec.args) ? rec.args : [],
      };
    default:
      return null;
  }
}

export function isPassthroughFrame(frame: RelayFrame): frame is PassthroughFrame {
  return (
    frame.type === "rpc" ||
    frame.type === "rpc-result" ||
    frame.type === "rpc-error" ||
    frame.type === "event"
  );
}

// Binary PTY frame: [1B sessionId length][sessionId UTF-8][payload]
export function encodePtyBinary(sessionId: string, payload: Uint8Array): Buffer {
  const idBuf = Buffer.from(sessionId, "utf8");
  const out = Buffer.alloc(1 + idBuf.length + payload.byteLength);
  out[0] = idBuf.length;
  idBuf.copy(out, 1);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    out,
    1 + idBuf.length,
  );
  return out;
}

export function decodePtyBinary(buf: Buffer): {
  sessionId: string;
  payload: Buffer;
} | null {
  if (buf.length < 1) return null;
  const idLen = buf[0];
  if (buf.length < 1 + idLen) return null;
  const sessionId = buf.subarray(1, 1 + idLen).toString("utf8");
  return { sessionId, payload: buf.subarray(1 + idLen) };
}
