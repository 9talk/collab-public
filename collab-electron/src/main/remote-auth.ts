import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  randomBytes,
  sign as signBuffer,
  verify as verifyBuffer,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const HOST_KEYS_FILE = "remote-host-keys.json";
export const CREDENTIAL_FILE = "remote-credential.json";
const CLIENT_AUTH_DOMAIN = "collab-client-auth:v1";
const HOST_AUTH_DOMAIN = "collab-host-auth:v1";

export interface HostKeys {
  identityPrivateKey: string; // base64 PKCS8 ed25519
  identityPublicKey: string; // base64 SPKI ed25519
  clientPublicKey: string | null; // 当前授权 client 公钥(严格单份)
  issuedAt: number | null;
}

export interface Credential {
  format: "collab-credential";
  version: 1;
  relayUrl: string;
  hostId: string;
  hostDisplayName?: string;
  hostPublicKey: string;
  clientPublicKey: string;
  clientPrivateKey: string;
  issuedAt: number;
}

function toPrivatePem(key: string): string {
  return `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----`;
}
function toPublicPem(key: string): string {
  return `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----`;
}
function stripBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
}

export function generateKeyPair(): {
  privateKey: string;
  publicKey: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: stripBase64(
      privateKey.export({ type: "pkcs8", format: "pem" }),
    ),
    publicKey: stripBase64(publicKey.export({ type: "spki", format: "pem" })),
  };
}

export function loadOrCreateHostKeys(stateDir: string): HostKeys {
  const file = join(stateDir, HOST_KEYS_FILE);
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as HostKeys;
      if (raw.identityPrivateKey && raw.identityPublicKey) return raw;
    } catch {
      // 损坏则重新生成
    }
  }
  const kp = generateKeyPair();
  const keys: HostKeys = {
    identityPrivateKey: kp.privateKey,
    identityPublicKey: kp.publicKey,
    clientPublicKey: null,
    issuedAt: null,
  };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

export function saveHostKeys(stateDir: string, keys: HostKeys): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, HOST_KEYS_FILE), JSON.stringify(keys, null, 2), {
    mode: 0o600,
  });
}

export function fingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 10);
}

export function issueCredential(opts: {
  hostKeys: HostKeys;
  hostId: string;
  relayUrl: string;
  hostDisplayName?: string;
}): string {
  const kp = generateKeyPair(); // 授权密钥对:私钥进凭证文件,公钥留 Host
  opts.hostKeys.clientPublicKey = kp.publicKey;
  opts.hostKeys.issuedAt = Date.now();
  const cred: Credential = {
    format: "collab-credential",
    version: 1,
    relayUrl: opts.relayUrl,
    hostId: opts.hostId,
    ...(opts.hostDisplayName ? { hostDisplayName: opts.hostDisplayName } : {}),
    hostPublicKey: opts.hostKeys.identityPublicKey,
    clientPublicKey: kp.publicKey,
    clientPrivateKey: kp.privateKey,
    issuedAt: Date.now(),
  };
  return JSON.stringify(cred, null, 2);
}

export function decodeCredential(
  raw: string,
): { ok: true; credential: Credential } | { ok: false; reason: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  const rec = obj as Record<string, unknown>;
  if (rec?.format !== "collab-credential" || rec?.version !== 1) {
    return { ok: false, reason: "bad-format" };
  }
  for (const k of [
    "relayUrl",
    "hostId",
    "hostPublicKey",
    "clientPublicKey",
    "clientPrivateKey",
  ] as const) {
    if (typeof rec[k] !== "string" || (rec[k] as string).length === 0) {
      return { ok: false, reason: `missing-${k}` };
    }
  }
  // 私钥/公钥必须是合法 ed25519,尽早暴露损坏文件
  try {
    createPrivateKey(toPrivatePem(rec.clientPrivateKey as string));
    createPublicKey(toPublicPem(rec.clientPublicKey as string));
    createPublicKey(toPublicPem(rec.hostPublicKey as string));
  } catch {
    return { ok: false, reason: "bad-key" };
  }
  return { ok: true, credential: rec as unknown as Credential };
}

function messageBuffer(domain: string, nonce: string): Buffer {
  return Buffer.from(`${domain}\n${nonce}`, "utf8");
}

export function signChallenge(
  domain: "collab-client-auth:v1" | "collab-host-auth:v1",
  nonce: string,
  privateKeyBase64: string,
): string {
  // ed25519 是纯 EdDSA:digest 参数必须为 null(传入算法名会抛 Invalid digest)
  return signBuffer(
    null,
    messageBuffer(domain, nonce),
    createPrivateKey(toPrivatePem(privateKeyBase64)),
  ).toString("base64");
}

export function verifyChallenge(
  domain: "collab-client-auth:v1" | "collab-host-auth:v1",
  nonce: string,
  publicKeyBase64: string,
  signatureBase64: string,
): boolean {
  try {
    return verifyBuffer(
      null,
      messageBuffer(domain, nonce),
      createPublicKey(toPublicPem(publicKeyBase64)),
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

export function newNonce(): string {
  return randomBytes(32).toString("hex");
}

export { CLIENT_AUTH_DOMAIN, HOST_AUTH_DOMAIN };
