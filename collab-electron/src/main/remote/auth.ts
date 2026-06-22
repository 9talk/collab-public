// src/main/remote/auth.ts
import * as crypto from "node:crypto";

const TOKEN_BYTES = 32;
const SALT_BYTES = 16;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = "sha512";

export function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST,
  );
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(
  password: string,
  stored: string,
): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const hash = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEYLEN,
    PBKDF2_DIGEST,
  );
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}

export function verifyToken(token: string, expected: string): boolean {
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(expected),
  );
}

export function getLocalIP(): string {
  const { networkInterfaces } = require("node:os");
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}
