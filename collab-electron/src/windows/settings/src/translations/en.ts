export const en = {
  // Sidebar
  "settings.title": "Settings",

  // Navigation
  "nav.appearance": "Appearance",
  "nav.terminal": "Terminal",
  "nav.integrations": "Integrations",
  "nav.controls": "Controls",

  // Appearance pane
  "appearance.title": "Appearance",
  "appearance.description": "Customize how Collaborator looks.",
  "appearance.theme": "Theme",
  "appearance.canvasOpacity": "Canvas opacity",

  // Terminal pane (macOS)
  "terminal.title": "Terminal",
  "terminal.description": "Changes take effect for new terminals.",
  "terminal.backend": "Terminal backend",
  "terminal.nodePty.label": "node-pty",
  "terminal.nodePty.description": "Clean scrollback rendering.",
  "terminal.tmux.label": "tmux",
  "terminal.tmux.description": "May cause scrollback artifacts.",
  "terminal.tmux.deprecated": "Deprecated — will be removed in a future release.",

  // Terminal pane (Windows)
  "terminal.target": "Terminal target",
  "terminal.target.default": "Recommended default for this platform.",
  "terminal.target.available": "Available for new terminals.",

  // Integrations pane
  "integrations.title": "Integrations",
  "integrations.description":
    "Install the Canvas Skill so AI agents can control the canvas from the terminal.",
  "integrations.install": "Install",
  "integrations.uninstall": "Uninstall",
  "integrations.detected": "Detected",
  "integrations.notFound": "Not found",

  // Controls pane
  "controls.shortcuts": "Keyboard Shortcuts",
  "controls.mouse": "Mouse Controls",

  // Shortcut labels
  "shortcut.settings": "Settings",
  "shortcut.find": "Find",
  "shortcut.toggleNavigator": "Toggle Navigator",
  "shortcut.toggleTerminalList": "Toggle Terminal List",
  "shortcut.openWorkspace": "Open Workspace",
  "shortcut.zoomIn": "Zoom In",
  "shortcut.zoomOut": "Zoom Out",
  "shortcut.actualSize": "Actual Size",
  "shortcut.toggleFullScreen": "Toggle Full Screen",
  "shortcut.focusTileLeft": "Focus Tile Left",
  "shortcut.focusTileRight": "Focus Tile Right",
  "shortcut.focusTileUp": "Focus Tile Up",
  "shortcut.focusTileDown": "Focus Tile Down",

  // Mouse control labels
  "mouse.panCanvas": "Pan Canvas",
  "mouse.twoFingerSwipe": "Two-Finger Swipe",
  "mouse.middleClickDrag": "Middle Click + Drag",
  "mouse.spaceDrag": "Space + Drag",
  "mouse.scrollVertically": "Scroll Canvas Vertically",
  "mouse.scrollHorizontally": "Scroll Canvas Horizontally",
  "mouse.scroll": "Scroll",
  "mouse.zoom": "Zoom",

  // Language selector
  "language.label": "Language",
  "language.english": "English",
  "language.chinese": "简体中文",

  // Misc
  "esc": "esc",
  "close": "Close",
} as const;

export type TranslationKey = keyof typeof en;
