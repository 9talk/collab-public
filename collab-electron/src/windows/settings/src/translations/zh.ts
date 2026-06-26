import { en } from "./en";

type TranslationKey = keyof typeof en;

export const zh: Record<TranslationKey, string> = {
  // Sidebar
  "settings.title": "设置",

  // Navigation
  "nav.appearance": "外观",
  "nav.memory": "内存",
  "nav.terminal": "终端",
  "nav.integrations": "集成",
  "nav.controls": "控制",
  "nav.updates": "更新",
  "nav.files": "文件",

  // Appearance pane
  "appearance.title": "外观",
  "appearance.description": "自定义 Collaborator 的显示效果。",
  "appearance.theme": "主题",
  "appearance.canvasOpacity": "画布不透明度",
  "appearance.rememberExpandedDirs": "记住展开的文件夹",
  "appearance.rememberExpandedDirsDesc": "重新打开应用时恢复之前的展开状态",

  // Memory pane
  "memory.title": "内存",
  "memory.description": "监控和管理应用内存占用。",
  "memory.mainProcess": "主进程",
  "memory.renderer": "渲染进程",
  "memory.utility": "工具",
  "memory.total": "总计",
  "memory.type": "类型",
  "memory.resident": "常驻",
  "memory.loading": "加载中...",
  "memory.saveMemMode": "省内存模式",
  "memory.saveMemModeDesc":
    "限制活跃的终端 tile webview 数量。非活跃 tile 保留会话但释放渲染进程内存。",
  "memory.maxActiveTiles": "最大活跃 tile 数",
  "memory.destroyDelay": "销毁延迟",
  "memory.seconds3": "3 秒",
  "memory.seconds5": "5 秒",
  "memory.seconds10": "10 秒",
  "memory.seconds15": "15 秒",
  "memory.showDetails": "进程详情",
  "memory.hideDetails": "进程详情",
  "memory.processCount": "进程数",

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

  // Files pane
  "files.title": "文件",
  "files.description": "配置代码文件的外部编辑器。",
  "files.defaultExternalEditor": "使用外部编辑器",
  "files.externalEditor": "默认编辑器",
  "files.recognizedFileTypes": "识别的文件",
  "files.extensionColumn": "扩展名",
  "files.editorColumn": "编辑器",
  "files.addType": "添加",
  "files.delete": "删除",
  "files.reset": "重置",
  "files.ignoredFiles": "忽略的文件和文件夹",
  "files.ignoredFilesDesc": "在 Files 视图中隐藏与此模式匹配的文件和文件夹。",

  // Misc
  esc: "esc",
  close: "关闭",
};
