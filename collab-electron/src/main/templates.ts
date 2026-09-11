import {
  BrowserWindow,
  dialog,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { matchesPattern } from "@collab/shared/external-app";
import { TEMPLATES_DIR } from "./paths";
import { bindIpc } from "./ipc-registry";
import { emitFsChange } from "./watcher";
import {
  createFileFilter,
  resolveIgnoreCase,
  resolveIgnorePatterns,
} from "./file-filter";
import { openFileInEditor, openWorkspaceInEditor } from "./external-editor";

export interface TemplatesContext {
  mainWindow: () => BrowserWindow | null;
  forwardToWebview: (
    target: string,
    channel: string,
    ...args: unknown[]
  ) => void;
  workspaces: () => string[];
  getPref: (key: string) => unknown;
  setPref: (key: string, value: unknown) => void;
}

export interface TemplateNode {
  name: string;
  relPath: string;
  kind: "folder" | "file";
  isSymlink?: boolean;
  linkTarget?: string;
  broken?: boolean;
}

interface LinkSource {
  template: string;
  relPath: string;
}

interface LinkTarget {
  workspace: string;
  relPath: string;
}

interface DragPayload {
  template: string;
  relPath: string;
  name: string;
  isDir: boolean;
}

type MountStatus =
  | "created"
  | "replaced"
  | "renamed"
  | "already"
  | "cancelled"
  | "error";

interface MountResult {
  status: MountStatus;
  path?: string;
  message?: string;
}

const SKIP_CONFIRM_PREF = "templatesSkipMountConfirm";

// ── 路径与名校验 ────────────────────────────────────────────────

function validateName(name: unknown): string {
  if (typeof name !== "string") throw new Error("名称无效");
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error("名称无效");
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error("名称不能包含路径分隔符");
  }
  return trimmed;
}

function safeJoin(base: string, rel: unknown): string {
  const relStr = typeof rel === "string" ? rel : "";
  const resolved = resolve(base, relStr);
  const out = relative(base, resolved);
  if (out !== "" && (out.startsWith("..") || isAbsolute(out))) {
    throw new Error(`路径越界: ${relStr}`);
  }
  return resolved;
}

function pathExistsNoFollow(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDirThroughLink(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 逐段检查模板根以下的路径，任一段为软链即拒绝写操作（写入会落到链接
 * 目标，可能是另一个模板或模板库之外）。skipLast=true 时跳过末段：对
 * 链接本身的 rename/delete 只动链接，是允许的。
 */
function assertNoSymlinkAncestors(
  base: string,
  relPath: unknown,
  skipLast = false,
): void {
  const relStr = typeof relPath === "string" ? relPath : "";
  if (!relStr) return;
  let segments = relStr.split("/").filter((s) => s && s !== ".");
  if (skipLast) segments = segments.slice(0, -1);
  let cur = base;
  for (const seg of segments) {
    cur = join(cur, seg);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`软链接内部禁止写入: ${relStr}`);
    }
  }
}

function sourcePathOf(source: LinkSource): string {
  const template = validateName(source?.template);
  const base = join(TEMPLATES_DIR, template);
  const rel = typeof source?.relPath === "string" ? source.relPath : "";
  const p = rel ? safeJoin(base, rel) : base;
  if (!pathExistsNoFollow(p)) {
    throw new Error(`模板内容不存在: ${template}/${rel}`);
  }
  if (lstatSync(p).isSymbolicLink() && !existsSync(p)) {
    throw new Error(`模板内容已断链: ${template}/${rel}`);
  }
  return p;
}

function targetDirOf(target: LinkTarget, workspaces: string[]): string {
  const ws = typeof target?.workspace === "string" ? target.workspace : "";
  if (!ws || !workspaces.includes(ws)) {
    throw new Error("workspace 不在列表中");
  }
  const rel = typeof target?.relPath === "string" ? target.relPath : "";
  const dir = rel ? safeJoin(ws, rel) : ws;
  if (!existsSync(dir)) {
    throw new Error(`目标目录不存在: ${dir}`);
  }
  return dir;
}

