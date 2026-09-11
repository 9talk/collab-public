import { useCallback, useEffect, useState } from "react";

export type TemplatesLocale = "en" | "zh";

const en = {
  "toolbar.title": "Templates",
  "toolbar.reveal": "Reveal",
  "toolbar.revealTitle": "Reveal template library in Finder",
  "toolbar.refresh": "Refresh",
  "toolbar.newTemplate": "New Template",
  "toolbar.close": "Close",
  "toolbar.closeTitle": "Close (Esc)",

  "empty.libraryTitle": "Template library is empty.",
  "empty.selectTemplate": "Select a template.",
  "empty.libraryHint":
    "Create a template here, or drop folders into the template library and hit Refresh.",
  "empty.templateEmpty": "This template is empty.",
  "empty.templateHint":
    "Right-click to add files, or drag one from Finder into the template folder.",

  "link.broken": "Broken link",
  "link.symlink": "Symlink",

  "menu.openExternal": "Open in External Editor",
  "menu.mountTo": "Mount to…",
  "menu.newFile": "New File",
  "menu.newFolder": "New Folder",
  "menu.rename": "Rename",
  "menu.delete": "Delete",
  "menu.reveal": "Reveal in Finder",
  "menu.renameTemplate": "Rename Template",
  "menu.deleteTemplate": "Delete Template",
  "menu.refresh": "Refresh",

  "dialog.newTemplate": "New Template",
  "dialog.templateName": "Template name",
  "dialog.newFolder": "New Folder",
  "dialog.folderName": "Folder name",
  "dialog.newFile": "New File",
  "dialog.fileName": "File name",
  "dialog.rename": "Rename",
  "dialog.renameTemplate": "Rename Template",
  "dialog.create": "Create",
  "dialog.cancel": "Cancel",
  "dialog.ok": "OK",

  "mounts.title": "Mounted in",
  "mounts.refresh": "Refresh",
  "mounts.clearSelection": "Clear selection",
  "mounts.loading": "Loading…",
  "mounts.selectTemplate": "Select a template to see where it is mounted.",
  "mounts.notMountedNode": "This node is not mounted anywhere.",
  "mounts.notMounted": "Not mounted anywhere yet.",
  "mounts.emptyHint":
    "Drag a node onto the nav tree, or right-click → “Mount to…”.",
  "mounts.colWorkspace": "Workspace",
  "mounts.colPath": "Path",
  "mounts.colMounts": "Mounts",
  "mounts.colBroken": "Broken",
  "mounts.showAll": "Show all workspaces",
  "mounts.filterTo": "Filter tree to {name}",
  "mounts.reveal": "Reveal in Finder",
  "mounts.remove": "Remove link",
  "mounts.templateRoot": "(template root)",
  "mounts.rootBadge": "root",
  "mounts.removed": "Link removed",

  "picker.title": "Mount to…",
  "picker.source": "Source: {label}",
  "picker.whole": "whole template",
  "picker.noWorkspaces": "No workspaces available.",
  "picker.addWorkspace": "Add workspace…",
  "picker.loading": "Loading…",
  "picker.target": "Target: {label}",
  "picker.root": "(root)",
  "picker.cancel": "Cancel",
  "picker.mountHere": "Mount here",

  "result.mounted": "Mounted → {path}",
  "result.replaced": "Replaced existing link → {path}",
  "result.renamed": "Mounted as new name → {path}",
  "result.already": "Already mounted (no change)",
  "result.failed": "Mount failed",
} as const;

export type TplKey = keyof typeof en;

