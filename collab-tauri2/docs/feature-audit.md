# Feature Audit: Electron vs Tauri

**Date:** 2026-05-19
**Baseline:** collab-electron at commit `fd631ba`

| Feature | Electron Implementation | Tauri Implementation | Status | Notes |
|---------|------------------------|---------------------|--------|-------|
| PTY terminal | node-pty | portable-pty | ✅ | Session create/write/resize/kill/discover implemented |
| Config persistence | JSON file | JSON file | ✅ | serde-based, with window state, theme, locale, prefs |
| File operations | fs/promises | std::fs | ✅ | read_file, write_file, list_dir, get_home_dir, exists |
| File watching | @parcel/watcher | notify | ✅ | watch_start command, emits file:changed events |
| Analytics | posthog-js + node | reqwest HTTP | ✅ | analytics_track async command |
| Auto update | electron-updater | tauri-plugin-updater | ⚠️ | Module exists but not wired into tauri.conf.json yet (needs signing key) |
| App menu | Electron Menu API | Tauri Menu | ✅ | File, Edit, View, Window menus with shortcuts |
| Keyboard shortcuts | before-input-event | Menu accelerators | ⚠️ | Basic shortcuts via menu accelerators; global shortcut not fully mapped |
| Theme switching | nativeTheme.themeSource | CSS + app state | ⚠️ | UI toggle exists but native theme not wired |
| Window state save | BrowserWindow bounds | WebviewWindow bounds | ✅ | Config stores/restores x, y, width, height |
| Custom protocol | collab-file:// | Not implemented | ❌ | Not implemented |
| Browser tile | webview tag + session | Not implemented | ❌ | Not implemented |
| Agent chat | ACP SDK | Not implemented | ❌ | Not implemented |
| Image processing | sharp | image crate | ⚠️ | Dependency added but no commands implemented |
| CLI installer | script | Not implemented | ❌ | Not implemented |
| JSON-RPC server | custom server | Tauri commands | ✅ | Tauri invoke/emit replaces JSON-RPC |
| Crash reporting | uncaughtException handler | Not implemented | ❌ | Not implemented |
| Zoom control | webContents.setZoomLevel | Not implemented | ❌ | Not implemented |
| Settings i18n | en.ts/zh.ts | Same pattern | ✅ | en/zh dictionaries with useTranslation hook |
| Multi-tile layout | <webview> tags | React tile management | ⚠️ | React-side tile management works; Tauri Webview embedding not yet implemented |
| Terminal auto-placement | canvas state | Not implemented | ❌ | Not implemented |
| Workspace graph | workspace-graph.ts | Not implemented | ❌ | Not implemented |
| Wikilink index | wikilink-index.ts | Not implemented | ❌ | Not implemented |
| Git replay | git-replay | Not implemented | ❌ | Not implemented |
| Import service | import-service.ts | Not implemented | ❌ | Not implemented |
| CDP (Chrome DevTools Protocol) | cdp.ts | Not implemented | ❌ | Not implemented |
| Colorize URLs | colorize-urls.ts | Not implemented | ❌ | Not implemented |

## Summary

- ✅ Implemented: 12 features (core terminal, config, file ops, watcher, analytics, menu, settings, i18n)
- ⚠️ Partial: 6 features (updater, shortcuts, theme, tile layout, image, browser tile)
- ❌ Not started: 14 features (protocol, agent, CLI, crash, zoom, workspace graph, git replay, etc.)

## Next Steps

Priority order for remaining features:
1. Tauri Webview embedding for tiles (replaces Electron <webview>)
2. Auto updater (tauri-plugin-updater config)
3. Global shortcut mapping
4. Theme/native adaptation
5. Browser tile
6. Agent chat (ACP)
7. Custom protocol (collab-file://)
8. Workspace graph, git replay, and other domain features