function sourceLabelOf(source: LinkSource, name: string): string {
  const inner =
    typeof source.relPath === "string" && source.relPath ? source.relPath : "";
  return inner ? `${source.template}/${inner}` : `${source.template}/${name}`;
}

function targetLabelOf(target: LinkTarget): string {
  const rel = typeof target.relPath === "string" ? target.relPath : "";
  return rel
    ? `${basename(target.workspace)}/${rel}`
    : basename(target.workspace);
}

function showMessage(
  win: BrowserWindow | null,
  opts: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  return win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
}

// ── 模板库操作 ─────────────────────────────────────────────────

export async function ensureTemplatesDir(): Promise<void> {
  await mkdir(TEMPLATES_DIR, { recursive: true });
}

export async function listTemplates(): Promise<string[]> {
  await ensureTemplatesDir();
  const entries = await readdir(TEMPLATES_DIR, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        !e.name.startsWith(".") &&
        (e.isDirectory() ||
          (e.isSymbolicLink() &&
            isDirThroughLink(join(TEMPLATES_DIR, e.name)))),
    )
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export async function readTemplateDir(
  template: string,
  relPath: string,
): Promise<TemplateNode[]> {
  const dir = safeJoin(join(TEMPLATES_DIR, validateName(template)), relPath);
  const entries = await readdir(dir, { withFileTypes: true });
  const nodes: TemplateNode[] = [];

  for (const e of entries) {
    if (e.name === ".DS_Store") continue;
    const full = join(dir, e.name);
    const rel = relPath ? `${relPath}/${e.name}` : e.name;
    const isSymlink = e.isSymbolicLink();
    let kind: "folder" | "file" = e.isDirectory() ? "folder" : "file";
    let linkTarget: string | undefined;
    let broken = false;

    if (isSymlink) {
      try {
        linkTarget = await readlink(full);
        const s = await stat(full);
        kind = s.isDirectory() ? "folder" : "file";
      } catch {
        broken = true;
      }
    }

    const node: TemplateNode = { name: e.name, relPath: rel, kind };
    if (isSymlink) node.isSymlink = true;
    if (linkTarget !== undefined) node.linkTarget = linkTarget;
    if (broken) node.broken = true;
    nodes.push(node);
  }

  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return nodes;
}

export async function createTemplate(name: unknown): Promise<string[]> {
  const n = validateName(name);
  await ensureTemplatesDir();
  const p = join(TEMPLATES_DIR, n);
  if (pathExistsNoFollow(p)) throw new Error(`已存在同名模板: ${n}`);
  await mkdir(p);
  return listTemplates();
}

export async function renameTemplate(
  name: unknown,
  newName: unknown,
): Promise<string[]> {
  const from = validateName(name);
  const to = validateName(newName);
  if (from === to) return listTemplates();
  const fromPath = join(TEMPLATES_DIR, from);
  const toPath = join(TEMPLATES_DIR, to);
  if (!pathExistsNoFollow(fromPath)) throw new Error(`模板不存在: ${from}`);
  if (pathExistsNoFollow(toPath)) throw new Error(`已存在同名模板: ${to}`);
  await rename(fromPath, toPath);
  return listTemplates();
}

export async function deleteTemplate(name: unknown): Promise<string[]> {
  const n = validateName(name);
  const p = join(TEMPLATES_DIR, n);
  if (pathExistsNoFollow(p)) {
    await rm(p, { recursive: true, force: true });
  }
  return listTemplates();
}

export async function createNode(params: {
  template: string;
  relPath: string;
  kind: "file" | "dir";
  name: unknown;
}): Promise<void> {
  const name = validateName(params?.name);
  const base = join(TEMPLATES_DIR, validateName(params?.template));
  const parent = safeJoin(base, params?.relPath);
  assertNoSymlinkAncestors(base, params?.relPath);
  const p = join(parent, name);
  if (pathExistsNoFollow(p)) throw new Error(`已存在同名内容: ${name}`);
  if (params?.kind === "dir") {
    await mkdir(p);
  } else {
    await writeFile(p, "", { flag: "wx" });
  }
}

export async function renameNode(params: {
  template: string;
  relPath: string;
  newName: unknown;
}): Promise<void> {
  const newName = validateName(params?.newName);
  const base = join(TEMPLATES_DIR, validateName(params?.template));
  const from = safeJoin(base, params?.relPath);
  assertNoSymlinkAncestors(base, params?.relPath, true);
  const to = join(dirname(from), newName);
  if (from === to) return;
  if (!pathExistsNoFollow(from)) throw new Error("内容不存在");
  if (pathExistsNoFollow(to)) throw new Error(`已存在同名内容: ${newName}`);
  await rename(from, to);
}

export async function deleteNode(params: {
  template: string;
  relPath: string;
}): Promise<void> {
  const base = join(TEMPLATES_DIR, validateName(params?.template));
  const p = safeJoin(base, params?.relPath);
  if (p === base) throw new Error("不能删除模板根目录");
  assertNoSymlinkAncestors(base, params?.relPath, true);
  if (pathExistsNoFollow(p)) {
    await rm(p, { recursive: true, force: true });
  }
}

// ── 链接检查与创建 ─────────────────────────────────────────────

export interface LinkCheckResult {
  status: "ok" | "same" | "conflict-symlink" | "conflict-real";
  sourcePath: string;
  sourceLabel: string;
  targetDir: string;
  targetLabel: string;
  name: string;
  targetPath: string;
  existingTarget?: string;
  suggestedName?: string;
}

function pathsSame(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

async function findFreeName(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!pathExistsNoFollow(join(dir, candidate))) return candidate;
  }
  throw new Error("无法找到可用名称");
}