const zh: Record<TplKey, string> = {
  "toolbar.title": "模板",
  "toolbar.reveal": "打开目录",
  "toolbar.revealTitle": "在 Finder 中显示模板库",
  "toolbar.refresh": "刷新",
  "toolbar.newTemplate": "新建模板",
  "toolbar.close": "关闭",
  "toolbar.closeTitle": "关闭（Esc）",

  "empty.libraryTitle": "模板库为空。",
  "empty.selectTemplate": "选择一个模板。",
  "empty.libraryHint": "可在此新建模板，或将文件夹拖入模板库后点击刷新。",
  "empty.templateEmpty": "此模板为空。",
  "empty.templateHint": "右键添加文件，或从 Finder 拖入模板文件夹。",

  "link.broken": "断链",
  "link.symlink": "软链接",

  "menu.openExternal": "用外部编辑器打开",
  "menu.mountTo": "挂载到…",
  "menu.newFile": "新建文件",
  "menu.newFolder": "新建文件夹",
  "menu.rename": "重命名",
  "menu.delete": "删除",
  "menu.reveal": "在 Finder 中显示",
  "menu.renameTemplate": "重命名模板",
  "menu.deleteTemplate": "删除模板",
  "menu.refresh": "刷新",

  "dialog.newTemplate": "新建模板",
  "dialog.templateName": "模板名称",
  "dialog.newFolder": "新建文件夹",
  "dialog.folderName": "文件夹名称",
  "dialog.newFile": "新建文件",
  "dialog.fileName": "文件名",
  "dialog.rename": "重命名",
  "dialog.renameTemplate": "重命名模板",
  "dialog.create": "创建",
  "dialog.cancel": "取消",
  "dialog.ok": "确定",

  "mounts.title": "挂载于",
  "mounts.refresh": "刷新",
  "mounts.clearSelection": "清除选择",
  "mounts.loading": "加载中…",
  "mounts.selectTemplate": "选择一个模板查看其挂载位置。",
  "mounts.notMountedNode": "此节点未挂载到任何位置。",
  "mounts.notMounted": "尚未挂载到任何位置。",
  "mounts.emptyHint": "将节点拖到导航树，或右键 →「挂载到…」。",
  "mounts.colWorkspace": "工作区",
  "mounts.colPath": "路径",
  "mounts.colMounts": "挂载数",
  "mounts.colBroken": "断链",
  "mounts.showAll": "显示全部工作区",
  "mounts.filterTo": "只看 {name}",
  "mounts.reveal": "在 Finder 中显示",
  "mounts.remove": "移除链接",
  "mounts.templateRoot": "（模板根）",
  "mounts.rootBadge": "根",
  "mounts.removed": "已移除链接",

  "picker.title": "挂载到…",
  "picker.source": "来源：{label}",
  "picker.whole": "整个模板",
  "picker.noWorkspaces": "没有可用的工作区。",
  "picker.addWorkspace": "添加工作区…",
  "picker.loading": "加载中…",
  "picker.target": "目标：{label}",
  "picker.root": "（根目录）",
  "picker.cancel": "取消",
  "picker.mountHere": "挂载到此",

  "result.mounted": "已挂载 → {path}",
  "result.replaced": "已替换现有链接 → {path}",
  "result.renamed": "以新名称挂载 → {path}",
  "result.already": "已挂载（无变化）",
  "result.failed": "挂载失败",
};

const dictionaries: Record<TemplatesLocale, Record<TplKey, string>> = {
  en,
  zh,
};

export type TplTranslate = (
  key: TplKey,
  vars?: Record<string, string>,
) => string;

/** 模板窗口翻译：跟随全局 locale 偏好（设置 → 外观），并实时响应切换 */
export function useT(): TplTranslate {
  const [locale, setLocale] = useState<TemplatesLocale>("en");

  useEffect(() => {
    window.api
      .getPref("locale")
      .then((v) => {
        if (v === "en" || v === "zh") setLocale(v);
      })
      .catch(() => {});
    return window.api.onPrefChanged((key, value) => {
      if (key === "locale" && (value === "en" || value === "zh")) {
        setLocale(value);
      }
    });
  }, []);

  return useCallback<TplTranslate>(
    (key, vars) => {
      const dict = dictionaries[locale];
      let s = dict[key] ?? en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replace(`{${k}}`, v);
        }
      }
      return s;
    },
    [locale],
  );
}
