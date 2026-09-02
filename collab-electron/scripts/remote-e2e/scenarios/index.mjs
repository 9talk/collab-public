import { spawnLog, readLog, waitForLog, killTree9 } from "../lib/process.mjs";
import { summary } from "../lib/assert.mjs";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  clickNewTile,
  cdpScreenshot,
  cdpTerminalInput,
  cdpWaitInTerminal,
} from "../lib/cdp.mjs";

/** 截图辅助：失败仅 warn，不影响场景结果。 */
async function shot(ctx, tag, port, keyword, name) {
  await new Promise((r) => setTimeout(r, 1200)); // 等 UI 渲染稳定
  try {
    const p = join(ctx.shotDir, name);
    await cdpScreenshot(port, keyword, p, 10_000);
    console.log(`  [shot] ${tag} → ${p}`);
  } catch (err) {
    console.log(`  [warn] 截图失败 ${tag}: ${err.message}`);
  }
}

/**
 * 场景（ctx 由 run.mjs 注入）：
 *   relayLog/aLog/bLog 日志路径, relayRef/aRef/bRef 进程引用,
 *   pairCode, workA (A 的 workspace 目录), logDir, repoRoot
 * 每个场景抛出异常即 FAIL（run.mjs 统一捕获并记 SKIP/FAIL）。
 */

async function s01(ctx) {
  const m = await waitForLog(ctx.relayLog, "listening on", 20_000);
  if (!m) throw new Error("relay 未在 20s 内监听");
}

async function s02(ctx) {
  const m = await waitForLog(ctx.aLog, "pair-code: (\\d{6})", 120_000);
  if (!m) throw new Error("A 未产出配对码");
  ctx.pairCode = m[1];
  console.log(`  [info] 02/pair — pair-code = ${ctx.pairCode}`);
  await shot(ctx, "02/pair", ctx.cdpPortA, "/shell/", "s02-a-shell-pair.png");
  const authOk = await waitForLog(
    ctx.relayLog,
    "authenticated|auth-ok",
    10_000,
  );
  if (!authOk)
    console.log(
      "  [warn] 02/pair — relay 未打印 authenticated（日志格式可能不同）",
    );
}

async function s03(ctx) {
  const connected = await waitForLog(ctx.bLog, "host connected", 120_000);
  if (!connected) throw new Error("B 未连接到 host");
  const sync = await waitForLog(ctx.bLog, "sync complete", 30_000);
  if (!sync) throw new Error("B 初始同步未完成");
  const peer = await waitForLog(ctx.aLog, "peer-connected client", 30_000);
  if (!peer) throw new Error("A 未感知 client 连接");
  await shot(
    ctx,
    "03/client-connected",
    ctx.cdpPortB,
    "/shell/",
    "s03-b-shell.png",
  );
  await shot(
    ctx,
    "03/client-connected",
    ctx.cdpPortB,
    "nav",
    "s03-b-nav-filetree.png",
  );
}

async function s04(ctx) {
  // B 端 shell renderer 启动后应经远程层发起调用（A 端方法表日志）
  const m = await waitForLog(
    ctx.aLog,
    "rpc (workspace:list|pty:discover|canvas:load-state|config:get)",
    60_000,
  );
  if (!m) throw new Error("A 端未收到任何转发 rpc 调用");
  console.log(`  [info] 04/rpc-forward — 首个转发: ${m[0]}`);
  const err = readLog(ctx.bLog).match(/rpc-error/);
  if (err) throw new Error(`B 端出现 rpc-error: ${err[0]}`);
}

async function s05(ctx) {
  const m = await waitForLog(ctx.bLog, "sync complete: canvas=(\\w+)", 30_000);
  if (!m) throw new Error("B 未完成初始同步");
  console.log(`  [info] 05/canvas-mirror — canvas 快照: ${m[1]}`);
  await shot(
    ctx,
    "05/canvas-mirror",
    ctx.cdpPortB,
    "/shell/",
    "s05-b-shell-canvas.png",
  );
}