export async function checkLink(
  source: LinkSource,
  target: LinkTarget,
  workspaces: string[],
): Promise<LinkCheckResult> {
  const sourcePath = sourcePathOf(source);
  const targetDir = targetDirOf(target, workspaces);
  const name = basename(sourcePath);
  const targetPath = join(targetDir, name);
  const base = {
    sourcePath,
    sourceLabel: sourceLabelOf(source, name),
    targetDir,
    targetLabel: targetLabelOf(target),
    name,
    targetPath,
  };

  let st;
  try {
    st = await lstat(targetPath);
  } catch {
    return { ...base, status: "ok" };
  }

  if (st.isSymbolicLink()) {
    let raw: string | null = null;
    try {
      raw = await readlink(targetPath);
    } catch {
      raw = null;
    }
    let resolvedTarget: string | undefined;
    if (raw) {
      resolvedTarget = isAbsolute(raw) ? raw : resolve(targetDir, raw);
      if (pathsSame(resolvedTarget, sourcePath)) {
        return { ...base, status: "same", existingTarget: resolvedTarget };
      }
    }
    return {
      ...base,
      status: "conflict-symlink",
      ...(resolvedTarget !== undefined
        ? { existingTarget: resolvedTarget }
        : {}),
      suggestedName: await findFreeName(targetDir, name),
    };
  }

  return {
    ...base,
    status: "conflict-real",
    suggestedName: await findFreeName(targetDir, name),
  };
}

