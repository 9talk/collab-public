#!/usr/bin/env node
/**
 * 终端镜像专项验证（同机三进程）：
 *   M1 B 端新建 terminal tile → A 端镜像 tile 出现（同 session 显示）
 *   M2 A 端 canvas-state.json 持久化镜像 tile
 *   M3 B 端关 tile → A 端镜像 tile 级联关闭
 *   M4 A 端关镜像 tile → B 端 tile 级联关闭
 *   M5 kill relay → 重启 → B 端重连从 A 端恢复 tile（A 是 B 的持久化）
 *
 * 用法: bun run scripts/remote-e2e/verify-mirror.mjs
 */

import { spawnLog, killTree9, waitForLog, tailLog } from "./lib/process.mjs";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  cdpEval,
  cdpWaitTarget,
  cdpWaitInTerminal,
  clickNewTile,
  cdpScreenshot,
} from "./lib/cdp.mjs";

const ELECTRON_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = join(ELECTRON_DIR, "..");
const LOG_DIR = "/tmp/collab-remote-mirror-logs";
const WORK_A = "/tmp/collab-remote-a";
const WORK_B = "/tmp/collab-remote-b";
const RELAY_PORT = 8787;
const TOKEN = "test-device-token";
const PERSIST_DIR = join(WORK_A, "relay-data");
const CDP_PORT_A = 9223;
const CDP_PORT_B = 9224;

function collabDir(root) {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return join(homedir(), ".collab", "dev", `worktree-${hash}`);
}

function setupWorkspaceA() {
  const ws = join(WORK_A, "ws");
  mkdirSync(ws, { recursive: true });
  const cfgDir = collabDir(WORK_A);
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, "config.json");
  let workspaces = [];
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, "utf-8"));
    if (Array.isArray(parsed.workspaces)) workspaces = parsed.workspaces;
  } catch {
    // 首次运行
  }
  if (!workspaces.includes(ws)) workspaces.push(ws);
  writeFileSync(cfgPath, JSON.stringify({ workspaces }, null, 2), "utf-8");
}

function freeRelayPort() {
  try {
    const out = execFileSync("lsof", ["-tiTCP:8787", "-sTCP:LISTEN"], {
      encoding: "utf-8",
    });
    for (const pid of out.trim().split(/\s+/)) {
      if (pid) process.kill(Number(pid), "SIGKILL");
    }
  } catch {
    // 端口未被占用
  }
}

function cleanup(extra) {
  for (const p of extra) {
    if (p) killTree9(p);
  }
  freeRelayPort();
  for (const dir of [WORK_A, WORK_B, collabDir(WORK_A), collabDir(WORK_B)]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

async function poll(fn, timeoutMs, desc) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`超时等待: ${desc}${lastErr ? ` (${lastErr.message})` : ""}`);
}

async function shellEval(port, expression) {
  const wsUrl = await cdpWaitTarget(port, "/shell/", 30_000);
  if (!wsUrl) throw new Error(`shell 页面未找到 (port=${port})`);
  return cdpEval(wsUrl, expression);
}

async function tileCount(port) {
  const v = await shellEval(
    port,
    `document.querySelectorAll(".canvas-tile").length`,
  );
  return typeof v === "number" ? v : -1;
}

async function clickCloseTile(port) {
  return shellEval(
    port,
    `(() => {
      const btn = document.querySelector(".canvas-tile .tile-close-btn");
      if (!btn) return "no-tile";
      btn.click();
      return "clicked";
    })()`,
  );
}

let failed = false;
let relayRef = null;
let aRef = null;
let bRef = null;

function log(msg) {
  console.log(`[mirror] ${msg}`);
}

