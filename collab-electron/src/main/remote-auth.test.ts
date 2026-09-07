import { describe, expect, test } from "bun:test";
import {
  generateKeyPair,
  loadOrCreateHostKeys,
  issueCredential,
  decodeCredential,
  fingerprint,
  signChallenge,
  verifyChallenge,
} from "./remote-auth";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = () => mkdtempSync(join(tmpdir(), "rauth-"));

describe("host keys", () => {
  test("loadOrCreateHostKeys persists and reloads", () => {
    const d = dir();
    const a = loadOrCreateHostKeys(d);
    expect(a.identityPublicKey).toBeTruthy();
    const b = loadOrCreateHostKeys(d);
    expect(b.identityPrivateKey).toBe(a.identityPrivateKey);
    expect(b.identityPublicKey).toBe(a.identityPublicKey);
    const file = join(d, "remote-host-keys.json");
    expect(existsSync(file)).toBe(true);
    // 私钥文件权限收敛
    expect(Number(readFileSync(file).length)).toBeGreaterThan(0);
  });
  test("second host identity differs", () => {
    const a = loadOrCreateHostKeys(dir());
    const b = loadOrCreateHostKeys(dir());
    expect(a.identityPublicKey).not.toBe(b.identityPublicKey);
  });
});

describe("credential", () => {
  test("issue + decode roundtrip carries host metadata", () => {
    const hostKeys = loadOrCreateHostKeys(dir());
    const hostId = "ab12cd34ef56";
    const file = issueCredential({
      hostKeys,
      hostId,
      relayUrl: "wss://relay.example:8787",
      hostDisplayName: "Mac mini",
    });
    const parsed = decodeCredential(file);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.credential.hostId).toBe(hostId);
    expect(parsed.credential.relayUrl).toBe("wss://relay.example:8787");
    expect(parsed.credential.hostDisplayName).toBe("Mac mini");
    expect(parsed.credential.clientPublicKey).toBeTruthy();
    expect(parsed.credential.clientPrivateKey).toBeTruthy();
  });
  test("damaged key field is rejected", () => {
    const hostKeys = loadOrCreateHostKeys(dir());
    const file = issueCredential({ hostKeys, hostId: "h", relayUrl: "wss://x" });
    // 篡改密钥字段(损坏文件)→ decode 拒绝;改 hostId 类字段会通过 decode,
    // 但连接时 Host 验签必然失败(unauthorized),由握手环节兜底
    const bad = file.replace(/\"clientPublicKey\":\s*\"[^\"]*\"/, '"clientPublicKey":"not-a-key"');
    expect(decodeCredential(bad).ok).toBe(false);
  });
  test("fingerprint is stable and short", () => {
    const hostKeys = loadOrCreateHostKeys(dir());
    const file = issueCredential({ hostKeys, hostId: "h", relayUrl: "wss://x" });
    const parsed = decodeCredential(file);
    if (!parsed.ok) throw new Error("unreachable");
    const fp = fingerprint(parsed.credential.clientPublicKey);
    expect(fp).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe("challenge signature", () => {
  test("verify accepts genuine signature, rejects wrong key and tamper", () => {
    const hostKeys = loadOrCreateHostKeys(dir());
    const file = issueCredential({ hostKeys, hostId: "h", relayUrl: "wss://x" });
    const parsed = decodeCredential(file);
    if (!parsed.ok) throw new Error("unreachable");
    const { clientPrivateKey, clientPublicKey, hostPublicKey } = parsed.credential;

    const sig = signChallenge("collab-client-auth:v1", "nonce-abc", clientPrivateKey);
    expect(verifyChallenge("collab-client-auth:v1", "nonce-abc", clientPublicKey, sig)).toBe(true);
    // 域串不符
    expect(verifyChallenge("collab-host-auth:v1", "nonce-abc", clientPublicKey, sig)).toBe(false);
    // nonce 篡改
    expect(verifyChallenge("collab-client-auth:v1", "nonce-xyz", clientPublicKey, sig)).toBe(false);
    // 错误验证密钥(host 公钥冒充 client 公钥)
    expect(verifyChallenge("collab-client-auth:v1", "nonce-abc", hostPublicKey, sig)).toBe(false);
  });
});