export async function createLink(
  source: LinkSource,
  target: LinkTarget,
  workspaces: string[],
  opts?: { name?: string; replace?: boolean },
): Promise<string> {
  const sourcePath = sourcePathOf(source);
  const targetDir = targetDirOf(target, workspaces);
  const finalName = opts?.name ? validateName(opts.name) : basename(sourcePath);
  const finalPath = join(targetDir, finalName);

  let existing;
  try {
    existing = await lstat(finalPath);
  } catch {
    existing = null;
  }

  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`"${finalName}" 已存在且不是软链接，已拒绝覆盖`);
    }
    if (opts?.replace) {
      await unlink(finalPath);
    } else {
      let raw: string | null = null;
      try {
        raw = await readlink(finalPath);
      } catch {
        raw = null;
      }
      const resolved = raw
        ? isAbsolute(raw)
          ? raw
          : resolve(targetDir, raw)
        : null;
      if (resolved && pathsSame(resolved, sourcePath)) return finalPath;
      throw new Error(`"${finalName}" 已存在`);
    }
  }

  const st = await stat(sourcePath);
  await symlink(sourcePath, finalPath, st.isDirectory() ? "dir" : "file");
  return finalPath;
}

export async function removeLinkAt(
  workspace: string,
  relPath: string,
  workspaces: string[],
): Promise<void> {
  if (!workspaces.includes(workspace)) {
    throw new Error("workspace 不在列表中");
  }
  if (typeof relPath !== "string" || relPath === "") {
    throw new Error("缺少链接路径");
  }
  const p = safeJoin(workspace, relPath);
  const st = await lstat(p);
  if (!st.isSymbolicLink()) {
    throw new Error("目标不是软链接，已拒绝删除");
  }
  await unlink(p);
}

export interface LinkInfo {
  isLink: boolean;
  linkTarget?: string;
  resolvedTarget?: string;
  template?: string;
  templateRelPath?: string;
}

export async function getLinkInfoAt(
  workspace: string,
  relPath: string,
  workspaces: string[],
): Promise<LinkInfo> {
  if (!workspaces.includes(workspace)) {
    throw new Error("workspace 不在列表中");
  }
  const p = safeJoin(workspace, relPath);
  let st;
  try {
    st = await lstat(p);
  } catch {
    return { isLink: false };
  }
  if (!st.isSymbolicLink()) return { isLink: false };

  let raw: string | null = null;
  try {
    raw = await readlink(p);
  } catch {
    raw = null;
  }
  const resolved = raw
    ? isAbsolute(raw)
      ? raw
      : resolve(dirname(p), raw)
    : undefined;

  let template: string | undefined;
  let templateRelPath: string | undefined;
  if (resolved) {
    const rel = relative(TEMPLATES_DIR, resolved);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      const parts = rel.split(sep);
      template = parts[0];
      templateRelPath = parts.slice(1).join("/");
    }
  }

  const info: LinkInfo = { isLink: true };
  if (raw !== null) info.linkTarget = raw;
  if (resolved !== undefined) info.resolvedTarget = resolved;
  if (template !== undefined) info.template = template;
  if (templateRelPath !== undefined) info.templateRelPath = templateRelPath;
  return info;
}

// ── 已挂载扫描（模板窗口第三栏）────────────────────────────────

export interface TemplateMountPoint {
  /** 来源模板名（链接目标在模板库内的第一段） */
  template: string;
  /** 模板内相对路径（"" = 模板根整体挂载） */
  sourceRel: string;
  /** 所属 workspace 绝对路径 */
  workspace: string;
  /** 链接在 workspace 内的相对路径 */
  linkRel: string;
  broken: boolean;
}

// 防御性上限：超大依赖/构建目录若未被忽略规则摘除，避免扫描无界
const MOUNT_SCAN_BUDGET = 50000;

