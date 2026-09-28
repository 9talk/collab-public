#!/usr/bin/env bun
/**
 * 终端残影(ghosting)现场抓取 —— 通过 CDP 连到运行中的 Collaborator,
 * 在 terminal-tile webview 里反查 xterm Terminal 实例并抓取现场证据。
 *
 * 前置:设置 → 开发者 → CDP 端口 > 0,且 app 已重启(该端口是 Chromium
 * 启动开关,运行时不可动态开启)。
 *
 * 用法(在 collab-electron/ 下执行):
 *   bun scripts/term-ghost-diag.mjs capture   # 一键抓现场:渲染状态 + 缓冲全文 + 截图
 *   bun scripts/term-ghost-diag.mjs diagnose  # 三段式取证:before/refresh 后/atlas 后各一图
 *   bun scripts/term-ghost-diag.mjs refresh   # term.refresh(0, rows-1) 强制重绘
 *   bun scripts/term-ghost-diag.mjs atlas     # term.clearTextureAtlas() 清字形图集
 *   bun scripts/term-ghost-diag.mjs state     # 仅打印渲染状态
 *
 * 端口默认 9333,可用 --port=N 覆盖;产物默认写到 /tmp/term-ghost-<时间戳>/。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { cdpTarget, cdpEval, cdpScreenshot } from "./remote-e2e/lib/cdp.mjs";

// xterm 不把 Terminal 实例暴露到 DOM 或全局,只能沿 React fiber 树反查:
// 找到 .xterm 元素上挂的 fiber → 回溯到根 → 遍历 hooks 链,取出
// `termRef.current`(TerminalTab.tsx 里的 useRef<Terminal>)。
const FIND_TERM = `
function __findTerm() {
  let node = document.querySelector('.xterm');
  let fiber = null;
  while (node && !fiber) {
    for (const k of Object.getOwnPropertyNames(node)) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$')) { fiber = node[k]; break; }
    }
    node = node.parentElement;
  }
  if (!fiber) return null;
  let root = fiber;
  while (root.return) root = root.return;
  const seen = new Set();
  let count = 0;
  let result = null;
  const isTerm = (v) => v && typeof v === 'object' && v._core && typeof v.cols === 'number';
  function walk(f) {
    if (!f || seen.has(f) || count > 60000 || result) return;
    seen.add(f);
    count++;
    let s = f.memoizedState;
    let i = 0;
    while (s && i < 40) {
      const v = s.memoizedState;
      if (isTerm(v)) { result = v; return; }
      if (v && typeof v === 'object' && 'current' in v && isTerm(v.current)) { result = v.current; return; }
      s = s.next;
      i++;
    }
    walk(f.child);
    walk(f.sibling);
  }
  walk(root);
  return result;
}
`;

const STATE_EXPR = `(() => { ${FIND_TERM}
  const term = __findTerm();
  if (!term) return JSON.stringify({ err: 'term not found' });
  const core = term._core;
  const canvas = document.querySelector('.xterm canvas');
  const atlas = core?._renderService?._renderer?.value?._charAtlas;
  return JSON.stringify({
    cols: term.cols,
    rows: term.rows,
    bufferType: term.buffer.active.type,
    viewportY: term.buffer.active.viewportY,
    baseY: term.buffer.active.baseY,
    syncOutput: core?._coreService?.decPrivateModes?.synchronizedOutput ?? null,
    rendererType: core?._renderService?._renderer?.value?.constructor?.name ?? null,
    isPaused: core?._renderService?._isPaused ?? null,
    canvasSize: canvas ? canvas.width + 'x' + canvas.height : null,
    canvasCssSize: canvas ? canvas.clientWidth + 'x' + canvas.clientHeight : null,
    atlasPages: atlas ? atlas.pages.length : null,
    atlasMaxPages: atlas ? (atlas.constructor.maxAtlasPages ?? null) : null,
    atlasMergedEver: atlas ? atlas._requestClearModel : null,
    atlasPageVersions: atlas ? atlas.pages.map(p => p.version) : null
  });
})()`;

const DUMP_EXPR = `(() => { ${FIND_TERM}
  const term = __findTerm();
  if (!term) return JSON.stringify({ err: 'term not found' });
  const buf = term.buffer.active;
  const out = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    out.push(y + '|' + (line ? line.translateToString(true) : ''));
  }
  return JSON.stringify({ bufferType: buf.type, viewportY: buf.viewportY, baseY: buf.baseY, rows: term.rows, lines: out });
})()`;

const REFRESH_EXPR = `(() => { ${FIND_TERM}
  const term = __findTerm();
  if (!term) return JSON.stringify({ err: 'term not found' });
  term.refresh(0, term.rows - 1);
  return JSON.stringify({ ok: true, action: 'refresh(0, ' + (term.rows - 1) + ')' });
})()`;

const ATLAS_EXPR = `(() => { ${FIND_TERM}
  const term = __findTerm();
  if (!term) return JSON.stringify({ err: 'term not found' });
  term.clearTextureAtlas();
  return JSON.stringify({ ok: true, action: 'clearTextureAtlas()' });
})()`;

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--")) ?? "capture";
const portArg = args.find((a) => a.startsWith("--port="));
const port = portArg ? Number(portArg.split("=")[1]) : 9333;

let wsUrl;
try {
  wsUrl = cdpTarget(port, "Terminal Tile");
} catch {
  wsUrl = null;
}
if (!wsUrl) {
  console.error(
    `CDP 未找到 Terminal Tile (port=${port})。\n` +
      `请确认:设置 → 开发者 → CDP 端口 > 0,且 app 已重启(端口是 Chromium 启动开关,运行时不可动态开启)。\n` +
      `端口非 9333 时用 --port=N 指定。`,
  );
  process.exit(1);
}

async function evalExpr(expr) {
  const raw = await cdpEval(wsUrl, expr);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

if (cmd === "state") {
  console.log(JSON.stringify(await evalExpr(STATE_EXPR), null, 2));
} else if (cmd === "refresh") {
  console.log(JSON.stringify(await evalExpr(REFRESH_EXPR)));
} else if (cmd === "atlas") {
  console.log(JSON.stringify(await evalExpr(ATLAS_EXPR)));
} else if (cmd === "capture") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = `/tmp/term-ghost-${stamp}`;
  mkdirSync(dir, { recursive: true });

  const state = await evalExpr(STATE_EXPR);
  const dump = await evalExpr(DUMP_EXPR);
  let shot = null;
  try {
    shot = `${dir}/shot.png`;
    await cdpScreenshot(port, "Terminal Tile", shot);
  } catch (e) {
    shot = `截图失败: ${e.message}`;
  }

  writeFileSync(`${dir}/state.json`, JSON.stringify(state, null, 2));
  writeFileSync(`${dir}/buffer.txt`, (dump.lines ?? []).join("\n"));
  console.log(`已抓取现场 → ${dir}`);
  console.log(`  state.json   渲染/缓冲状态`);
  console.log(`  buffer.txt   缓冲全文(行号|内容,可为空行)`);
  console.log(`  shot.png     当前画面`);
  console.log();
  console.log("state:", JSON.stringify(state));
  console.log();
  console.log(
    `bufferType=${dump.bufferType} viewportY=${dump.viewportY} baseY=${dump.baseY} rows=${dump.rows}`,
  );
  console.log("缓冲末尾 12 行:");
  console.log((dump.lines ?? []).slice(-12).join("\n"));
} else if (cmd === "diagnose") {
  // 三段式取证: 存档现场 → refresh 后 → clearTextureAtlas 后, 各截一图。
  // 比对三张图即可定层: 1 修好 = model/dirty 层; 仅 2 修好 = 纹理层;
  // 都无效 = buffer 层(应用侧写入问题, 与渲染无关)。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = `/tmp/term-ghost-${stamp}`;
  mkdirSync(dir, { recursive: true });
  const settle = () => new Promise((r) => setTimeout(r, 500));

  const state = await evalExpr(STATE_EXPR);
  const dump = await evalExpr(DUMP_EXPR);
  writeFileSync(`${dir}/state.json`, JSON.stringify(state, null, 2));
  writeFileSync(`${dir}/buffer.txt`, (dump.lines ?? []).join("\n"));
  await cdpScreenshot(port, "Terminal Tile", `${dir}/0-before.png`);

  await evalExpr(REFRESH_EXPR);
  await settle();
  await cdpScreenshot(port, "Terminal Tile", `${dir}/1-after-refresh.png`);

  await evalExpr(ATLAS_EXPR);
  await settle();
  await cdpScreenshot(port, "Terminal Tile", `${dir}/2-after-atlas.png`);

  console.log(`三段式取证 → ${dir}`);
  console.log(`  0-before.png        残影原始画面`);
  console.log(`  1-after-refresh.png refresh(0, rows-1) 之后`);
  console.log(`  2-after-atlas.png   clearTextureAtlas() 之后`);
  console.log(`  buffer.txt          缓冲全文(判 buffer 层)`);
  console.log(`  state.json          渲染状态`);
  console.log();
  console.log(
    "判别: 1 已修好 → model 层; 仅 2 修好 → 纹理层; 都无效 → buffer 层",
  );
  console.log("state:", JSON.stringify(state));
} else {
  console.error(
    `未知命令: ${cmd}(可用: capture | diagnose | state | refresh | atlas)`,
  );
  process.exit(1);
}
