export const en = {
  // Sidebar
  "settings.title": "Settings",

  // Navigation
  "nav.appearance": "Appearance",
  "nav.memory": "Memory",
  "nav.terminal": "Terminal",
  "nav.integrations": "Integrations",
  "nav.controls": "Controls",
  "nav.updates": "Updates",
  "nav.files": "Files",

  // Appearance pane
  "appearance.title": "Appearance",
  "appearance.description": "Customize how Collaborator looks.",
  "appearance.theme": "Theme",
  "appearance.canvasOpacity": "Canvas opacity",
  "appearance.rememberExpandedDirs": "Remember expanded folders",
  "appearance.rememberExpandedDirsDesc":
    "Restore folder expansion state when reopening the app",

  // Memory pane
  "memory.title": "Memory",
  "memory.description": "Monitor and manage application memory usage.",
  "memory.mainProcess": "Main",
  "memory.renderer": "Renderer",
  "memory.utility": "Utility",
  "memory.total": "Total",
  "memory.type": "Type",
  "memory.resident": "Resident",
  "memory.loading": "Loading...",
  "memory.saveMemMode": "Save Memory Mode",
  "memory.saveMemModeDesc":
    "Limit active terminal tile webviews. Inactive tiles keep their sessions but release renderer memory.",
  "memory.maxActiveTiles": "Max active tiles",
  "memory.destroyDelay": "Destroy delay",
  "memory.seconds3": "3 seconds",
  "memory.seconds5": "5 seconds",
  "memory.seconds10": "10 seconds",
  "memory.seconds15": "15 seconds",

  // Terminal pane
  "terminal.title": "Terminal",
  "terminal.description": "Changes take effect for new terminals.",

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
  "shortcut.dismissNotification": "Dismiss Notification",

  // Mouse control labels
  "mouse.panCanvas": "Pan Canvas",
  "mouse.twoFingerSwipe": "Two-Finger Swipe",
  "mouse.middleClickDrag": "Middle Click + Drag",
  "mouse.spaceDrag": "Space + Drag",
  "mouse.scrollVertically": "Scroll Canvas Vertically",
  "mouse.scrollHorizontally": "Scroll Canvas Horizontally",
  "mouse.scroll": "Scroll",
  "mouse.zoom": "Zoom",

  // Updates pane
  "updates.title": "Updates",
  "updates.description":
    "Manage how Collaborator checks for and installs updates.",
  "updates.autoCheck": "Check for updates automatically",

  // Language selector
  "language.label": "Language",
  "language.english": "English",
  "language.chinese": "简体中文",

  // Files pane
  "files.title": "Files",
  "files.description": "Configure external editor for code files.",
  "files.defaultExternalEditor": "Use external editor",
  "files.externalEditor": "Default editor",
  "files.recognizedFileTypes": "Recognized Files",
  "files.extensionColumn": "Extension",
  "files.editorColumn": "Editor",
  "files.addType": "Add",
  "files.delete": "Delete",
  "files.reset": "Reset",
  "files.ignoredFiles": "Ignored Files and Folders",
  "files.ignoredFilesDesc":
    "Patterns matching files and folders to hide from the Files view.",

  // Misc
  esc: "esc",
  close: "Close",
} as const;

export type TranslationKey = keyof typeof en;
