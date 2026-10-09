// src/main/sidecar/session-emulator.test.ts
//
// SessionEmulator 的序列化保真测试。必须用 node(非 bun)运行:
// node-pty 无关, 但与 headless xterm 的 .mjs 入口同 client/server 测试一致。
//
// Run: cd collab-electron && npx tsx --test src/main/sidecar/session-emulator.test.ts

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { Terminal } from "@xterm/headless/lib-headless/xterm-headless.mjs";
import { Unicode11Addon } from "@xterm/addon-unicode11/lib/addon-unicode11.mjs";
import { SessionEmulator } from "./session-emulator";

/** 真实消费端(TerminalTab)装载 Unicode11 宽表; 测试中还原此配置 */
function makeConsumer(cols: number, rows: number): Terminal {
  const t = new Terminal({ cols, rows, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = "11";
  return t;
}

function writeAsync(term: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => term.write(data, () => resolve()));
}

function rowText(term: Terminal, y: number): string {
  const line = term.buffer.active.getLine(y);
  return line ? line.translateToString(true) : "";
}

describe("SessionEmulator 宽表与消费端一致 (Unicode 11)", () => {
  it("emoji 空洞定位重放不偏移: 快照重放屏面与直接输出一致", async () => {
    // 😀 之后用 CUP 把 x 放到第 4 列(第 3 列空一格)。emulator 若按
    // Unicode 6 计 😀 为 1 列, SerializeAddon 的「相对光标右移」序列
    // (\x1b[2C)按错误列差编码; 消费端(Unicode 11)重放后 x 落列偏移。
    const em = new SessionEmulator(80, 24);
    em.write(new TextEncoder().encode("😀\x1b[1;4Hx"));
    const snap = await em.serialize();

    const restored = makeConsumer(snap.cols, snap.rows);
    await writeAsync(restored, snap.snapshot);

    const direct = makeConsumer(80, 24);
    await writeAsync(direct, "😀\x1b[1;4Hx");

    assert.equal(
      rowText(restored, 0),
      rowText(direct, 0),
      "快照重放(消费端宽表)的屏面应与直接输出一致",
    );

    restored.dispose();
    direct.dispose();
  });
});