export async function scanWorkspaceMounts(
  ws: string,
  isIgnoredDir?: (rel: string) => boolean,
): Promise<TemplateMountPoint[]> {
  const out: TemplateMountPoint[] = [];
  const budget = { n: MOUNT_SCAN_BUDGET };
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (budget.n <= 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget.n-- <= 0) return;
      if (e.name === ".DS_Store") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        const full = join(dir, e.name);
        let raw: string;
        try {
          raw = await readlink(full);
        } catch {
          continue;
        }
        const resolved = isAbsolute(raw) ? raw : resolve(dir, raw);
        const inside = relative(TEMPLATES_DIR, resolved);
        if (!inside || inside.startsWith("..") || isAbsolute(inside)) continue;
        const segments = inside.split(sep).filter(Boolean);
        const template = segments[0];
        if (!template) continue;
        out.push({
          template,
          sourceRel: segments.slice(1).join("/"),
          workspace: ws,
          linkRel: childRel,
          broken: !existsSync(resolved),
        });
      } else if (e.isDirectory()) {
        if (isIgnoredDir?.(childRel)) continue;
        await walk(join(dir, e.name), childRel);
      }
    }
  };
  await walk(ws, "");
  return out;
}

export async function listMounts(
  ctx: TemplatesContext,
  template: string,
): Promise<TemplateMountPoint[]> {
  const ui = {
    ignoredFiles: ctx.getPref("ignoredFiles"),
    ignoreCase: ctx.getPref("ignoreCase"),
  };
  const filter = createFileFilter(resolveIgnorePatterns(ui), {
    ignorecase: resolveIgnoreCase(ui),
  });
  const isIgnoredDir = (rel: string) =>
    filter.isIgnored(rel) || filter.isIgnored(`${rel}/`);

  const all: TemplateMountPoint[] = [];
  for (const ws of ctx.workspaces()) {
    all.push(...(await scanWorkspaceMounts(ws, isIgnoredDir)));
  }
  const t = typeof template === "string" && template ? template : "";
  return t ? all.filter((m) => m.template === t) : all;
}

// ── 拖拽会话协调 ───────────────────────────────────────────────

let dragPayload: DragPayload | null = null;

function startDragSession(payload: unknown, ctx: TemplatesContext): void {
  const p = payload as Partial<DragPayload> | null;
  const template = validateName(p?.template);
  const relPath = typeof p?.relPath === "string" ? p.relPath : "";
  const path = sourcePathOf({ template, relPath });
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    isDir = false;
  }
  dragPayload = { template, relPath, name: basename(path), isDir };
  ctx.forwardToWebview("nav", "template-drag:start", dragPayload);
}

function endDragSession(ctx: TemplatesContext): void {
  dragPayload = null;
  ctx.forwardToWebview("nav", "template-drag:end");
}

// ── 挂载确认框（原生对话框）───────────────────────────────────

function dialogParent(
  event: IpcMainInvokeEvent | IpcMainEvent | null,
): BrowserWindow | null {
  if (event) {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) return win;
    } catch {
      // sender already destroyed
    }
  }
  return null;
}

