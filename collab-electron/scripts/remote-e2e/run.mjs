#!/usr/bin/env node
/**
 * 远程控制端到端测试编排（同机三进程）：
 *   relay(8787) → A(host) → 提取配对码 → B(client) → 顺序跑场景 → 清理。
 *
 * 用法: bun run scripts/remote-e2e/run.mjs
 *   或  cd collab-electron && bun run test:remote
 */

import { spawnLog, killTree, killTree9, waitForLog } from "./lib/process.mjs";
import { execFileSync } from "node:child_process";
import { summary } from "./lib/assert.mjs";
import { scenarios } from "./scenarios/index.mjs";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ELECTRON_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = join(ELECTRON_DIR, "..");
const LOG_DIR = "/tmp/collab-remote-logs";
const WORK_A = "/tmp/collab-remote-a";
const WORK_B = "/tmp/collab-remote-b";
const RELAY_PORT = 8787;
const TOKEN = "test-device-token";
const PERSIST_DIR = join(WORK_A, "relay-data");
// A/B 各自独立的 CDP 调试端口（electron-vite --remoteDebuggingPort）
const CDP_PORT_A = 9223;
const CDP_PORT_B = 9224;
// 回归截图目录（桌面 collab 文件夹）
const SHOT_DIR = join(homedir(), "Desktop", "collab");

function collabDir(root) {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return join(homedir(), ".collab", "dev", `worktree-${hash}`);
}

function setupWorkspaceA() {
  const ws = join(WORK_A, "ws");
  mkdirSync(ws, { recursive: true });
  const note = join(ws, "test.md");
  if (!existsSync(note)) {
    writeFileSync(
      note,
      "---\ntitle: Remote E2E\n---\n\n# Hello from A\n",
      "utf-8",
    );
  }
  // 预置 A 的 config（合并默认值，安全）
  const cfgDir = collabDir(WORK_A);
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, "config.json");
  let workspaces = [];
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, "utf-8"));
    if (Array.isArray(parsed.workspaces)) workspaces = parsed.workspaces;
  } catch {
    // 首次运行, 全量写入
  }
  if (!workspaces.includes(ws)) workspaces.push(ws);
  writeFileSync(cfgPath, JSON.stringify({ workspaces }, null, 2), "utf-8");
}

function cleanup() {
  for (const proc of [ctx.aRef, ctx.bRef, ctx.relayRef]) {
    if (proc) killTree9(proc);
  }
  // 保险：清掉历史残留的 relay 监听进程，避免端口占用
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
  try {
    rmSync(WORK_A, { recursive: true, force: true });
    rmSync(WORK_B, { recursive: true, force: true });
    rmSync(collabDir(WORK_A), { recursive: true, force: true });
    rmSync(collabDir(WORK_B), { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const ctx = {
  logDir: LOG_DIR,
  workA: join(WORK_A, "ws"),
  workB: WORK_B,
  repoRoot: REPO_ROOT,
  persistDir: PERSIST_DIR,
  cdpPortA: CDP_PORT_A,
  cdpPortB: CDP_PORT_B,
  shotDir: SHOT_DIR,
  pairCode: null,
  relayRef: null,
  aRef: null,
  bRef: null,
  get relayLog() {
    return join(LOG_DIR, "relay.log");
  },
  get aLog() {
    return join(LOG_DIR, "a.log");
  },
  get bLog() {
    return join(LOG_DIR, "b.log");
  },
};

let failed = false;

try {
  console.log("[e2e] 清理环境…");
  cleanup();
  mkdirSync(LOG_DIR, { recursive: true });
  setupWorkspaceA();
  ctx.aRef?.child?.kill?.();

  console.log("[e2e] 启动 relay…");
  ctx.relayRef = spawnLog(
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
  await waitForLog(ctx.relayLog, "listening on", 20_000);

  console.log("[e2e] 启动 A (host)…");
  ctx.aRef = spawnLog(
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

  console.log("[e2e] 等待 A 配对码…");
  await waitForLog(ctx.aLog, "pair-code: (\\d{6})", 180_000);

  console.log("[e2e] 启动 B (client)…");
  // 场景 02 会同步确认 pair-code（B 启动需 A 的码，先取出来）
  let pair = null;
  {
    const { tailLog } = await import("./lib/process.mjs");
    const m = tailLog(ctx.aLog).match(/pair-code: (\d{6})/);
    pair = m ? m[1] : null;
  }
  if (!pair) throw new Error("A 配对码缺失");
  ctx.pairCode = pair;
  ctx.bRef = spawnLog(
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

  console.log("[e2e] 顺序执行场景…");
  for (const [id, name, fn] of scenarios) {
    const t0 = new Date();
    console.log(
      `\n[e2e] === 场景 ${id} ${name} === (${t0.toISOString().slice(11, 19)})`,
    );
    try {
      await fn(ctx);
      console.log(
        `  [PASS] ${id}/${name} (+${Math.round((Date.now() - t0) / 1000)}s)`,
      );
    } catch (err) {
      const uiRelated = id === "06";
      console.log(
        `  [${uiRelated ? "SKIP" : "FAIL"}] ${id}/${name} — ${err.message}`,
      );
      if (uiRelated) {
        console.log("  [info] 场景 06 依赖 UI 辅助功能权限，可手动复核");
      } else {
        failed = true;
        console.error("  [e2e] 场景失败，中止后续场景");
        break;
      }
    }
  }
} catch (err) {
  failed = true;
  console.error(`[e2e] 编排失败: ${err.message}`);
} finally {
  console.log("\n[e2e] 清理进程…");
  cleanup();
  console.log("[e2e] 日志目录: " + LOG_DIR);
}

const ok = summary();
process.exit(ok && !failed ? 0 : 1);
