import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  File as FileIcon,
  Folder,
  FolderOpen,
  Link as LinkIcon,
  LinkBreak,
  Plus,
  SquaresFour,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useT, type TplKey, type TplTranslate } from "./i18n";
import HistoryPanel from "./HistoryPanel";

interface TemplateNode {
  name: string;
  relPath: string;
  kind: "folder" | "file";
  isSymlink?: boolean;
  linkTarget?: string;
  broken?: boolean;
}

interface MountPoint {
  template: string;
  sourceRel: string;
  workspace: string;
  linkRel: string;
  broken: boolean;
}

interface MountTreeNode {
  name: string;
  rel: string;
  ws: string;
  mount?: MountPoint;
  children: MountTreeNode[];
}

interface MountResult {
  status:
    | "created"
    | "replaced"
    | "renamed"
    | "already"
    | "cancelled"
    | "error";
  path?: string;
  message?: string;
}

interface InputDialogState {
  titleKey: TplKey;
  placeholderKey?: TplKey;
  initial: string;
  submitLabelKey?: TplKey;
  onSubmit: (value: string) => Promise<string | null>;
}

interface MountSource {
  template: string;
  relPath: string;
  name: string;
}

const KEY = (template: string, relPath: string) => `${template}::${relPath}`;

function splitKey(key: string): [string, string] {
  const idx = key.indexOf("::");
  return [key.slice(0, idx), key.slice(idx + 2)];
}

function parentRelPath(relPath: string): string {
  const parts = relPath.split("/");
  parts.pop();
  return parts.join("/");
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "Unknown error");
  return msg.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function mountResultText(r: MountResult, t: TplTranslate): string | null {
  switch (r.status) {
    case "created":
      return t("result.mounted", { path: r.path ?? "" });
    case "replaced":
      return t("result.replaced", { path: r.path ?? "" });
    case "renamed":
      return t("result.renamed", { path: r.path ?? "" });
    case "already":
      return t("result.already");
    case "error":
      return r.message ?? t("result.failed");
    case "cancelled":
      return null;
  }
}