async function promptAndMount(
  ctx: TemplatesContext,
  source: LinkSource,
  target: LinkTarget,
  parent: BrowserWindow | null,
): Promise<MountResult> {
  const win = parent ?? ctx.mainWindow();

  const workspaces = ctx.workspaces();
  let check: LinkCheckResult;
  try {
    check = await checkLink(source, target, workspaces);
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    // 建链成功后主动通知：nav 立即刷新目标目录，不等 watcher 时序
    const linkAndNotify = async (opts?: {
      name?: string;
      replace?: boolean;
    }): Promise<string> => {
      const p = await createLink(source, target, workspaces, opts);
      emitFsChange([{ dirPath: dirname(p), changes: [{ path: p, type: 1 }] }]);
      notifyMountsChanged();
      return p;
    };

    if (check.status === "ok") {
      if (ctx.getPref(SKIP_CONFIRM_PREF) === true) {
        const p = await linkAndNotify();
        return { status: "created", path: p };
      }
      const { response, checkboxChecked } = await showMessage(win, {
        type: "question",
        message: `Create symlink in ${check.targetLabel}?`,
        detail: `${check.name}\n  → ${check.sourceLabel}\n\n${check.sourcePath}\n  ↓\n${check.targetPath}`,
        buttons: ["Cancel", "Create"],
        defaultId: 1,
        cancelId: 0,
        checkboxLabel: "Don't ask again",
      });
      if (checkboxChecked) ctx.setPref(SKIP_CONFIRM_PREF, true);
      if (response !== 1) return { status: "cancelled" };
      const p = await linkAndNotify();
      return { status: "created", path: p };
    }

    if (check.status === "same") {
      await showMessage(win, {
        type: "info",
        message: "Already mounted",
        detail: `${check.targetLabel}/${check.name} already links to\n${check.sourceLabel}.`,
        buttons: ["OK"],
      });
      return { status: "already", path: check.targetPath };
    }

    if (check.status === "conflict-symlink") {
      const suggested = check.suggestedName ?? check.name;
      const { response } = await showMessage(win, {
        type: "warning",
        message: `${check.name} already exists in ${check.targetLabel}`,
        detail: `It links to:\n${check.existingTarget ?? "(unknown target)"}\n\nReplace it with a link to:\n${check.sourceLabel}`,
        buttons: ["Cancel", `Rename to ${suggested}`, "Replace"],
        defaultId: 2,
        cancelId: 0,
      });
      if (response === 2) {
        const p = await linkAndNotify({ replace: true });
        return { status: "replaced", path: p };
      }
      if (response === 1) {
        const p = await linkAndNotify({ name: suggested });
        return { status: "renamed", path: p };
      }
      return { status: "cancelled" };
    }

    // conflict-real：保护用户真实内容，只允许换名
    const suggested = check.suggestedName ?? check.name;
    const { response } = await showMessage(win, {
      type: "warning",
      message: `${check.name} already exists in ${check.targetLabel}`,
      detail:
        "The existing item is a real file or folder, not a link created by this app.\nTo protect your data, it will not be replaced.",
      buttons: ["Cancel", `Add as ${suggested}`],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) return { status: "cancelled" };
    const p = await linkAndNotify({ name: suggested });
    return { status: "renamed", path: p };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── 外部编辑器打开（遵循现有编辑器配置）───────────────────────

function openInConfiguredEditor(
  ctx: TemplatesContext,
  filePath: string,
  isDir: boolean,
): void {
  const defaultEditor =
    (ctx.getPref("externalEditor") as string | undefined) ?? "intellij-idea";
  const useExternal = ctx.getPref("useExternalEditor") === true;

  if (isDir) {
    if (useExternal) {
      openWorkspaceInEditor(defaultEditor, filePath);
    } else {
      void shell.openPath(filePath);
    }
    return;
  }

  const groups = ctx.getPref("externalEditorFileTypes");
  if (Array.isArray(groups)) {
    const dot = filePath.lastIndexOf(".");
    const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
    for (const g of groups as Array<{
      patterns?: string[];
      editorId?: string;
    }>) {
      if (!Array.isArray(g?.patterns)) continue;
      if (g.patterns.some((pat) => matchesPattern(ext, pat))) {
        if (g.editorId === "system-app") {
          void shell.openPath(filePath);
          return;
        }
        if (g.editorId) {
          openFileInEditor(g.editorId, filePath);
          return;
        }
      }
    }
  }

  if (useExternal) {
    openFileInEditor(defaultEditor, filePath);
  } else {
    void shell.openPath(filePath);
  }
}

// ── 模板视图（主窗口内嵌，与 viewer 同址；shell 负责创建/显隐）──

// registerTemplatesIpc 时注入；remote flavor 不注册模板能力,保持 null(转发为 no-op)
let activeCtx: TemplatesContext | null = null;

/** 打开模板视图；已打开时由 shell 聚焦 */
function openTemplatesView(ctx: TemplatesContext): void {
  ctx.forwardToWebview("templates", "templates:open-view", null);
}

/** 转发到 shell 内嵌的模板视图；视图未打开时由 shell 丢弃 */
function forwardToTemplates(channel: string, payload: unknown): void {
  activeCtx?.forwardToWebview("templates", channel, payload);
}

/** 偏好变化转发给模板视图（locale 切换实时生效） */
export function notifyTemplatesPrefChanged(key: string, value: unknown): void {
  activeCtx?.forwardToWebview("templates", "pref:changed", key, value);
}

/** 挂载关系变化（建链/卸载/源节点改名删除）后通知模板视图刷新已挂载栏 */
function notifyMountsChanged(): void {
  forwardToTemplates("templates:mounts-changed", null);
}

async function revealSourceInTemplates(
  ctx: TemplatesContext,
  workspace: string,
  relPath: string,
): Promise<void> {
  const info = await getLinkInfoAt(workspace, relPath, ctx.workspaces());
  if (!info.isLink || !info.template) {
    throw new Error("该条目不是指向模板库的软链接");
  }
  openTemplatesView(ctx);
  forwardToTemplates("templates:reveal", {
    template: info.template,
    relPath: info.templateRelPath ?? "",
  });
}

// ── IPC 注册 ───────────────────────────────────────────────────

export function registerTemplatesIpc(ctx: TemplatesContext): void {
  activeCtx = ctx;

  // 模板视图内的关闭控件(X / Esc)请求关闭内嵌视图
  bindIpc("templates:close-view", "on", () => {
    forwardToTemplates("templates:close", null);
  });

  bindIpc("templates:list", "handle", () => listTemplates());

  bindIpc("templates:tree", "handle", (_event, params) => {
    const p = params as { template: string; relPath?: string };
    return readTemplateDir(p?.template, p?.relPath ?? "");
  });

  bindIpc("templates:create", "handle", (_event, name: unknown) =>
    createTemplate(name),
  );

  bindIpc("templates:rename", "handle", (_event, params) => {
    const p = params as { name: string; newName: string };
    return renameTemplate(p?.name, p?.newName);
  });

  bindIpc("templates:delete", "handle", async (event, name: unknown) => {
    const n = validateName(name);
    const parent = dialogParent(event) ?? ctx.mainWindow();
    const { response } = await showMessage(parent, {
      type: "warning",
      message: `Delete template "${n}"?`,
      detail:
        "The whole template folder will be permanently removed. This cannot be undone.",
      buttons: ["Cancel", "Delete"],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) return { cancelled: true };
    const templates = await deleteTemplate(n);
    return { templates };
  });

  bindIpc("templates:create-node", "handle", (_event, params) =>
    createNode(
      params as {
        template: string;
        relPath: string;
        kind: "file" | "dir";
        name: string;
      },
    ),
  );

  bindIpc("templates:rename-node", "handle", async (_event, params) => {
    await renameNode(
      params as { template: string; relPath: string; newName: string },
    );
    // 源节点改名可能使既有挂载变断链，刷新已挂载栏
    notifyMountsChanged();
  });

  bindIpc("templates:delete-node", "handle", async (event, params) => {
    const p = params as { template: string; relPath: string };
    const parent = dialogParent(event) ?? ctx.mainWindow();
    const { response } = await showMessage(parent, {
      type: "warning",
      message: `Delete "${basename(p?.relPath ?? "")}"?`,
      detail: "This cannot be undone.",
      buttons: ["Cancel", "Delete"],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) return { cancelled: true };
    await deleteNode(p);
    notifyMountsChanged();
    return { ok: true };
  });

  bindIpc("templates:open-external", "handle", (_event, params) => {
    const p = params as {
      template: string;
      relPath?: string;
      isDir?: boolean;
    };
    const filePath = sourcePathOf({
      template: p?.template,
      relPath: p?.relPath ?? "",
    });
    openInConfiguredEditor(ctx, filePath, !!p?.isDir);
    return { ok: true };
  });

  bindIpc("templates:reveal-path", "handle", (_event, params) => {
    const p = params as { template?: string; relPath?: string };
    if (p?.template) {
      const path = sourcePathOf({
        template: p.template,
        relPath: p?.relPath ?? "",
      });
      shell.showItemInFolder(path);
    } else {
      void ensureTemplatesDir().then(() => {
        shell.showItemInFolder(TEMPLATES_DIR);
      });
    }
    return { ok: true };
  });

  bindIpc("templates:drag-start", "on", (_event, payload) => {
    try {
      startDragSession(payload, ctx);
    } catch (err) {
      console.warn("[templates] drag-start failed:", err);
    }
  });

  bindIpc("templates:drag-end", "on", () => {
    endDragSession(ctx);
  });

  bindIpc("templates:drop-mount", "handle", async (event, params) => {
    const p = params as { workspace: string; relPath?: string };
    const payload = dragPayload;
    if (!payload) {
      return { status: "error", message: "没有进行中的模板拖拽" };
    }
    const result = await promptAndMount(
      ctx,
      { template: payload.template, relPath: payload.relPath },
      { workspace: p?.workspace, relPath: p?.relPath ?? "" },
      dialogParent(event),
    );
    // 放置落定即结束会话（nav 侧据 template-drag:end 退出接收态）
    endDragSession(ctx);
    return result;
  });

  bindIpc("templates:mount-to", "handle", async (event, params) => {
    const p = params as {
      source: { template: string; relPath?: string };
      target: { workspace: string; relPath?: string };
    };
    return promptAndMount(
      ctx,
      { template: p?.source?.template, relPath: p?.source?.relPath ?? "" },
      { workspace: p?.target?.workspace, relPath: p?.target?.relPath ?? "" },
      dialogParent(event),
    );
  });

  bindIpc("templates:workspaces", "handle", () => ctx.workspaces());

  bindIpc("templates:link-info", "handle", (_event, params) => {
    const p = params as { workspace: string; relPath: string };
    return getLinkInfoAt(p?.workspace, p?.relPath, ctx.workspaces());
  });

  bindIpc("templates:remove-link", "handle", async (event, params) => {
    const p = params as { workspace: string; relPath: string };
    const parent = dialogParent(event) ?? ctx.mainWindow();
    const { response } = await showMessage(parent, {
      type: "warning",
      message: `Remove link "${basename(p?.relPath ?? "")}"?`,
      detail:
        "The symlink is removed from the workspace. The template content is not affected.",
      buttons: ["Cancel", "Remove"],
      defaultId: 1,
      cancelId: 0,
    });
    if (response !== 1) return { cancelled: true };
    await removeLinkAt(p?.workspace, p?.relPath, ctx.workspaces());
    const abs = join(p.workspace, p?.relPath ?? "");
    emitFsChange([
      { dirPath: dirname(abs), changes: [{ path: abs, type: 3 }] },
    ]);
    notifyMountsChanged();
    return { ok: true };
  });

  bindIpc("templates:reveal-source", "handle", (_event, params) => {
    const p = params as { workspace: string; relPath: string };
    return revealSourceInTemplates(ctx, p?.workspace, p?.relPath);
  });

  bindIpc("templates:list-mounts", "handle", (_event, params) => {
    const p = params as { template?: string };
    return listMounts(ctx, typeof p?.template === "string" ? p.template : "");
  });

  bindIpc("templates:reveal-in-workspace", "handle", (_event, params) => {
    const p = params as { workspace?: string; relPath?: string };
    const ws = typeof p?.workspace === "string" ? p.workspace : "";
    if (!ws || !ctx.workspaces().includes(ws)) {
      throw new Error("workspace 不在列表中");
    }
    const rel = typeof p?.relPath === "string" ? p.relPath : "";
    shell.showItemInFolder(rel ? safeJoin(ws, rel) : ws);
    return { ok: true };
  });
}
