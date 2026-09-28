# Collaborator — [CLAUDE.md](https://CLAUDE.md)

Always use Context7 when I need library/API documentation, code generation, setup or configuration steps without me having to explicitly ask.

## Working Directory

This repo root is `/Users/dingxin/collab-public`. All project scripts and code live under subdirectories.

## Directory Structure

```text
collab-public/
├── collab-electron/          # Main Electron application (the desktop app)
│   ├── scripts/              # Build & utility scripts
│   │   └── install-local.sh  # Local dev installer (see below)
│   ├── src/
│   │   ├── main/             # Electron main process code
│   │   ├── preload/          # Electron preload scripts
│   │   ├── windows/          # Renderer windows (settings, shell, nav, etc.)
│   │   │   └── settings/     # Settings window (i18n lives here)
│   ├── packages/             # Shared packages (shared/, components/, theme/)
│   ├── out/                  # Build output (Vite compilation)
│   ├── dist/                 # Packaged artifacts (.app, .zip)
│   └── package.json          # Root package config with electron-builder setup
├── install.sh                # CI installer (downloads from GitHub releases)
├── docs/                     # Plans, specs, design docs (gitignored)
└── .claude/                  # Claude Code settings (gitignored)
```

**Important:** All bun/npm commands must be run from `collab-electron/`, NOT from the repo root. For example:

```bash
cd /Users/dingxin/collab-public/collab-electron
bun run build
bun run package:unsigned
```

## Local Install Script

**File:** `collab-electron/scripts/install-local.sh`

Builds the app from source, packages it, installs to `/Applications/Collaborator.app`, and launches it.
By default it removes the existing app and cleans up `dist/`. Pass `--keep` to preserve both.

```bash
cd /Users/dingxin/collab-public/collab-electron
./scripts/install-local.sh          # default: removes old app + dist
```

This script handles:

* Setting `ELECTRON_MIRROR` to npmmirror.com (China-friendly)

* Running `bun run package:unsigned` (builds + packages, skips code signing)

* Replacing `/Applications/Collaborator.app` with the new build

* Opening the app

Use this for every local rebuild + install. Do NOT manually copy from `dist/` unless the script fails.

## Settings i18n

Translations live in `collab-electron/src/windows/settings/src/translations/`:

* `en.ts` — English dictionary

* `zh.ts` — Simplified Chinese dictionary

* `index.ts` — `useTranslation` hook, `SupportedLocale` type, `TranslationKey` type

The settings UI (`App.tsx`) reads the `locale` preference via `api.getPref("locale")` and passes a `t()` function down to all pane components. Language selector is in the Appearance pane.

## 渲染性能约束

**不要在覆盖 webview 的全屏 overlay 上使用 `backdrop-filter`。** tile 是 `<webview>`（独立进程合成层），全屏模糊需逐帧跨进程捕获背景重算，叠加无限旋转动画（如 loading spinner）后 GPU / WindowServer 直接满载，表现为**整机**卡顿而非仅应用内卡顿。`shell.css` 的 `#remote-overlay`（remote 端「连接已断开」弹窗）已因此移除 `blur(6px)`；`34a09a1` 也曾因同样原因移除 terminal tile 的 blur。改用半透明背景即可，视觉差异极小。

**`clearTextureAtlas()` 代价极高**：它清空**跨 Terminal 实例共享**的字形图集（按 font/theme/dpr 共享，见 `CharAtlasCache`）并触发全屏重绘，反复调用等于让所有终端重新栅格化全部字形（实测单页 version 累计上千次）。常规强制重绘应改用 `term.refresh(0, rows-1)`（VS Code 即如此），`clearTextureAtlas()` 只留给字体/主题/DPR 变化这类真正需要重建字形的时机。

## 终端残影(ghosting)诊断

**现象**：Claude Code 全屏（alt 屏）滚动输出时，输入框上方的分隔线附近残留一行旧像素，持续到下次重绘才消失。

**三种来源，修法完全不同，必须先判别**：

| 来源 | 判别特征 |
| --- | --- |
| **buffer 层** —— Claude Code 自己写错内容（差分渲染器光标列计算；iTerm2 上同样复现，与终端无关） | buffer 文本本身就是错的，任何重绘都无效 |
| **刷新层** —— 刷新请求被吞：webview `_isPaused`，或 DEC 2026 `synchronizedOutput` 把 `refreshRows` 缓冲进 `_syncOutputHandler` | `term.refresh()` 能恢复 |
| **纹理层** —— atlas 陈旧或 page merge 记账 bug | `clearTextureAtlas()` 能恢复 |

**抓现场（免重启；前提：设置 → 开发者 → CDP 端口 > 0，且 app 已带该端口重启）**：

```bash
cd collab-electron
bun scripts/term-ghost-diag.mjs diagnose  # 残影出现时执行：三段式取证，一键定位层级
```

产物写到 `/tmp/term-ghost-<时间戳>/`：`0-before.png`（原始残影）、`1-after-refresh.png`、`2-after-atlas.png` 三张逐步截图，外加 `buffer.txt`（缓冲全文，`行号|内容`）与 `state.json`。**判别**：`1` 已修好 → 刷新层；仅 `2` 修好 → 纹理层；都无效 → buffer 层（对照 `buffer.txt` 确认该行文本本身是否已错）。

想先存档、不动渲染状态时用 `capture`（只截图 + 存缓冲/状态）；单独复现某一步用 `refresh` / `atlas`。

`state.json` 关键字段：`syncOutput`（非空 = 正处 DEC 2026 同步输出缓冲期）、`isPaused`、`atlasPages` / `atlasMaxPages`（达到上限即触发 page merge）、`atlasMergedEver`（true = 本会话已发生页合并，直指上游 bug）。

**已知上游 bug**：`@xterm/addon-webgl@0.19.0`（当前版本）有 atlas page merge 记账缺陷——`_requestClearModel` 置位后永不复位、纹理重绑被 version 比较漏掉（[issue #5847](https://github.com/xtermjs/xterm.js/issues/5847)），修复只进了 `0.20.0-beta.x`。若 `atlasMergedEver` 为 true，升级 beta 线是唯一根治途径。

**Cmd+R 是最彻底的交叉验证**：tile 聚焦时 Cmd+R → `refreshTerminalTile` → webview 收到 `terminal:refresh` → **重建整个 WebglAddon**（全新 GL 上下文资源，强于 `clearTextureAtlas()`，并清空 dataBuffer 重放）。若 Cmd+R 都清不掉残影，基本可排除渲染层。注意有 5s 冷却。

## Key Commands

All run from `collab-electron/`:

| Command                      | Purpose                      |
| ---------------------------- | ---------------------------- |
| `bun run dev`                | Start dev server             |
| `bun run build`              | Build renderer (Vite)        |
| `bun run package:unsigned`   | Build + package (no signing) |
| `bun run test`               | Run test suite               |
| `./scripts/install-local.sh` | Build, install, and launch   |

## Claude Code 源码

需要阅读 Claude Code 源码时，读取地址：

<https://gitee.com/nice9/claude-code>

⠀