/** 把 linkRel 路径列表折成目录树；叶子（挂载点）带 mount 引用 */
function buildMountTree(ws: string, rows: MountPoint[]): MountTreeNode[] {
  const byKey = new Map<string, MountTreeNode>();
  const roots: MountTreeNode[] = [];
  for (const m of rows) {
    const segs = m.linkRel.split("/").filter(Boolean);
    let level = roots;
    let rel = "";
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      rel = rel ? `${rel}/${seg}` : seg;
      const key = `${ws}::${rel}`;
      let node = byKey.get(key);
      if (!node) {
        node = { name: seg, rel, ws, children: [] };
        byKey.set(key, node);
        level.push(node);
      }
      if (i === segs.length - 1) node.mount = m;
      level = node.children;
    }
  }
  const sortRec = (nodes: MountTreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

export default function App() {
  const [templates, setTemplates] = useState<string[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);
  const [children, setChildren] = useState<Map<string, TemplateNode[]>>(
    new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [inputDialog, setInputDialog] = useState<InputDialogState | null>(null);
  const [mountSource, setMountSource] = useState<MountSource | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [mounts, setMounts] = useState<MountPoint[] | null>(null);
  const t = useT();
  useEffect(() => {
    document.title = t("toolbar.title");
  }, [t]);

  // Esc 关闭内嵌视图（对话框/挂载面板/历史面板打开时由它们优先处理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (inputDialog !== null || mountSource !== null || historyOpen) return;
      window.api.templatesCloseView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputDialog, mountSource, historyOpen]);

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const activeTemplateRef = useRef(activeTemplate);
  activeTemplateRef.current = activeTemplate;

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const loadTemplates = useCallback(async (): Promise<string[]> => {
    try {
      const list = (await window.api.templatesList()) as string[];
      setTemplates(list);
      return list;
    } catch (e) {
      showToast(errText(e), true);
      return [];
    }
  }, [showToast]);

  const loadDir = useCallback(
    async (template: string, relPath: string): Promise<TemplateNode[]> => {
      try {
        const nodes = (await window.api.templatesTree(
          template,
          relPath,
        )) as TemplateNode[];
        setChildren((prev) => {
          const next = new Map(prev);
          next.set(KEY(template, relPath), nodes);
          return next;
        });
        return nodes;
      } catch {
        setChildren((prev) => {
          const next = new Map(prev);
          next.set(KEY(template, relPath), []);
          return next;
        });
        return [];
      }
    },
    [],
  );

  // ── Mounted-in column ──

  const mountsSeqRef = useRef(0);
  const fetchMounts = useCallback(async () => {
    const t = activeTemplateRef.current;
    const seq = ++mountsSeqRef.current;
    if (!t) {
      setMounts([]);
      return;
    }
    let list: MountPoint[] = [];
    try {
      const r = (await window.api.templatesListMounts({
        template: t,
      })) as MountPoint[];
      if (Array.isArray(r)) list = r;
    } catch {
      list = [];
    }
    if (mountsSeqRef.current !== seq) return;
    setMounts(list);
  }, []);

  // 切换模板：先清空（显示 Loading），再拉取
  useEffect(() => {
    setMounts(null);
    void fetchMounts();
  }, [activeTemplate, fetchMounts]);

  // 主进程广播：建链/卸载/源节点改名删除后自动刷新
  useEffect(
    () => window.api.onTemplatesMountsChanged(() => void fetchMounts()),
    [fetchMounts],
  );

  const selectedRel = useMemo(
    () => (selectedKey ? splitKey(selectedKey)[1] : ""),
    [selectedKey],
  );

  // 未选中节点 = 整个模板：显示模板全部挂载的工作区；
  // 选中文件/文件夹 = 精确匹配该节点（不含模板根挂载与子节点）
  const shownMounts = useMemo(() => {
    const list = mounts ?? [];
    if (!selectedRel) return list;
    return list.filter((m) => m.sourceRel === selectedRel);
  }, [mounts, selectedRel]);

  // ── Mounted-in：workspace 汇总表格 + 挂载路径树 ──

  const [mountWsSel, setMountWsSel] = useState<string | null>(null);
  const [mountCollapsed, setMountCollapsed] = useState<Set<string>>(new Set());

  const mountBlocks = useMemo(() => {
    const map = new Map<string, MountPoint[]>();
    for (const m of shownMounts) {
      const arr = map.get(m.workspace) ?? [];
      arr.push(m);
      map.set(m.workspace, arr);
    }
    return [...map.entries()]
      .map(([ws, rows]) => {
        rows.sort((a, b) => a.linkRel.localeCompare(b.linkRel));
        return {
          ws,
          label: ws.split("/").filter(Boolean).pop() ?? ws,
          count: rows.length,
          broken: rows.filter((m) => m.broken).length,
          roots: buildMountTree(ws, rows),
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [shownMounts]);

  // 表格选中某 workspace 时下方树只看它；数据刷新后选中项消失则自动回落为全部
  const effMountWs = useMemo(
    () =>
      mountWsSel && mountBlocks.some((b) => b.ws === mountWsSel)
        ? mountWsSel
        : null,
    [mountWsSel, mountBlocks],
  );

  const toggleMountCollapse = useCallback((key: string) => {
    setMountCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const revealMount = useCallback(
    (m: MountPoint) => {
      void window.api
        .templatesRevealInWorkspace({
          workspace: m.workspace,
          relPath: m.linkRel,
        })
        .catch((e: unknown) => showToast(errText(e), true));
    },
    [showToast],
  );

  const removeMount = useCallback(
    async (m: MountPoint) => {
      try {
        const r = (await window.api.templatesRemoveLink({
          workspace: m.workspace,
          relPath: m.linkRel,
        })) as { cancelled?: boolean } | null;
        if (r?.cancelled) return;
        showToast(t("mounts.removed"));
        void fetchMounts();
      } catch (e) {
        showToast(errText(e), true);
      }
    },
    [fetchMounts, showToast, t],
  );

  // 点击挂载行：在中间树中定位并选中来源节点
  const jumpToSource = useCallback(
    async (m: MountPoint) => {
      const template = m.template;
      const parts = m.sourceRel ? m.sourceRel.split("/") : [];
      const dirs: string[] = [];
      let cur = "";
      for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        dirs.push(cur);
      }
      await loadDir(template, "");
      for (let i = 0; i < parts.length - 1; i++) {
        await loadDir(template, dirs[i]!);
      }
      const expandKeys = dirs
        .slice(0, Math.max(0, parts.length - 1))
        .map((p) => KEY(template, p));
      if (parts.length === 0) expandKeys.push(KEY(template, ""));
      setExpanded(new Set(expandKeys));
      const key = KEY(template, m.sourceRel);
      setSelectedKey(key);
      requestAnimationFrame(() => {
        try {
          document
            .querySelector(`[data-row-key="${CSS.escape(key)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        } catch {
          // 节点尚未渲染，忽略
        }
      });
    },
    [loadDir],
  );

  // 挂载树的一行：目录行点击折叠/展开，挂载点行点击跳回中间树的来源节点
  function renderMountNode(node: MountTreeNode, level: number): ReactNode {
    const key = `${node.ws}::${node.rel}`;
    const hasKids = node.children.length > 0;
    const collapsed = mountCollapsed.has(key);
    const m = node.mount;
    return (
      <Fragment key={key}>
        <div
          className={`mnt-row ${m ? "mnt-mount" : "mnt-dir"}${
            m?.broken ? " mnt-broken" : ""
          }`}
          style={{ paddingLeft: 10 + level * 16 }}
          title={
            m
              ? `${node.ws}/${node.rel}  ←  ${m.template}/${m.sourceRel || t("mounts.templateRoot")}`
              : `${node.ws}/${node.rel}`
          }
          onClick={() => {
            if (m) void jumpToSource(m);
            else if (hasKids) toggleMountCollapse(key);
          }}
        >
          {hasKids ? (
            <button
              type="button"
              className="mnt-caret"
              onClick={(e) => {
                e.stopPropagation();
                toggleMountCollapse(key);
              }}
            >
              {collapsed ? <CaretRight size={11} /> : <CaretDown size={11} />}
            </button>
          ) : (
            <span className="mnt-caret-spacer" />
          )}
          <span className="mnt-icon">
            {m ? (
              m.broken ? (
                <Warning size={11} weight="bold" />
              ) : (
                <LinkIcon size={11} />
              )
            ) : (
              <Folder size={12} />
            )}
          </span>
          <span className="mnt-label">{node.name}</span>
          {m && (
            <span
              className="mnt-src"
              title={`← ${m.template}/${m.sourceRel || t("mounts.templateRoot")}`}
            >
              ← {m.sourceRel || t("mounts.rootBadge")}
            </span>
          )}
          {m && (
            <span className="mount-actions">
              <button
                type="button"
                title={t("mounts.reveal")}
                onClick={(e) => {
                  e.stopPropagation();
                  revealMount(m);
                }}
              >
                <ArrowSquareOut size={12} />
              </button>
              <button
                type="button"
                className="danger"
                title={t("mounts.remove")}
                onClick={(e) => {
                  e.stopPropagation();
                  void removeMount(m);
                }}
              >
                <LinkBreak size={12} />
              </button>
            </span>
          )}
        </div>
        {hasKids &&
          !collapsed &&
          node.children.map((c) => renderMountNode(c, level + 1))}
      </Fragment>
    );
  }

  // Initial load
  useEffect(() => {
    void loadTemplates().then((list) => {
      const first = list[0];
      if (first !== undefined) {
        setActiveTemplate((cur) => cur ?? first);
      }
    });
  }, [loadTemplates]);

  // Load root when active template changes
  useEffect(() => {
    if (activeTemplate) {
      void loadDir(activeTemplate, "");
    }
  }, [activeTemplate, loadDir]);

  // Reveal event from nav ("show source in templates")
  useEffect(() => {
    return window.api.onTemplatesReveal(
      async ({ template, relPath }: { template: string; relPath: string }) => {
        setActiveTemplate(template);
        setChildren(new Map());
        setExpanded(new Set());
        const parts = relPath ? relPath.split("/") : [];
        const dirs: string[] = [];
        let cur = "";
        for (const part of parts) {
          cur = cur ? `${cur}/${part}` : part;
          dirs.push(cur);
        }
        // Load the root and every ancestor directory
        await loadDir(template, "");
        for (let i = 0; i < parts.length - 1; i++) {
          await loadDir(template, dirs[i]!);
        }
        // Expand ancestors of the revealed node
        const expandKeys = dirs
          .slice(0, Math.max(0, parts.length - 1))
          .map((p) => KEY(template, p));
        if (parts.length === 0) expandKeys.push(KEY(template, ""));
        setExpanded(new Set(expandKeys));
        setSelectedKey(relPath ? KEY(template, relPath) : KEY(template, ""));
      },
    );
  }, [loadDir]);

  const refresh = useCallback(
    async (notify = false) => {
      const list = await loadTemplates();
      const t = activeTemplateRef.current;
      if (t && list.includes(t)) {
        const dirs = new Set<string>([""]);
        for (const k of expandedRef.current) {
          const [kt, rel] = splitKey(k);
          if (kt === t) dirs.add(rel);
        }
        await Promise.all([...dirs].map((rel) => loadDir(t, rel)));
      }
      if (notify) showToast("Refreshed");
    },
    [loadDir, loadTemplates, showToast],
  );

  // Refresh when the window regains focus (template library may have changed externally)
  useEffect(() => {
    const onFocus = () => {
      void refresh(false);
      void fetchMounts();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, fetchMounts]);

  const toggleExpand = useCallback(
    (template: string, node: TemplateNode) => {
      const key = KEY(template, node.relPath);
      const willExpand = !expandedRef.current.has(key);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      if (willExpand && !childrenRef.current.has(key)) {
        void loadDir(template, node.relPath);
      }
    },
    [loadDir],
  );

  // ── Rows (flattened visible tree) ──

  const rows = useMemo(() => {
    if (!activeTemplate) return [];
    const out: Array<{
      node: TemplateNode;
      level: number;
      insideLink: boolean;
    }> = [];
    const walk = (parentRel: string, level: number, insideLink: boolean) => {
      const nodes = children.get(KEY(activeTemplate, parentRel)) ?? [];
      for (const node of nodes) {
        out.push({ node, level, insideLink });
        if (
          node.kind === "folder" &&
          expanded.has(KEY(activeTemplate, node.relPath))
        ) {
          walk(node.relPath, level + 1, insideLink || !!node.isSymlink);
        }
      }
    };
    walk("", 0, false);
    return out;
  }, [activeTemplate, children, expanded]);

  // ── Actions ──

  const doCreateTemplate = useCallback(() => {
    setInputDialog({
      titleKey: "dialog.newTemplate",
      placeholderKey: "dialog.templateName",
      initial: "",
      submitLabelKey: "dialog.create",
      onSubmit: async (value) => {
        try {
          const list = (await window.api.templatesCreate(value)) as string[];
          setTemplates(list);
          setActiveTemplate(value);
          setChildren(new Map());
          setExpanded(new Set());
          setSelectedKey(null);
        } catch (e) {
          return errText(e);
        }
        return null;
      },
    });
  }, []);

  const doCreateNode = useCallback(
    (template: string, parentRel: string, kind: "file" | "dir") => {
      setInputDialog({
        titleKey: kind === "dir" ? "dialog.newFolder" : "dialog.newFile",
        placeholderKey:
          kind === "dir" ? "dialog.folderName" : "dialog.fileName",
        initial: "",
        submitLabelKey: "dialog.create",
        onSubmit: async (value) => {
          try {
            await window.api.templatesCreateNode({
              template,
              relPath: parentRel,
              kind,
              name: value,
            });
          } catch (e) {
            return errText(e);
          }
          if (parentRel !== "") {
            // Ensure the parent folder is expanded so the new item is visible
            setExpanded((prev) => {
              const next = new Set(prev);
              next.add(KEY(template, parentRel));
              return next;
            });
          }
          await loadDir(template, parentRel);
          return null;
        },
      });
    },
    [loadDir],
  );

  const doRenameNode = useCallback(
    (template: string, node: TemplateNode) => {
      setInputDialog({
        titleKey: "dialog.rename",
        initial: node.name,
        submitLabelKey: "dialog.rename",
        onSubmit: async (value) => {
          try {
            await window.api.templatesRenameNode({
              template,
              relPath: node.relPath,
              newName: value,
            });
          } catch (e) {
            return errText(e);
          }
          await loadDir(template, parentRelPath(node.relPath));
          return null;
        },
      });
    },
    [loadDir],
  );

  const doDeleteNode = useCallback(
    async (template: string, node: TemplateNode) => {
      try {
        const r = (await window.api.templatesDeleteNode({
          template,
          relPath: node.relPath,
        })) as { cancelled?: boolean };
        if (!r?.cancelled) {
          await loadDir(template, parentRelPath(node.relPath));
        }
      } catch (e) {
        showToast(errText(e), true);
      }
    },
    [loadDir, showToast],
  );

  const doRenameTemplate = useCallback((name: string) => {
    setInputDialog({
      titleKey: "dialog.renameTemplate",
      initial: name,
      submitLabelKey: "dialog.rename",
      onSubmit: async (value) => {
        try {
          const list = (await window.api.templatesRename(
            name,
            value,
          )) as string[];
          setTemplates(list);
          if (activeTemplateRef.current === name) {
            setActiveTemplate(value);
          }
        } catch (e) {
          return errText(e);
        }
        return null;
      },
    });
  }, []);

  const doDeleteTemplate = useCallback(
    async (name: string) => {
      try {
        const r = (await window.api.templatesDelete(name)) as {
          cancelled?: boolean;
          templates?: string[];
        };
        if (r?.cancelled) return;
        const list = r?.templates ?? (await loadTemplates());
        if (activeTemplateRef.current === name) {
          setActiveTemplate(list.length > 0 ? list[0]! : null);
          setChildren(new Map());
          setExpanded(new Set());
          setSelectedKey(null);
        }
      } catch (e) {
        showToast(errText(e), true);
      }
    },
    [loadTemplates, showToast],
  );

  // ── Context menus ──

  const handleNodeMenu = useCallback(
    async (template: string, node: TemplateNode, insideLink: boolean) => {
      const isDir = node.kind === "folder";
      const items: Array<{ id: string; label: string }> = [
        { id: "open", label: t("menu.openExternal") },
        { id: "mount", label: t("menu.mountTo") },
        { id: "separator", label: "" },
      ];
      // 链接内部写操作会落到链接目标（可能属于另一个模板），只保留只读操作
      if (!insideLink) {
        if (isDir && !node.isSymlink) {
          items.push({ id: "new-file", label: t("menu.newFile") });
          items.push({ id: "new-folder", label: t("menu.newFolder") });
          items.push({ id: "separator", label: "" });
        }
        items.push({ id: "rename", label: t("menu.rename") });
        items.push({ id: "delete", label: t("menu.delete") });
        items.push({ id: "separator", label: "" });
      }
      items.push({ id: "reveal", label: t("menu.reveal") });

      const action = (await window.api.showContextMenu(items)) as string | null;
      if (!action) return;

      switch (action) {
        case "open":
          void window.api.templatesOpenExternal({
            template,
            relPath: node.relPath,
            isDir,
          });
          break;
        case "mount":
          setMountSource({
            template,
            relPath: node.relPath,
            name: node.name,
          });
          break;
        case "new-file":
          doCreateNode(template, node.relPath, "file");
          break;
        case "new-folder":
          doCreateNode(template, node.relPath, "dir");
          break;
        case "rename":
          doRenameNode(template, node);
          break;
        case "delete":
          void doDeleteNode(template, node);
          break;
        case "reveal":
          void window.api.templatesRevealPath({
            template,
            relPath: node.relPath,
          });
          break;
      }
    },
    [doCreateNode, doDeleteNode, doRenameNode, t],
  );

  const handleTemplateMenu = useCallback(
    async (name: string) => {
      const items: Array<{ id: string; label: string }> = [
        { id: "mount", label: t("menu.mountTo") },
        { id: "open", label: t("menu.openExternal") },
        { id: "separator", label: "" },
        { id: "rename-template", label: t("menu.renameTemplate") },
        { id: "delete-template", label: t("menu.deleteTemplate") },
        { id: "separator", label: "" },
        { id: "reveal-template", label: t("menu.reveal") },
      ];
      const action = (await window.api.showContextMenu(items)) as string | null;
      if (!action) return;

      switch (action) {
        case "mount":
          setMountSource({ template: name, relPath: "", name });
          break;
        case "open":
          void window.api.templatesOpenExternal({
            template: name,
            relPath: "",
            isDir: true,
          });
          break;
        case "rename-template":
          doRenameTemplate(name);
          break;
        case "delete-template":
          void doDeleteTemplate(name);
          break;
        case "reveal-template":
          void window.api.templatesRevealPath({ template: name });
          break;
      }
    },
    [doDeleteTemplate, doRenameTemplate, t],
  );

  const handleEmptyMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      const tpl = activeTemplateRef.current;
      if (!tpl) {
        void handleTemplateMenu; // no-op reference guard
        return;
      }
      const items = [
        { id: "new-file", label: t("menu.newFile") },
        { id: "new-folder", label: t("menu.newFolder") },
        { id: "separator", label: "" },
        { id: "refresh", label: t("menu.refresh") },
      ];
      const action = (await window.api.showContextMenu(items)) as string | null;
      if (!action) return;
      if (action === "new-file") doCreateNode(tpl, "", "file");
      else if (action === "new-folder") doCreateNode(tpl, "", "dir");
      else if (action === "refresh") void refresh(true);
    },
    [doCreateNode, handleTemplateMenu, refresh, t],
  );

  // ── Drag source ──

  const onNodeDragStart = useCallback(
    (e: React.DragEvent, template: string, relPath: string) => {
      e.dataTransfer.effectAllowed = "copy";
      try {
        e.dataTransfer.setData("application/x-collab-template", relPath);
      } catch {
        // custom MIME may be restricted in some contexts
      }
      window.api.templatesDragStart({ template, relPath });
    },
    [],
  );

  const onNodeDragEnd = useCallback(() => {
    window.api.templatesDragEnd();
  }, []);

  // ── Render ──

  return (
    <div className="app">
      <div className="toolbar">
        <h1 className="toolbar-title">{t("toolbar.title")}</h1>
        <button
          type="button"
          onClick={() => void window.api.templatesRevealPath({})}
          title={t("toolbar.revealTitle")}
        >
          <ArrowSquareOut size={13} style={{ verticalAlign: "-2px" }} />{" "}
          {t("toolbar.reveal")}
        </button>
        <button type="button" onClick={() => void refresh(true)}>
          <ArrowsClockwise size={13} style={{ verticalAlign: "-2px" }} />{" "}
          {t("toolbar.refresh")}
        </button>
        <button type="button" onClick={() => setHistoryOpen(true)}>
          <ClockCounterClockwise size={13} style={{ verticalAlign: "-2px" }} />{" "}
          {t("toolbar.history")}
        </button>
        <button type="button" className="primary" onClick={doCreateTemplate}>
          <Plus size={13} style={{ verticalAlign: "-2px" }} />{" "}
          {t("toolbar.newTemplate")}
        </button>
        <button
          type="button"
          className="toolbar-close"
          onClick={() => window.api.templatesCloseView()}
          title={t("toolbar.closeTitle")}
          aria-label={t("toolbar.close")}
        >
          <X size={14} />
        </button>
      </div>

      <div className="body">
        <div className="sidebar">
          {templates.map((name) => (
            <div
              key={name}
              className={`template-item${name === activeTemplate ? " active" : ""}`}
              draggable
              onDragStart={(e) => onNodeDragStart(e, name, "")}
              onDragEnd={onNodeDragEnd}
              onClick={() => {
                setActiveTemplate(name);
                setSelectedKey(null);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                void handleTemplateMenu(name);
              }}
            >
              {name === activeTemplate ? (
                <FolderOpen size={14} />
              ) : (
                <Folder size={14} />
              )}
              <span className="tree-label">{name}</span>
            </div>
          ))}
        </div>

        <div
          className="tree-pane"
          onContextMenu={(e) => void handleEmptyMenu(e)}
        >
          {!activeTemplate ? (
            <div className="tree-empty">
              <SquaresFour size={36} weight="thin" style={{ opacity: 0.4 }} />
              <p>
                {templates.length === 0
                  ? t("empty.libraryTitle")
                  : t("empty.selectTemplate")}
              </p>
              {templates.length === 0 && (
                <>
                  <p>{t("empty.libraryHint")}</p>
                  <button type="button" onClick={doCreateTemplate}>
                    {t("toolbar.newTemplate")}
                  </button>
                </>
              )}
            </div>
          ) : rows.length === 0 ? (
            <div className="tree-hint">
              {t("empty.templateEmpty")}
              <br />
              {t("empty.templateHint")}
            </div>
          ) : (
            rows.map(({ node, level, insideLink }) => {
              const key = KEY(activeTemplate, node.relPath);
              const isOpen = expanded.has(key);
              return (
                <div
                  key={key}
                  data-row-key={key}
                  className={`tree-row${selectedKey === key ? " selected" : ""}`}
                  style={{ paddingLeft: 10 + level * 14 }}
                  draggable
                  onDragStart={(e) =>
                    onNodeDragStart(e, activeTemplate, node.relPath)
                  }
                  onDragEnd={onNodeDragEnd}
                  onClick={() => {
                    setSelectedKey(key);
                    if (node.kind === "folder") {
                      toggleExpand(activeTemplate, node);
                    }
                  }}
                  onDoubleClick={() => {
                    if (node.kind === "file") {
                      void window.api.templatesOpenExternal({
                        template: activeTemplate,
                        relPath: node.relPath,
                        isDir: false,
                      });
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSelectedKey(key);
                    void handleNodeMenu(activeTemplate, node, insideLink);
                  }}
                >
                  <span className="tree-caret">
                    {node.kind === "folder" ? (
                      isOpen ? (
                        <CaretDown size={10} weight="bold" />
                      ) : (
                        <CaretRight size={10} weight="bold" />
                      )
                    ) : null}
                  </span>
                  <span className="tree-icon">
                    {node.kind === "folder" ? (
                      <Folder size={13} />
                    ) : (
                      <FileIcon size={13} />
                    )}
                  </span>
                  <span className="tree-label">{node.name}</span>
                  {node.isSymlink && (
                    <span
                      className={`link-badge${node.broken ? " broken" : ""}`}
                      title={
                        node.broken
                          ? `${t("link.broken")}${
                              node.linkTarget ? ` → ${node.linkTarget}` : ""
                            }`
                          : node.linkTarget
                            ? `${t("link.symlink")} → ${node.linkTarget}`
                            : t("link.symlink")
                      }
                    >
                      {node.broken ? (
                        <Warning size={11} weight="bold" />
                      ) : (
                        <LinkIcon size={11} />
                      )}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="mounts-pane">
          {mountSource !== null ? (
            <MountTargetPanel
              source={mountSource}
              onClose={() => setMountSource(null)}
              onDone={(result) => {
                setMountSource(null);
                const text = mountResultText(result, t);
                if (text !== null) showToast(text, result.status === "error");
                void fetchMounts();
              }}
            />
          ) : (
            <>
              <div className="mounts-header">
                <span className="mounts-title">{t("mounts.title")}</span>
                {mounts !== null && shownMounts.length > 0 && (
                  <span className="mounts-count">{shownMounts.length}</span>
                )}
                <button
                  type="button"
                  className="mounts-refresh"
                  title={t("mounts.refresh")}
                  onClick={() => void fetchMounts()}
                >
                  <ArrowsClockwise size={12} />
                </button>
              </div>

              {selectedRel && (
                <div className="mounts-filter">
                  <span className="mounts-filter-text" title={selectedRel}>
                    {selectedRel}
                  </span>
                  <button
                    type="button"
                    title={t("mounts.clearSelection")}
                    onClick={() => setSelectedKey(null)}
                  >
                    <X size={11} />
                  </button>
                </div>
              )}

              {mounts === null ? (
                <div className="mounts-empty">{t("mounts.loading")}</div>
              ) : !activeTemplate ? (
                <div className="mounts-empty">{t("mounts.selectTemplate")}</div>
              ) : shownMounts.length === 0 ? (
                <div className="mounts-empty">
                  {mounts.length > 0
                    ? t("mounts.notMountedNode")
                    : t("mounts.notMounted")}
                  <br />
                  {t("mounts.emptyHint")}
                </div>
              ) : (
                <>
                  <div className="mounts-table-wrap">
                    <div className="mtable-head">
                      <span>{t("mounts.colWorkspace")}</span>
                      <span>{t("mounts.colPath")}</span>
                      <span className="mtable-num">
                        {t("mounts.colMounts")}
                      </span>
                      <span className="mtable-num">
                        {t("mounts.colBroken")}
                      </span>
                    </div>
                    {mountBlocks.map((b) => (
                      <div
                        key={b.ws}
                        className={`mtable-row${
                          effMountWs === b.ws ? " selected" : ""
                        }`}
                        title={
                          effMountWs === b.ws
                            ? t("mounts.showAll")
                            : t("mounts.filterTo", { name: b.label })
                        }
                        onClick={() =>
                          setMountWsSel(effMountWs === b.ws ? null : b.ws)
                        }
                      >
                        <span className="mtable-name">{b.label}</span>
                        <span className="mtable-path" title={b.ws}>
                          {b.ws}
                        </span>
                        <span className="mtable-num">{b.count}</span>
                        <span
                          className={`mtable-num${b.broken > 0 ? " alert" : ""}`}
                        >
                          {b.broken > 0 ? b.broken : "—"}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="mounts-tree">
                    {mountBlocks
                      .filter((b) => !effMountWs || b.ws === effMountWs)
                      .map((b) => {
                        const rootKey = `${b.ws}::`;
                        const rootCollapsed =
                          effMountWs === null && mountCollapsed.has(rootKey);
                        return (
                          <Fragment key={b.ws}>
                            {effMountWs === null && (
                              <div
                                className="mnt-row mnt-ws"
                                title={b.ws}
                                onClick={() => toggleMountCollapse(rootKey)}
                              >
                                <button
                                  type="button"
                                  className="mnt-caret"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleMountCollapse(rootKey);
                                  }}
                                >
                                  {rootCollapsed ? (
                                    <CaretRight size={11} />
                                  ) : (
                                    <CaretDown size={11} />
                                  )}
                                </button>
                                <span className="mnt-icon">
                                  <FolderOpen size={12} />
                                </span>
                                <span className="mnt-label">{b.label}</span>
                                <span className="mounts-count">{b.count}</span>
                              </div>
                            )}
                            {!rootCollapsed &&
                              b.roots.map((n) =>
                                renderMountNode(n, effMountWs ? 0 : 1),
                              )}
                          </Fragment>
                        );
                      })}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {inputDialog && (
        <InputDialog state={inputDialog} onClose={() => setInputDialog(null)} />
      )}

      {historyOpen && (
        <HistoryPanel
          onClose={() => setHistoryOpen(false)}
          onRequestInput={(state) => setInputDialog(state)}
        />
      )}

      {toast && (
        <div className={`toast${toast.error ? " error" : ""}`}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

// ── Input dialog ──

function InputDialog({
  state,
  onClose,
}: {
  state: InputDialogState;
  onClose: () => void;
}) {
  const [value, setValue] = useState(state.initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const err = await state.onSubmit(trimmed);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t(state.titleKey)}</h3>
        <input
          ref={inputRef}
          type="text"
          placeholder={state.placeholderKey ? t(state.placeholderKey) : ""}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        {error && <p className="modal-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            {t("dialog.cancel")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !value.trim()}
            onClick={() => void submit()}
          >
            {state.submitLabelKey ? t(state.submitLabelKey) : t("dialog.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Mount target panel（右栏内嵌：workspace + 目标文件夹树） ──

interface TargetDirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

function MountTargetPanel({
  source,
  onClose,
  onDone,
}: {
  source: MountSource;
  onClose: () => void;
  onDone: (result: MountResult) => void;
}) {
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [ws, setWs] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, TargetDirEntry[]>>(
    new Map(),
  );
  const [selectedRel, setSelectedRel] = useState("");
  const [busy, setBusy] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    void window.api
      .templatesWorkspaces()
      .then((list: unknown) => {
        const arr = Array.isArray(list) ? (list as string[]) : [];
        setWorkspaces(arr);
        if (arr.length > 0) setWs(arr[0]!);
      })
      .catch(() => setWorkspaces([]));
  }, []);

  // Esc 关闭面板（若其上还有模态框则让模态框优先处理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".modal-overlay")) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadChildren = useCallback(async (root: string, rel: string) => {
    const dir = rel ? `${root}/${rel}` : root;
    let dirs: TargetDirEntry[] = [];
    try {
      const list = (await window.api.readDir(dir)) as unknown;
      const arr = Array.isArray(list) ? (list as TargetDirEntry[]) : [];
      dirs = arr.filter((e) => e.isDirectory && !e.isSymlink);
    } catch {
      dirs = [];
    }
    setChildren((prev) => {
      const next = new Map(prev);
      next.set(rel, dirs);
      return next;
    });
  }, []);

  // 就地注册一个新 workspace：选文件夹 → 加入 workspace 列表 → 选中并加载
  const addWorkspace = useCallback(async () => {
    setWsError(null);
    try {
      const picked = (await window.api.openFolder()) as string | null;
      if (!picked) return;
      const prev = workspaces;
      const r = (await window.api.workspaceAddByPath(picked)) as {
        workspaces: string[];
      } | null;
      const arr = Array.isArray(r?.workspaces) ? r.workspaces : [];
      if (arr.length === 0) return;
      setWorkspaces(arr);
      const target =
        arr.find((w) => !prev.includes(w)) ??
        (arr.includes(picked) ? picked : null);
      if (target) setWs(target);
    } catch (e) {
      setWsError(errText(e));
    }
  }, [workspaces]);

  // 切换 workspace：重置树并载入根目录
  useEffect(() => {
    if (!ws) return;
    setExpanded(new Set());
    setChildren(new Map());
    setSelectedRel("");
    void loadChildren(ws, "");
  }, [ws, loadChildren]);

  const toggle = useCallback(
    (rel: string) => {
      if (!ws) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) next.delete(rel);
        else next.add(rel);
        return next;
      });
      if (!children.has(rel)) void loadChildren(ws, rel);
    },
    [ws, children, loadChildren],
  );

  const rows = useMemo(() => {
    const out: Array<{ rel: string; name: string; level: number }> = [];
    const walk = (parentRel: string, level: number) => {
      for (const e of children.get(parentRel) ?? []) {
        const rel = parentRel ? `${parentRel}/${e.name}` : e.name;
        out.push({ rel, name: e.name, level });
        if (expanded.has(rel)) walk(rel, level + 1);
      }
    };
    if (children.has("")) walk("", 1);
    return out;
  }, [children, expanded]);

  const mountHere = async () => {
    if (!ws || busy) return;
    setBusy(true);
    try {
      const result = (await window.api.templatesMountTo({
        source: { template: source.template, relPath: source.relPath },
        target: { workspace: ws, relPath: selectedRel },
      })) as MountResult;
      onDone(result);
    } catch (e) {
      onDone({ status: "error", message: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const sourceLabel = source.relPath
    ? `${source.template}/${source.relPath}`
    : `${source.template} (${t("picker.whole")})`;
  const wsLabel = ws ? (ws.split("/").filter(Boolean).pop() ?? ws) : "";

  return (
    <div className="mount-target-panel">
      <div className="mounts-header">
        <span className="mounts-title">{t("picker.title")}</span>
        <button
          type="button"
          className="mounts-refresh"
          title={t("picker.cancel")}
          onClick={onClose}
        >
          <X size={12} />
        </button>
      </div>
      <div className="mounts-filter" title={sourceLabel}>
        <span className="mounts-filter-text">
          {t("picker.source", { label: sourceLabel })}
        </span>
      </div>

      <div className="ws-row">
        {workspaces.map((w) => (
          <button
            key={w}
            type="button"
            className={`ws-chip${w === ws ? " active" : ""}`}
            onClick={() => {
              setWs(w);
              setExpanded(new Set());
              setChildren(new Map());
              setSelectedRel("");
            }}
          >
            {w.split("/").filter(Boolean).pop() ?? w}
          </button>
        ))}
        <button
          type="button"
          className="ws-chip add"
          onClick={() => void addWorkspace()}
        >
          + {t("picker.addWorkspace")}
        </button>
      </div>
      {workspaces.length === 0 && (
        <p className="hint">{t("picker.noWorkspaces")}</p>
      )}
      {wsError && <p className="modal-error">{wsError}</p>}

      {ws && (
        <div className="mount-tree">
          <div
            className={`mtree-row${selectedRel === "" ? " selected" : ""}`}
            onClick={() => setSelectedRel("")}
          >
            <span className="mtree-caret" />
            <FolderOpen size={13} />
            <span className="mtree-label">{wsLabel}</span>
          </div>
          {!children.has("") && (
            <div
              className="mtree-row mtree-loading"
              style={{ paddingLeft: 30 }}
            >
              {t("picker.loading")}
            </div>
          )}
          {rows.map((r) => {
            const isOpen = expanded.has(r.rel);
            const known = children.has(r.rel);
            const hasKids = (children.get(r.rel)?.length ?? 0) > 0;
            return (
              <Fragment key={r.rel}>
                <div
                  className={`mtree-row${selectedRel === r.rel ? " selected" : ""}`}
                  style={{ paddingLeft: 8 + r.level * 14 }}
                  onClick={() => setSelectedRel(r.rel)}
                  onDoubleClick={() => toggle(r.rel)}
                >
                  <span
                    className="mtree-caret"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r.rel);
                    }}
                  >
                    {!known || hasKids ? (
                      isOpen ? (
                        <CaretDown size={10} weight="bold" />
                      ) : (
                        <CaretRight size={10} weight="bold" />
                      )
                    ) : null}
                  </span>
                  <Folder size={13} />
                  <span className="mtree-label">{r.name}</span>
                </div>
                {isOpen && !known && (
                  <div
                    className="mtree-row mtree-loading"
                    style={{ paddingLeft: 8 + (r.level + 1) * 14 + 14 }}
                  >
                    {t("picker.loading")}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      <p className="hint">
        {t("picker.target", { label: wsLabel || "—" })}
        {selectedRel
          ? ` / ${selectedRel.split("/").join(" / ")}`
          : ` ${t("picker.root")}`}
      </p>

      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          {t("picker.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!ws || busy}
          onClick={() => void mountHere()}
        >
          {t("picker.mountHere")}
        </button>
      </div>
    </div>
  );
}
