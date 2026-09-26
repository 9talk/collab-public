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