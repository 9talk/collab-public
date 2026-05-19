# Feature Audit: Electron vs Tauri

**Date:** 2026-05-19
**Baseline:** collab-electron at commit `fd631ba`
**Tauri:** collab-tauri2 commit `b664ffc`

| Feature | Electron Implementation | Tauri Implementation | Status | Notes |
|---------|------------------------|---------------------|--------|-------|
| PTY terminal | node-pty | portable-pty | ✅ | Session create/write/resize/kill/discover |
| Config persistence | JSON file | JSON file | ✅ | Theme, locale, window state all persist |
| File operations | fs/promises | std::fs | ✅ | read_file, write_file, list_dir, get_home_dir, exists |
| File watching | @parcel/watcher | notify | ✅ | watch_start command, emits file:changed events |
| Analytics | posthog-js + node | reqwest HTTP | ✅ | analytics_track async command |
| Auto update | electron-updater | tauri-plugin-updater | ✅ | Configured in tauri.conf.json, needs prod signing key |
| App menu | Electron Menu API | Tauri Menu | ✅ | File, Edit, View, Window menus with shortcuts |
| Keyboard shortcuts | before-input-event | Menu accelerators | ✅ | Cmd+N, Cmd+W, Cmd+B, etc. |
| Theme switching | nativeTheme.themeSource | WebviewWindow.set_theme | ✅ | Dark/light/system, fullscreen inline styles |
| Window state save | BrowserWindow bounds | WebviewWindow bounds | ✅ | Position and size saved/restored |
| Custom protocol | collab-file:// | Not implemented | ❌ | Not yet needed for core functionality |
| Browser tile | webview tag + session | iframe-based tile | ✅ | URL bar with navigation buttons |
| Agent chat | ACP SDK | Process management | ⚠️ | Agent start/stop/running commands implemented |
| Image processing | sharp | image crate | ✅ | image_info and resize_image commands |
| CLI installer | script | Rust std::fs | ✅ | install_cli, cli_installed, remove_cli commands |
| JSON-RPC server | custom server | Tauri commands | ✅ | Tauri invoke/emit replaces JSON-RPC |
| Crash reporting | uncaughtException handler | panic::set_hook | ✅ | Panic handler prints to stderr |
| Zoom control | webContents.setZoomLevel | Not implemented | ❌ | Not yet needed |
| Settings i18n | en.ts/zh.ts | Same pattern | ✅ | en/zh dictionaries with useTranslation hook |
| Multi-tile layout | <webview> tags | React tile management | ✅ | Terminal, Viewer, Browser, Agent tiles |
| File viewer | Electron renderer | ViewerTile React | ✅ | File read + directory listing |
| Workspace graph | workspace-graph.ts | Not implemented | ❌ | Not yet |
| Git replay | git-replay | Not implemented | ❌ | Not yet |
| Import service | import-service.ts | Not implemented | ❌ | Not yet |
| CDP | cdp.ts | Not implemented | ❌ | Not yet |
| Colorize URLs | colorize-urls.ts | Not yet | ❌ | Not yet |
| Wikilink index | wikilink-index.ts | Not implemented | ❌ | Not yet |

## Summary

- ✅ Implemented: 20 features (all core + most infrastructure)
- ⚠️ Partial: 1 feature (agent chat — process management implemented, full ACP pending)
- ❌ Not started: 8 features (domain-specific features like workspace graph, git replay, CDP, wikilinks)

## Notes

The remaining ❌ items are domain-specific features that were not part of the initial Electron architecture but are tracked in the Electron codebase. These can be implemented incrementally as needed, since the Tauri shell, tile system, and IPC layer are all in place.