try {
  log("清理环境…");
  cleanup([]);
  mkdirSync(LOG_DIR, { recursive: true });
  setupWorkspaceA();

  log("启动 relay…");
  relayRef = spawnLog(
    "relay",
    "bun",
    [
      "run",
      "collab-relay/src/index.ts",
      "--port",
      String(RELAY_PORT),
      "--token",
      TOKEN,
      "--persist-dir",
      PERSIST_DIR,
    ],
    {},
    REPO_ROOT,
    LOG_DIR,
  );
  await waitForLog(join(LOG_DIR, "relay.log"), "listening on", 20_000);

  log("启动 A (host)…");
  aRef = spawnLog(
    "a",
    "bun",
    ["run", "scripts/dev.mjs"],
    {
      COLLAB_DEV_WORKTREE_ROOT: WORK_A,
      REMOTE_RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}`,
      REMOTE_DEVICE_TOKEN: TOKEN,
      REMOTE_DEBUG_PORT: String(CDP_PORT_A),
    },
    ELECTRON_DIR,
    LOG_DIR,
  );
  await waitForLog(join(LOG_DIR, "a.log"), "pair-code: (\\d{6})", 180_000);
  const pair = tailLog(join(LOG_DIR, "a.log")).match(/pair-code: (\d{6})/)?.[1];
  if (!pair) throw new Error("A 配对码缺失");
  log(`配对码: ${pair}`);

  log("启动 B (client)…");
  bRef = spawnLog(
    "b",
    "bun",
    ["run", "scripts/dev.mjs"],
    {
      COLLAB_DEV_WORKTREE_ROOT: WORK_B,
      REMOTE_RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}`,
      REMOTE_PAIR_CODE: pair,
      REMOTE_DEBUG_PORT: String(CDP_PORT_B),
    },
    ELECTRON_DIR,
    LOG_DIR,
  );
  await waitForLog(join(LOG_DIR, "b.log"), "peer-connected", 180_000);

  // ── M1: B 建 tile → A 镜像 ──
  log("[M1] B 端新建 terminal tile…");
  await clickNewTile(CDP_PORT_B);
  await poll(() => tileCount(CDP_PORT_B), 30_000, "B 端出现 tile");
  await poll(() => tileCount(CDP_PORT_A), 30_000, "A 端出现镜像 tile");
  log("  A 端镜像 tile 已出现");
  // A 端镜像 webview 真正 attach（terminal-tile target + xterm 渲染）
  await poll(
    async () => {
      const wsUrl = await cdpWaitInTerminal(
        CDP_PORT_A,
        `!!document.querySelector(".xterm")`,
        10_000,
      );
      return !!wsUrl;
    },
    30_000,
    "A 端镜像终端 xterm 渲染",
  );
  log("  A 端镜像终端已渲染");
  try {
    await cdpScreenshot(
      CDP_PORT_A,
      "/shell/",
      join(LOG_DIR, "m1-a-mirror.png"),
    );
    await cdpScreenshot(CDP_PORT_B, "/shell/", join(LOG_DIR, "m1-b-tile.png"));
  } catch (err) {
    log(`  截图失败(忽略): ${err.message}`);
  }

  // ── M2: A 端 canvas-state.json 持久化镜像 tile ──
  log("[M2] 检查 A 端 canvas-state.json 持久化…");
  await poll(
    async () => {
      const cfgDir = collabDir(WORK_A);
      const path = join(cfgDir, "canvas-state.json");
      if (!existsSync(path)) return null;
      const state = JSON.parse(readFileSync(path, "utf-8"));
      const terms = (state.tiles ?? []).filter((t) => t.type === "term");
      return terms.length >= 1 && terms[0].ptySessionId ? terms[0] : null;
    },
    15_000,
    "A 端 canvas-state 含带 ptySessionId 的 term tile",
  );
  log("  A 端持久化镜像 tile OK");

  // ── M3: B 关 tile → A 镜像级联关闭 ──
  log("[M3] B 端关闭 tile…");
  const closeRes = await clickCloseTile(CDP_PORT_B);
  if (closeRes !== "clicked")
    throw new Error(`B 端关闭 tile 失败: ${closeRes}`);
  await poll(
    async () => (await tileCount(CDP_PORT_B)) === 0,
    30_000,
    "B 端 tile 消失",
  );
  await poll(
    async () => (await tileCount(CDP_PORT_A)) === 0,
    30_000,
    "A 端镜像 tile 级联关闭",
  );
  log("  B→A 级联关闭 OK");

  // ── M4: A 关镜像 tile → B 级联关闭 ──
  log("[M4] B 端再建 tile → A 镜像 → A 端关闭镜像…");
  await clickNewTile(CDP_PORT_B);
  await poll(() => tileCount(CDP_PORT_B), 30_000, "B 端出现 tile");
  await poll(() => tileCount(CDP_PORT_A), 30_000, "A 端出现镜像 tile");
  const closeA = await clickCloseTile(CDP_PORT_A);
  if (closeA !== "clicked")
    throw new Error(`A 端关闭镜像 tile 失败: ${closeA}`);
  await poll(
    async () => (await tileCount(CDP_PORT_A)) === 0,
    30_000,
    "A 端镜像 tile 消失",
  );
  await poll(
    async () => (await tileCount(CDP_PORT_B)) === 0,
    30_000,
    "B 端 tile 级联关闭",
  );
  log("  A→B 级联关闭 OK");

  // ── M5: kill relay → 重启 → B 重连从 A 恢复 ──
  log("[M5] B 端建 tile（A 镜像），准备断线重连…");
  await clickNewTile(CDP_PORT_B);
  await poll(() => tileCount(CDP_PORT_B), 30_000, "B 端出现 tile");
  await poll(() => tileCount(CDP_PORT_A), 30_000, "A 端出现镜像 tile");

  log("  kill relay…");
  if (relayRef) {
    killTree9(relayRef);
    relayRef = null;
  }
  freeRelayPort();
  await waitForLog(join(LOG_DIR, "a.log"), "disconnected", 30_000);
  await waitForLog(join(LOG_DIR, "b.log"), "disconnected", 30_000);
  log("  A/B 均已断线");

  log("  重启 relay…");
  relayRef = spawnLog(
    "relay",
    "bun",
    [
      "run",
      "collab-relay/src/index.ts",
      "--port",
      String(RELAY_PORT),
      "--token",
      TOKEN,
      "--persist-dir",
      PERSIST_DIR,
    ],
    {},
    REPO_ROOT,
    LOG_DIR,
  );
  await waitForLog(join(LOG_DIR, "relay.log"), "listening on", 20_000);

  log("  等待 A 重连并重新生成配对码…");
  await waitForLog(join(LOG_DIR, "a.log"), "pair-code: (\\d{6})", 60_000);
  log("  等待 B 重连…");
  await waitForLog(join(LOG_DIR, "b.log"), "peer-connected", 60_000);
  log("  等待 B 端 tiles 从 A 端恢复…");
  await poll(() => tileCount(CDP_PORT_B), 60_000, "B 端恢复 tile");
  log("  B 端 tile 已恢复，点击聚焦触发 webview 重建…");
  const focusRes = await shellEval(
    CDP_PORT_B,
    `(() => {
      const bar = document.querySelector(".canvas-tile .tile-title-bar");
      if (!bar) return "no-bar";
      bar.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      bar.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      return "ok";
    })()`,
  );
  if (focusRes !== "ok") throw new Error(`B 端 tile 聚焦失败: ${focusRes}`);
  await poll(
    async () => {
      const wsUrl = await cdpWaitInTerminal(
        CDP_PORT_B,
        `!!document.querySelector(".xterm")`,
        10_000,
      );
      return !!wsUrl;
    },
    30_000,
    "B 端恢复的终端 xterm 渲染",
  );
  log("  B 端重连恢复 OK");
  try {
    await cdpScreenshot(
      CDP_PORT_B,
      "/shell/",
      join(LOG_DIR, "m5-b-restored.png"),
    );
    await cdpScreenshot(
      CDP_PORT_A,
      "/shell/",
      join(LOG_DIR, "m5-a-mirror.png"),
    );
  } catch (err) {
    log(`  截图失败(忽略): ${err.message}`);
  }

  log("\n[mirror] 全部镜像验证 PASS");
} catch (err) {
  failed = true;
  console.error(`[mirror] 验证失败: ${err.message}`);
} finally {
  log("清理进程…");
  cleanup([relayRef, aRef, bRef]);
  log(`日志目录: ${LOG_DIR}`);
}

process.exit(failed ? 1 : 0);
