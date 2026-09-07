// Wire protocol between relay and Collaborator endpoints (host/client).
// Text frames carry JSON control/business messages; binary frames carry
// PTY data (A->B). The relay never inspects business payloads (zero-knowledge).

export const PROTOCOL_VERSION = 1 as const;

export interface AuthFrame {
  v: 1;
  type: "auth";
  role: "host" | "client";
  deviceToken?: string;
  hostId?: string;
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
  code: "invalid-token" | "host-unavailable" | "in-use" | "relay-full" | "malformed";
  message: string;
}

// 握手透传帧:host/client 双向挑战应答,relay 零知识原样转发
export interface PeerAuthRequestFrame {
  v: 1;
  type: "peer-auth-request";
  nonce: string;
}

export interface PeerAuthResponseFrame {
  v: 1;
  type: "peer-auth-response";
  nonce: string;
  clientNonce: string;
  signature: string;
}

export interface PeerAuthAckFrame {
  v: 1;
  type: "peer-auth-ack";
  nonce: string;
  signature: string;
}

export interface PeerAuthErrorFrame {
  v: 1;
  type: "peer-auth-error";
  code: "unauthorized";
  message: string;
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
  | PeerConnectedFrame
  | PeerDisconnectedFrame
  | PeerAuthRequestFrame
  | PeerAuthResponseFrame
  | PeerAuthAckFrame
  | PeerAuthErrorFrame
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
  | EventFrame
  | PeerAuthRequestFrame
  | PeerAuthResponseFrame
  | PeerAuthAckFrame
  | PeerAuthErrorFrame;

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
        hostId: typeof rec.hostId === "string" ? rec.hostId : undefined,
        deviceName:
          typeof rec.deviceName === "string" ? rec.deviceName : undefined,
        appVersion:
          typeof rec.appVersion === "string" ? rec.appVersion : undefined,
      };
    case "peer-auth-request":
      return {
        v: 1,
        type: "peer-auth-request",
        nonce: String(rec.nonce ?? ""),
      };
    case "peer-auth-response":
      return {
        v: 1,
        type: "peer-auth-response",
        nonce: String(rec.nonce ?? ""),
        clientNonce: String(rec.clientNonce ?? ""),
        signature: String(rec.signature ?? ""),
      };
    case "peer-auth-ack":
      return {
        v: 1,
        type: "peer-auth-ack",
        nonce: String(rec.nonce ?? ""),
        signature: String(rec.signature ?? ""),
      };
    case "peer-auth-error":
      return {
        v: 1,
        type: "peer-auth-error",
        code: "unauthorized",
        message: String(rec.message ?? ""),
      };
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
    frame.type === "event" ||
    frame.type === "peer-auth-request" ||
    frame.type === "peer-auth-response" ||
    frame.type === "peer-auth-ack" ||
    frame.type === "peer-auth-error"
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