async function s06(ctx) {
  // B 端（控制端）UI 开终端 → 命令经远程层转发在 A 执行 → 文件系统断言
  const e2ePath = join(ctx.workA, "e2e.txt");
  rmSync(e2ePath, { force: true });
  const markA = statSync(ctx.aLog).size;
  await clickNewTile(ctx.cdpPortB, 30_000);
  console.log("  [info] 06/terminal-pty — B 端已点击新建 tile");
  await cdpWaitInTerminal(
    ctx.cdpPortB,
    `!!document.querySelector(".xterm")`,
    30_000,
  );
  console.log("  [info] 06/terminal-pty — B 端终端渲染就绪");
  await new Promise((r) => setTimeout(r, 2000)); // 等 pty:reconnect 转发到 A 完成
  const m = await waitForLog(
    ctx.aLog,
    "rpc pty:(reconnect|create)",
    20_000,
    markA,
  );
  if (!m) {
    console.log(
      "  [warn] 06/terminal-pty — A 端未见 rpc pty:create/reconnect（文件断言仍将验证）",
    );
  }
  await cdpTerminalInput(
    ctx.cdpPortB,
    `echo REMOTE_E2E_OK > ${e2ePath}`,
    15_000,
  );
  await shot(
    ctx,
    "06/terminal-pty",
    ctx.cdpPortB,
    "terminal-tile",
    "s06-b-terminal.png",
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(e2ePath)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!existsSync(e2ePath)) {
    throw new Error("命令未在 A 执行（e2e.txt 未生成）");
  }
  const content = readFileSync(e2ePath, "utf-8");
  if (!content.includes("REMOTE_E2E_OK")) {
    throw new Error(`e2e.txt 内容不含 REMOTE_E2E_OK: ${content}`);
  }
  console.log(
    `  [info] 06/terminal-pty — ${e2ePath} 含 REMOTE_E2E_OK（命令在 A 执行）`,
  );
}

async function s07(ctx) {
  // 杀 relay → 双方断开 → 重启 → 恢复（锚点断言：只匹配 kill 之后的新日志）
  const markADisc = statSync(ctx.aLog).size;
  const markBDisc = statSync(ctx.bLog).size;
  killTree9(ctx.relayRef);
  const aDisc = await waitForLog(
    ctx.aLog,
    "\\[remote\\] disconnected",
    30_000,
    markADisc,
  );
  if (!aDisc) throw new Error("A 未感知 relay 断开");
  const bDisc = await waitForLog(
    ctx.bLog,
    "\\[remote\\] disconnected",
    30_000,
    markBDisc,
  );
  if (!bDisc) throw new Error("B 未感知 relay 断开");

  const relay = spawnLog(
    "relay",
    "bun",
    [
      "run",
      "collab-relay/src/index.ts",
      "--port",
      "8787",
      "--token",
      "test-device-token",
      "--persist-dir",
      ctx.persistDir,
    ],
    {},
    ctx.repoRoot,
    ctx.logDir,
  );
  ctx.relayRef = relay;

  await waitForLog(ctx.relayLog, "listening on", 20_000);
  const markARe = statSync(ctx.aLog).size;
  const markBRe = statSync(ctx.bLog).size;
  const aRe = await waitForLog(
    ctx.aLog,
    "pair-code: (\\d{6})",
    90_000,
    markARe,
  );
  if (!aRe) throw new Error("A 重连后未生成新配对码");
  const bRe = await waitForLog(ctx.bLog, "host connected", 90_000, markBRe);
  if (!bRe) throw new Error("B 未重连 host");
  const sync2 = await waitForLog(ctx.bLog, "sync complete", 30_000, markBRe);
  if (!sync2) throw new Error("B 重连后未重新同步");
}

async function s08(ctx) {
  // 关闭 B（模拟 B 端退出远程模式）→ A 收到 peer-disconnected
  const mark = statSync(ctx.aLog).size;
  killTree9(ctx.bRef);
  const m = await waitForLog(ctx.aLog, "peer-disconnected", 30_000, mark);
  if (!m) throw new Error("A 未感知 B 断开");
  await shot(
    ctx,
    "08/peer-disconnect",
    ctx.cdpPortA,
    "/shell/",
    "s08-a-shell-after-b-exit.png",
  );
}

export const scenarios = [
  ["01", "relay-ready", s01],
  ["02", "pair", s02],
  ["03", "client-connected", s03],
  ["04", "rpc-forward", s04],
  ["05", "canvas-mirror", s05],
  ["06", "terminal-pty", s06],
  ["07", "reconnect", s07],
  ["08", "peer-disconnect", s08],
];

export { summary };
