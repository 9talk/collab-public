import { en } from "./en";

type TranslationKey = keyof typeof en;

export const zh: Record<TranslationKey, string> = {
  // Sidebar
  "settings.title": "设置",

  // Navigation
  "nav.appearance": "外观",
  "nav.terminal": "终端",
  "nav.integrations": "集成",
  "nav.controls": "控制",
  "nav.updates": "更新",

  // Appearance pane
  "appearance.title": "外观",
  "appearance.description": "自定义 Collaborator 的显示效果。",
  "appearance.theme": "主题",
  "appearance.canvasOpacity": "画布不透明度",
  "appearance.rememberExpandedDirs": "记住展开的文件夹",
  "appearance.rememberExpandedDirsDesc": "重新打开应用时恢复之前的展开状态",

  // Terminal pane
  "terminal.title": "终端",
  "terminal.description": "更改将在新终端中生效。",

  // Terminal pane (Windows)
  "terminal.target": "终端目标",
  "terminal.target.default": "推荐的平台默认值。",
  "terminal.target.available": "可用于新终端。",

  // Integrations pane
  "integrations.title": "集成",
  "integrations.description":
    "安装 Canvas Skill，使 AI 代理能够从终端控制画布。",
  "integrations.install": "安装",
  "integrations.uninstall": "卸载",
  "integrations.detected": "已检测到",
  "integrations.notFound": "未找到",

  // Updates pane
  "updates.title": "更新",
  "updates.description": "管理 Collaborator 如何检查和安装更新。",
  "updates.autoCheck": "自动检查更新",

  // Controls pane
  "controls.shortcuts": "键盘快捷键",
  "controls.mouse": "鼠标控制",

  // Shortcut labels
  "shortcut.settings": "设置",
  "shortcut.find": "查找",
  "shortcut.toggleNavigator": "切换导航器",
  "shortcut.toggleTerminalList": "切换终端列表",
  "shortcut.openWorkspace": "打开工作区",
  "shortcut.zoomIn": "放大",
  "shortcut.zoomOut": "缩小",
  "shortcut.actualSize": "实际大小",
  "shortcut.toggleFullScreen": "切换全屏",
  "shortcut.focusTileLeft": "聚焦左侧面板",
  "shortcut.focusTileRight": "聚焦右侧面板",
  "shortcut.focusTileUp": "聚焦上方面板",
  "shortcut.focusTileDown": "聚焦下方面板",
  "shortcut.dismissNotification": "关闭通知",

  // Mouse control labels
  "mouse.panCanvas": "平移画布",
  "mouse.twoFingerSwipe": "双指滑动",
  "mouse.middleClickDrag": "中键拖拽",
  "mouse.spaceDrag": "Space + 拖拽",
  "mouse.scrollVertically": "垂直滚动画布",
  "mouse.scrollHorizontally": "水平滚动画布",
  "mouse.scroll": "滚动",
  "mouse.zoom": "缩放",

  // Language selector
  "language.label": "语言",
  "language.english": "English",
  "language.chinese": "简体中文",

  // Misc
  "esc": "esc",
  "close": "关闭",
};
