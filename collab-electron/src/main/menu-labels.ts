export type MenuLocale = "en" | "zh";

export interface MenuLabels {
  about: string;
  settings: string;
  services: string;
  hide: string;
  hideOthers: string;
  unhide: string;
  quit: string;
  disconnectRemote: string;
  file: string;
  newTile: string;
  closeTile: string;
  openWorkspace: string;
  edit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  find: string;
  view: string;
  toggleFiles: string;
  zoomIn: string;
  zoomOut: string;
  actualSize: string;
  navigateBack: string;
  navigateForward: string;
  toggleDevTools: string;
  toggleFullScreen: string;
  windowMenu: string;
  minimize: string;
  windowZoom: string;
  bringAllToFront: string;
  closeWindow: string;
}

// {app} 会在构建菜单时替换为应用名(app.name)。
export const menuLabels: Record<MenuLocale, MenuLabels> = {
  en: {
    about: "About {app}",
    settings: "Settings…",
    services: "Services",
    hide: "Hide {app}",
    hideOthers: "Hide Others",
    unhide: "Show All",
    quit: "Quit {app}",
    disconnectRemote: "Disconnect…",
    file: "File",
    newTile: "New Tile",
    closeTile: "Close Tile",
    openWorkspace: "Open Workspace…",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    selectAll: "Select All",
    find: "Find",
    view: "View",
    toggleFiles: "Toggle Files",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    actualSize: "Actual Size",
    navigateBack: "Navigate Back",
    navigateForward: "Navigate Forward",
    toggleDevTools: "Toggle Developer Tools",
    toggleFullScreen: "Toggle Full Screen",
    windowMenu: "Window",
    minimize: "Minimize",
    windowZoom: "Zoom",
    bringAllToFront: "Bring All to Front",
    closeWindow: "Close Window",
  },
  zh: {
    about: "关于 {app}",
    settings: "设置…",
    services: "服务",
    hide: "隐藏 {app}",
    hideOthers: "隐藏其他",
    unhide: "显示全部",
    quit: "退出 {app}",
    disconnectRemote: "断开连接…",
    file: "文件",
    newTile: "新建 Tile",
    closeTile: "关闭 Tile",
    openWorkspace: "打开工作区…",
    edit: "编辑",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    selectAll: "全选",
    find: "查找",
    view: "视图",
    toggleFiles: "显示/隐藏文件",
    zoomIn: "放大",
    zoomOut: "缩小",
    actualSize: "实际大小",
    navigateBack: "后退",
    navigateForward: "前进",
    toggleDevTools: "开发者工具",
    toggleFullScreen: "切换全屏",
    windowMenu: "窗口",
    minimize: "最小化",
    windowZoom: "缩放",
    bringAllToFront: "全部置于顶层",
    closeWindow: "关闭窗口",
  },
};
