import {
  spawnLog,
  readLog,
  tailLog,
  waitForLog,
  killTree9,
} from "../lib/process.mjs";
import { summary } from "../lib/assert.mjs";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  clickNewTile,
  cdpScreenshot,
  cdpTerminalInput,
  cdpWaitInTerminal,
  cdpTileRect,
  cdpUnlockTile,
  cdpDragTileBy,
  cdpClickTile,
  cdpKeyEvent,
  cdpEvalShell,
  cdpWaitTarget,
  cdpResizeWindow,
  cdpEval,
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

/** 读 A（host）端的 canvas 存档；不存在/解析失败返回 null。 */
function readAState(ctx) {
  try {
    return JSON.parse(readFileSync(ctx.aStateFile, "utf-8"));
  } catch {
    return null;
  }
}

/** 轮询 A 端 canvas 存档直到 predicate(st) 为真。 */
async function waitAState(ctx, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = readAState(ctx);
    if (st && predicate(st)) return st;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/**
 * 场景（ctx 由 run.mjs 注入）：
 *   relayLog/aLog/bLog 日志路径, relayRef/aRef/bRef 进程引用,
 *   pairCode, workA (A 的 workspace 目录), logDir, repoRoot,
 *   aStateFile (A 端 canvas-state.json)
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
  // M6: 首码 TTL 跟随 remote.pairRefreshMinutes（默认 10 分钟 → expiresIn=600s）
  const pairLine = readLog(ctx.aLog).match(/pair-code: \d{6} expiresIn=(\d+)s/);
  if (pairLine) {
    console.log(`  [info] 02/pair — relay 应答 TTL = ${pairLine[1]}s`);
    if (pairLine[1] !== "600") {
      console.log(`  [warn] 02/pair — TTL 非默认 600s（若未改 pref 则异常）`);
    }
  }
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
  // M3: A 端应同步出现镜像 tile（remote:pty-opened）——截图留档
  await shot(
    ctx,
    "06/terminal-pty",
    ctx.cdpPortB,
    "terminal-tile",
    "s06-b-terminal.png",
  );
  await shot(
    ctx,
    "06/mirror-on-a",
    ctx.cdpPortA,
    "/shell/",
    "s06-a-mirror-tile.png",
  );
  await cdpTerminalInput(
    ctx.cdpPortB,
    `echo REMOTE_E2E_OK > ${e2ePath}`,
    15_000,
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

async function s10(ctx) {
  // M5: Client(B) 真实拖拽镜像 tile → Host(A) 画布存档同步变化
  const bRect0 = await cdpTileRect(ctx.cdpPortB, 0);
  const state0 = await waitAState(
    ctx,
    (st) => Array.isArray(st.tiles) && st.tiles.length >= 1,
  );
  if (!state0) throw new Error("B 新建终端后 A 端 canvas 存档无 tile");
  const t0 = state0.tiles[0];
  console.log(
    `  [info] 10/geometry-b2a — B tile rect ${JSON.stringify(bRect0)}; A state tile0 x=${t0.x} y=${t0.y} w=${t0.width} h=${t0.height}; fitZoom≈${(bRect0.width / t0.width).toFixed(4)}`,
  );
  const markA = statSync(ctx.aLog).size;
  await cdpUnlockTile(ctx.cdpPortB, 0);
  await cdpDragTileBy(ctx.cdpPortB, 160, 100, 0);
  const moved = await waitAState(
    ctx,
    (st) => st.tiles[0].x !== t0.x || st.tiles[0].y !== t0.y,
    15_000,
  );
  if (!moved) throw new Error(`B 拖拽后 A 存档未变化 (was ${t0.x},${t0.y})`);
  const dx = moved.tiles[0].x - t0.x;
  const dy = moved.tiles[0].y - t0.y;
  const zoom = bRect0.width / t0.width;
  const snap20 = (v) => Math.round(v / 20) * 20;
  const expX = snap20(t0.x + 160 / zoom) - t0.x;
  const expY = snap20(t0.y + 100 / zoom) - t0.y;
  console.log(
    `  [info] 10/geometry-b2a — tile 位移 (+${dx},+${dy}) (was ${t0.x},${t0.y} → ${moved.tiles[0].x},${moved.tiles[0].y}); 期望按 zoom=${zoom.toFixed(4)} 换算+snap (+${expX},+${expY})`,
  );
  if (dx !== expX || dy !== expY) {
    throw new Error(
      `期望位移 (+${expX},+${expY}) [zoom=${zoom.toFixed(4)}]，实际 (+${dx},+${dy}) [t0=${t0.x},${t0.y} bRect0=${JSON.stringify(bRect0)}]`,
    );
  }
  const rpc = await waitForLog(
    ctx.aLog,
    "rpc canvas:update-tile-geometry",
    5_000,
    markA,
  );
  if (!rpc) throw new Error("A 端未见 rpc canvas:update-tile-geometry");
  await shot(
    ctx,
    "10/geometry-b2a",
    ctx.cdpPortA,
    "/shell/",
    "s10-a-after-b-drag.png",
  );
}

async function s11(ctx) {
  // M5: Host(A) 真实拖拽 tile → Client(B) 镜像几何随动
  const b0 = await cdpTileRect(ctx.cdpPortB, 0);
  const aStatePre = await waitAState(ctx, () => true, 5_000);
  const aTilePre = aStatePre?.tiles?.[0];
  const aRectPre = await cdpTileRect(ctx.cdpPortA, 0);
  const aCtx = await cdpEvalShell(
    ctx.cdpPortA,
    `(() => {
      const t = document.querySelectorAll(".canvas-tile")[0];
      const bar = t?.querySelector(".tile-title-bar");
      const r = bar?.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const cx = r ? Math.min(Math.max(r.left + r.width / 2, r.left + 8), Math.min(r.right - 8, vw - 8)) : null;
      const cy = r ? Math.min(Math.max(r.top + r.height / 2, r.top + 8), Math.min(r.bottom - 8, vh - 8)) : null;
      const elAt = cx ? document.elementFromPoint(cx, cy) : null;
      window.__mouseTrace = [];
      const rec = (e) => window.__mouseTrace.push([e.type, e.clientX, e.clientY]);
      for (const ev of ["mousedown", "mousemove", "mouseup"]) {
        window.addEventListener(ev, rec, true);
      }
      return {
        vw,
        vh,
        barRect: r && { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        hitPt: cx != null ? { x: Math.round(cx), y: Math.round(cy) } : null,
        hitEl: elAt ? (elAt.className || elAt.id || elAt.tagName) : null,
        lockBtn: !!t?.querySelector(".tile-lock-btn"),
        tileStyle: t ? { left: t.style.left, top: t.style.top, transform: t.style.transform } : null,
      };
    })()`,
  );
  console.log(`  [info] 11/geometry-a2b — A 端调查 ${JSON.stringify(aCtx)}`);
  console.log(
    `  [info] 11/geometry-a2b — A state tile0 x=${aTilePre?.x} y=${aTilePre?.y} w=${aTilePre?.width} h=${aTilePre?.height}; A DOM rect ${JSON.stringify(aRectPre)}; B rect ${JSON.stringify(b0)}`,
  );
  await cdpUnlockTile(ctx.cdpPortA, 0);
  await cdpDragTileBy(ctx.cdpPortA, -120, 80, 0);
  // A 本地拖拽不落盘（既有行为），权威断言在 B 端镜像 rect
  const aStatePost = await waitAState(ctx, () => true, 2_000);
  console.log(
    `  [info] 11/geometry-a2b — A 拖拽后 tile0 ${aStatePost?.tiles?.[0]?.x ?? "?"},${aStatePost?.tiles?.[0]?.y ?? "?"}`,
  );
  const b1 = await cdpTileRect(ctx.cdpPortB, 0, 15_000);
  const dLeft = b1.left - b0.left;
  const dTop = b1.top - b0.top;
  const zoom = b1.width / 1200; // tile canvas 宽 1200 → 屏幕宽 = × zoom
  const expLeft = Math.round(-120 * zoom);
  const expTop = Math.round(80 * zoom);
  console.log(
    `  [info] 11/geometry-a2b — B 端镜像位移 (${dLeft},${dTop}) (was ${b0.left},${b0.top} → ${b1.left},${b1.top}); zoom≈${zoom.toFixed(4)} 期望 ≈(${expLeft},${expTop})`,
  );
  // A 端拖拽 -120/+80 (canvas 坐标, A zoom=1) → B 镜像屏幕位移 ×zoom, 容差 6px
  if (Math.abs(dLeft - expLeft) > 6 || Math.abs(dTop - expTop) > 6) {
    throw new Error(
      `B 端镜像位移异常: dLeft=${dLeft} dTop=${dTop} (期望≈${expLeft},${expTop} zoom=${zoom.toFixed(4)})`,
    );
  }
  const bRect = await cdpTileRect(ctx.cdpPortB, 0);
  if (Math.abs(bRect.left - b1.left) > 4 || Math.abs(bRect.top - b1.top) > 4) {
    console.log("  [warn] 11/geometry-a2b — B 端镜像位移未稳定");
  }
  await shot(
    ctx,
    "11/geometry-a2b",
    ctx.cdpPortB,
    "/shell/",
    "s11-b-after-a-drag.png",
  );
}

async function s12(ctx) {
  // M4: Client 窗口缩小时适配视图自动重算（等比缩小，内容完整）
  const readDims = `(() => {
    const el = document.getElementById("panel-viewer");
    return { cw: el?.clientWidth || 0, ch: el?.clientHeight || 0 };
  })()`;
  const b0 = await cdpTileRect(ctx.cdpPortB, 0);
  const d0 = await cdpEvalShell(ctx.cdpPortB, readDims);
  const aw = await cdpEvalShell(
    ctx.cdpPortA,
    `({ w: window.innerWidth, h: window.innerHeight })`,
  );
  const hostW = aw.w;
  const hostH = aw.h;
  const z0 = Math.min(d0.cw / hostW, d0.ch / hostH) || 0;
  if (!z0) throw new Error("B 端画布尺寸读取失败");
  console.log(
    `  [info] 12/fit-resize — B 画布 ${d0.cw}x${d0.ch}, host ${hostW}x${hostH}, zoom0=${z0.toFixed(4)}`,
  );
  await cdpResizeWindow(
    ctx.cdpPortB,
    Math.round(hostW * 0.6),
    Math.round(hostH * 0.7),
  );
  await new Promise((r) => setTimeout(r, 1500)); // 200ms 防抖 + 重算
  const b1 = await cdpTileRect(ctx.cdpPortB, 0);
  const d1 = await cdpEvalShell(ctx.cdpPortB, readDims);
  const z1 = Math.min(d1.cw / hostW, d1.ch / hostH) || 0;
  const wRatio = b1.width / b0.width;
  const expectW = z0 ? z1 / z0 : 0;
  console.log(
    `  [info] 12/fit-resize — B 画布 ${d1.cw}x${d1.ch}, zoom1=${z1.toFixed(4)}; tile 宽度比 ${wRatio.toFixed(3)} (期望 ≈${expectW.toFixed(3)})`,
  );
  if (Math.abs(wRatio - expectW) > 0.06) {
    throw new Error(
      `适配视图未生效: tile 宽度比 ${wRatio} ≠ ~${expectW.toFixed(3)}`,
    );
  }
  await shot(
    ctx,
    "12/fit-resize",
    ctx.cdpPortB,
    "/shell/",
    "s12-b-fitted-60pct.png",
  );
}

async function s14(ctx) {
  // M8: Client(B) 聚焦 tile(点击/Cmd+方向键均汇合 focusCanvasTile)→
  // Host(A) 镜像跟随聚焦。主断言走用户原始操作 cmd+方向键;点击路径兜底。
  let count = await cdpEvalShell(
    ctx.cdpPortB,
    `document.querySelectorAll(".canvas-tile").length`,
  );
  if (count < 2) {
    await clickNewTile(ctx.cdpPortB, 30_000);
    // 等新 tile 终端在两端都渲染完成
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const b = await cdpEvalShell(
        ctx.cdpPortB,
        `document.querySelectorAll(".canvas-tile")[1]?.querySelector("webview") ? 1 : 0`,
      );
      const a = await cdpEvalShell(
        ctx.cdpPortA,
        `document.querySelectorAll(".canvas-tile").length`,
      );
      if (b === 1 && (a ?? 0) >= 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  count = await cdpEvalShell(
    ctx.cdpPortB,
    `document.querySelectorAll(".canvas-tile").length`,
  );
  if (count < 2) throw new Error("B 端未建立至少 2 个 tile");
  console.log("  [info] 14/focus-b2a — 双 tile 就绪");
  const markA0 = statSync(ctx.aLog).size;

  const readBFocused = () =>
    cdpEvalShell(
      ctx.cdpPortB,
      `(() => {
        const els = [...document.querySelectorAll(".canvas-tile")];
        return els.findIndex((el) => el.classList.contains("tile-focused"));
      })()`,
    );
  async function waitAFocus(expect, label) {
    const deadline = Date.now() + 15_000;
    let focused = null;
    while (Date.now() < deadline) {
      focused = await cdpEvalShell(
        ctx.cdpPortA,
        `(() => {
          const els = [...document.querySelectorAll(".canvas-tile")];
          const i = els.findIndex((el) => el.classList.contains("tile-focused"));
          return i;
        })()`,
      );
      if (focused === expect) return;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(
      `B ${label}聚焦 tile#${expect} 后 A 端未跟随(当前 A focused=${focused})`,
    );
  }
  async function clickAndExpectFocus(bIndex) {
    await cdpClickTile(ctx.cdpPortB, bIndex);
    await waitAFocus(bIndex, "点击");
  }

  // 1) 点击路径:聚焦 tile#1(起始聚焦若非 1 则切换)
  if ((await readBFocused()) !== 1) await clickAndExpectFocus(1);
  // 2) 键盘路径:cmd+ArrowLeft → 聚焦 tile#0,A 端应跟随
  const bBefore = await readBFocused();
  await cdpKeyEvent(ctx.cdpPortB, {
    key: "ArrowLeft",
    code: "ArrowLeft",
    keyCode: 37,
    meta: true,
  });
  const bAfter = await readBFocused();
  console.log(
    `  [info] 14/focus-b2a — 键盘 cmd+ArrowLeft 后 B 聚焦 ${bBefore}→${bAfter}`,
  );
  if (bAfter !== bBefore) {
    await waitAFocus(bAfter, "键盘");
    console.log(`  [info] 14/focus-b2a — A 端聚焦随键盘切换到 tile#${bAfter}`);
  } else {
    console.log(
      "  [warn] 14/focus-b2a — CDP 键盘未驱动 B 端聚焦(快捷键路径需人工复核),回退点击路径",
    );
    await clickAndExpectFocus(0);
    await clickAndExpectFocus(1);
  }
  const rpcCount = [
    ...newLogs(ctx.aLog, markA0).matchAll(/rpc canvas:focus-tile/g),
  ].length;
  if (rpcCount < 2) {
    throw new Error(`A 端 rpc canvas:focus-tile 次数 ${rpcCount} < 2`);
  }
  console.log(
    `  [info] 14/focus-b2a — A 端 rpc canvas:focus-tile ×${rpcCount}`,
  );
  await shot(
    ctx,
    "14/focus-b2a",
    ctx.cdpPortA,
    "/shell/",
    "s14-a-focused-tile.png",
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
  console.log("  [info] 07/reconnect — A/B 均自动恢复连接并重新同步");
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

/** 锚点后的新增日志（字节偏移 → tailLog，避免 UTF-8 字符/字节错位）。 */
function newLogs(logPath, fromBytes) {
  return tailLog(logPath, 16 * 1024 * 1024, fromBytes);
}

async function s09(ctx) {
  // M6: 配对码自动轮询。B 已断开（s08），A 置周期 1 分钟并热生效 →
  // 下一 tick 应 force 换新码（无活跃 client 分支）
  const oldCode = ctx.pairCode;
  const markA = statSync(ctx.aLog).size;
  const markRelay = statSync(ctx.relayLog).size;
  const ok = await cdpEvalShell(
    ctx.cdpPortA,
    `window.shellApi
      .setPref("remote.pairRefreshMinutes", 1)
      .then(() => window.shellApi.hostApplyPairRefresh())
      .then(() => true)
      .catch((e) => "ERR:" + (e && e.message ? e.message : e))`,
  );
  if (ok !== true) throw new Error(`A 端设置轮询周期失败: ${ok}`);
  console.log("  [info] 09/pair-rotation — 周期已热生效为 1 分钟，等待 tick…");
  const deadline = Date.now() + 100_000;
  let newCode = null;
  while (Date.now() < deadline) {
    const m = newLogs(ctx.aLog, markA).match(/pair-code: (\d{6})/);
    if (m) {
      newCode = m[1];
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!newCode) throw new Error("轮询 tick 未产出新配对码（100s 超时）");
  if (newCode === oldCode) {
    throw new Error(`tick 换码未生效，仍为旧码 ${oldCode}`);
  }
  console.log(`  [info] 09/pair-rotation — 换新码 ${oldCode} → ${newCode}`);
  const forceLog = newLogs(ctx.relayLog, markRelay).match(
    /pair-created code=(\d{6}) .* force/,
  );
  if (!forceLog) throw new Error("relay 未收到 force 换码请求");
  if (forceLog[1] !== newCode) {
    throw new Error(`relay 新码 ${forceLog[1]} 与 A 显示 ${newCode} 不一致`);
  }
  const ttl = newLogs(ctx.aLog, markA).match(
    /pair-code: \d{6} expiresIn=(\d+)s/,
  );
  if (ttl && ttl[1] !== "60") {
    throw new Error(`换新码 TTL 未跟随周期: expiresIn=${ttl[1]}s ≠ 60s`);
  }
  console.log("  [info] 09/pair-rotation — force 换码 + TTL=60s 验证通过");
}

async function s13(ctx) {
  // M6: 设置界面 —— 配对码卡片 + 周期输入 + 立即刷新（端到端 UI 验证）
  const cur = [
    ...String(newLogs(ctx.aLog, 0)).matchAll(/pair-code: (\d{6})/g),
  ].at(-1)?.[1];
  if (!cur) throw new Error("A 日志无当前配对码");
  await cdpEvalShell(ctx.cdpPortA, "window.shellApi.openSettings(); true");
  const wsUrl = await cdpWaitTarget(ctx.cdpPortA, "/settings/", 15_000);
  if (!wsUrl) throw new Error("A 设置窗口未打开");
  const deadline = Date.now() + 15_000;
  let ui = null;
  while (Date.now() < deadline) {
    // 切到「远程」pane
    await cdpEval(
      wsUrl,
      `(() => {
        const nav = [...document.querySelectorAll("button")].find(
          (b) => /^远程$|^Remote$/.test(b.textContent.trim()),
        );
        if (nav) nav.click();
      })()`,
    );
    ui = await cdpEval(
      wsUrl,
      `(() => {
        const codeEl = document.querySelector(".font-mono.tracking-widest");
        const numInputs = [...document.querySelectorAll("input[type=number]")];
        const refreshBtn = [...document.querySelectorAll("button")].find((b) =>
          /refresh now|立即刷新/i.test(b.textContent),
        );
        return {
          code: codeEl?.textContent?.trim() || null,
          numInputs: numInputs.map((i) => ({ v: i.value, min: i.min, max: i.max })),
          refreshBtn: !!refreshBtn,
          refreshDisabled: refreshBtn ? refreshBtn.disabled : null,
          bodyHasExpiry: /有效至|Valid until/.test(document.body.textContent),
        };
      })()`,
    );
    if (ui?.code) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ui?.code) throw new Error("设置界面未显示配对码");
  console.log(
    `  [info] 13/settings-ui — UI 配对码=${ui.code} (日志=${cur}); 数字输入=${JSON.stringify(ui.numInputs)}; 刷新按钮=${ui.refreshBtn}(disabled=${ui.refreshDisabled}); 期限显示=${ui.bodyHasExpiry}`,
  );
  if (ui.code !== cur) {
    throw new Error(`UI 配对码 ${ui.code} ≠ 日志当前码 ${cur}`);
  }
  const num = ui.numInputs?.[0];
  if (!num || num.min !== "1" || num.max !== "1440") {
    throw new Error(`周期数字输入缺失或范围异常: ${JSON.stringify(num)}`);
  }
  if (!ui.refreshBtn || ui.refreshDisabled) {
    throw new Error("立即刷新按钮缺失或禁用");
  }
  if (!ui.bodyHasExpiry) throw new Error("配对码有效期行未显示");
  // 立即刷新 → 新码 + relay force 日志
  const markA = statSync(ctx.aLog).size;
  const markRelay = statSync(ctx.relayLog).size;
  await cdpEval(
    wsUrl,
    `(() => { const b = [...document.querySelectorAll("button")].find((b) => /refresh now|立即刷新/i.test(b.textContent)); b?.click(); return !!b; })()`,
  );
  let newCode = null;
  const dl = Date.now() + 15_000;
  while (Date.now() < dl) {
    const m = newLogs(ctx.aLog, markA).match(/pair-code: (\d{6})/);
    if (m) {
      newCode = m[1];
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!newCode) throw new Error("立即刷新后 A 未产出新配对码");
  if (newCode === cur) throw new Error(`立即刷新后码未变化: ${newCode}`);
  const forceLog = newLogs(ctx.relayLog, markRelay).match(
    /pair-created code=(\d{6}) .* force/,
  );
  if (!forceLog || forceLog[1] !== newCode) {
    throw new Error(
      `relay 未见 force 新码 ${newCode}: ${forceLog?.[1] ?? "无"}`,
    );
  }
  ctx.pairCode = newCode;
  console.log(
    `  [info] 13/settings-ui — 立即刷新换码 ${cur} → ${newCode} (relay force 确认)`,
  );
  await shot(
    ctx,
    "13/settings-ui",
    ctx.cdpPortA,
    "/settings/",
    "s13-settings-pair.png",
  );
}

export const scenarios = [
  ["01", "relay-ready", s01],
  ["02", "pair", s02],
  ["03", "client-connected", s03],
  ["04", "rpc-forward", s04],
  ["05", "canvas-mirror", s05],
  ["06", "terminal-pty", s06],
  ["10", "geometry-b2a", s10],
  ["11", "geometry-a2b", s11],
  ["12", "fit-resize", s12],
  ["14", "focus-b2a", s14],
  ["07", "reconnect", s07],
  ["08", "peer-disconnect", s08],
  ["09", "pair-rotation", s09],
  ["13", "settings-ui", s13],
];

export { summary };
