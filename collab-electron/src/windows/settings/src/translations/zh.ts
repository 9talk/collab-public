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
  "nav.claude": "Claude",
  "nav.remote": "远程",
  "claude.title": "Claude 集成",
  "claude.description":
    "配置与 Claude Code 的深度集成。开启后，终端 tile 将自动恢复 Claude Code 会话。",
  "claude.enable": "开启深度集成",
  "claude.timeout": "会话超时（天）",
  "claude.command": "Claude CLI 命令",
  "claude.marketplaceDesc":
    "若使用 cc-switch 等会接管 settings.json 的工具，自动写入可能被覆盖：",
  "claude.pluginGuide": "参阅手动安装指引 →",
  "claude.copy": "复制",
  "claude.clearOnClear": "调用 /clear 后清屏",
  "claude.clearOnClearDesc":
    "在 Claude Code 中调用 /clear 结束会话后，清空终端 tile 屏幕。默认关闭。",
  "claude.soundEnable": "声音设置",
  "claude.soundEvent.UserPromptSubmit": "用户提交提示",
  "claude.soundEvent.Stop": "Claude 回复完成",
  "claude.soundEvent.Notification": "通知",
  "claude.soundEvent.PermissionRequest": "权限请求",
  "claude.soundEvent.PreCompact": "上下文压缩前",
  "claude.soundEvent.SessionStart": "会话开始",
  "claude.soundEvent.SessionEnd": "会话结束",
  "claude.soundEvent.PreToolUse": "工具调用前",
  "claude.soundEvent.PostToolUseFailure": "工具调用失败",
  "claude.soundEvent.SubagentStart": "子代理启动",
  "claude.soundEvent.SubagentStop": "子代理结束",

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
  "memory.ptyService": "PTY 服务",
  "memory.shell": "Shell",
  "memory.tool": "工具进程",

  // Terminal pane
  "terminal.title": "终端",
  "terminal.description": "更改将在新终端中生效。",
  "terminal.tileSize": "Tile 尺寸",
  "terminal.tileSizeDesc": "新建终端时默认的 tile 尺寸。",
  "terminal.tileWidth": "宽度",
  "terminal.tileHeight": "高度",
  "terminal.scrollback": "回滚行数",
  "terminal.scrollbackDesc":
    "终端滚动缓冲区保留的最大行数（1000-200000），失焦或回车后生效，非法输入会自动还原。",
  "terminal.presets": "预设尺寸",
  "terminal.presets.width": "宽度",
  "terminal.presets.height": "高度",
  "terminal.presets.desc": "描述",
  "terminal.presets.action": "操作",
  "terminal.presets.apply": "使用此预设尺寸",
  "terminal.presets.common": "常见 tile 尺寸。",

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
  "files.openBehaviorDesc":
    "未识别的文件类型(如 *.png、*.pdf)在点击时使用系统默认应用打开;代码文件使用默认编辑器打开。按住 Cmd 点击可随时手动选择打开方式。",
  "files.externalEditor": "默认编辑器",
  "files.recognizedFileTypes": "识别的文件",
  "files.extensionColumn": "扩展名",
  "files.editorColumn": "编辑器",
  "files.addType": "添加",
  "files.delete": "删除",
  "files.reset": "重置",
  "files.ignoredFiles": "忽略的文件和文件夹",
  "files.ignoredFilesDesc":
    "在 Files 视图、搜索和分析中隐藏匹配的文件和文件夹。",
  "files.searchIgnoredFiles": "搜索忽略规则...",
  "files.noIgnoredMatch": "没有匹配的规则",
  "files.ignoreCase": "忽略大小写",
  "files.ignoreCaseDesc":
    '启用时规则不限大小写匹配（如 "Logs" 会隐藏 "logs"）。',

  // Remote pane
  "remote.title": "远程控制",
  "remote.description":
    "让另一台 Collaborator 控制本机，或从此处控制另一台机器。",
  "remote.hostSection": "作为被控端（接受控制）",
  "remote.hostSectionDesc":
    "允许配对设备控制本机。仅在开启并连接后才会向中继发送数据。",
  "remote.enable": "开启远程控制",
  "remote.relayUrl": "中继服务器地址",
  "remote.deviceToken": "设备令牌",
  "remote.deviceTokenPlaceholder": "由中继管理员分配的令牌",
  "remote.pairCode": "配对码",
  "remote.pairRefreshLabel": "自动换新周期（分钟）",
  "remote.refreshNow": "立即刷新",
  "remote.refreshing": "刷新中…",
  "remote.pairValidUntil": "有效至",
  "remote.pairRotatesEvery": "每",
  "remote.minutes": "分钟自动换新",
  "remote.connecting": "连接中…",
  "remote.connected": "已连接",
  "remote.error": "连接失败",
  "remote.errUnreachable": "无法到达中继服务器（主机不可达），请检查地址与网络",
  "remote.errRefused": "中继服务器拒绝连接，请确认服务正在运行且端口已开放",
  "remote.errTimeout": "连接中继服务器超时",
  "remote.errDns": "无法解析中继服务器地址",
  "remote.errReset": "与中继服务器的连接被重置",
  "remote.notConnected": "未连接",
  "remote.host": "主机",
  "remote.peerNone": "暂无设备配对",
  "remote.peer": "已配对设备",
  "remote.clientSection": "作为控制端（控制另一台）",
  "remote.clientSectionDesc":
    "连接中继并输入被控端的配对码，即可像在本地一样控制它。",
  "remote.pairCodeInput": "配对码",
  "remote.connect": "连接",
  "remote.disconnect": "断开",
  "remote.test": "测试",
  "remote.testing": "测试中…",
  "remote.testOk": "连接正常",
  "remote.notConfigured": "缺少中继地址或设备令牌",
  "remote.copy": "复制",
  "remote.roleHost": "被控端（Host）",
  "remote.roleClient": "控制端（Client）",
  "remote.roleOff": "关闭",
  "remote.offViewDesc": "远程控制未启用，数据不会通过中继服务器传输。",
  "remote.hostBlockedByClient": "先断开控制端，才能启用被控端",
  "remote.clientBlockedByHost": "先关闭被控端，才能连接控制端",

  // Connection info (remote standalone flavor)
  "nav.connection": "连接",
  "connection.title": "连接信息",
  "connection.description": "本设备镜像会话的连接详情",
  "connection.relay": "中继地址",
  "connection.host": "主机",
  "connection.status": "状态",
  "connection.status.connected": "已连接",
  "connection.status.connecting": "连接中…",
  "connection.status.idle": "未连接",
  "connection.status.error": "错误",
  "connection.disconnect": "断开连接",
  "connection.none": "—",
  "connection.notAvailable": "本设备当前没有进行中的镜像会话。",

  // Misc
  esc: "esc",
  close: "关闭",
};
