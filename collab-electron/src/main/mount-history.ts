import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { COLLAB_DIR, TEMPLATES_DIR } from "./paths";
import { atomicWriteFileSync } from "./files";
import { bindIpc } from "./ipc-registry";
import {
  createLink,
  listMounts,
  removeLinkAt,
  type TemplateMountPoint,
  type TemplatesContext,
} from "./templates";

// ── 数据模型 ──────────────────────────────────────────────────

export interface MountHistoryRecord {
  workspace: string;
  linkRel: string;
  template: string;
  sourceRel: string;
  broken: boolean;
}

export type MountHistoryKind = "auto" | "named" | "restore";

export interface MountHistoryPoint {
  id: string;
  ts: number;
  kind: MountHistoryKind;
  label?: string;
  op: string;
  mounts: MountHistoryRecord[];
}

interface MountHistoryFile {
  version: 1;
  points: MountHistoryPoint[];
}

/** 自动点上限；named / restore 点永久保留 */
const MAX_AUTO_POINTS = 500;

function historyFilePath(): string {
  return join(COLLAB_DIR, "mount-history.json");
}

export function loadHistory(): MountHistoryFile {
  try {
    const raw = readFileSync(historyFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<MountHistoryFile>;
    if (parsed && Array.isArray(parsed.points)) {
      return { version: 1, points: parsed.points as MountHistoryPoint[] };
    }
  } catch {
    // 首次使用 / 文件损坏：从空历史开始
  }
  return { version: 1, points: [] };
}

function saveHistory(file: MountHistoryFile): void {
  atomicWriteFileSync(historyFilePath(), JSON.stringify(file, null, 2));
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function prune(file: MountHistoryFile): void {
  let autoCount = 0;
  for (const p of file.points) if (p.kind === "auto") autoCount++;
  let excess = autoCount - MAX_AUTO_POINTS;
  if (excess <= 0) return;
  file.points = file.points.filter((p) => {
    if (excess > 0 && p.kind === "auto") {
      excess--;
      return false;
    }
    return true;
  });
}

function notifyHistoryChanged(ctx: TemplatesContext): void {
  ctx.forwardToWebview("templates", "templates:history-changed", null);
}

// 写操作串行化：记录/恢复可能被 fire-and-forget 触发，避免 load-append-save 竞态
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run;
}

// ── 快照 ─────────────────────────────────────────────────────

async function snapshotMounts(
  ctx: TemplatesContext,
): Promise<MountHistoryRecord[]> {
  const mounts: TemplateMountPoint[] = await listMounts(ctx, "");
  return mounts.map((m) => ({
    workspace: m.workspace,
    linkRel: m.linkRel,
    template: m.template,
    sourceRel: m.sourceRel,
    broken: m.broken,
  }));
}

function keyOf(r: MountHistoryRecord): string {
  return JSON.stringify([r.workspace, r.linkRel]);
}

function sameTarget(a: MountHistoryRecord, b: MountHistoryRecord): boolean {
  return a.template === b.template && a.sourceRel === b.sourceRel;
}

// ── 记录 ─────────────────────────────────────────────────────

async function appendPoint(
  ctx: TemplatesContext,
  partial: { kind: MountHistoryKind; label?: string; op: string },
): Promise<MountHistoryPoint> {
  const mounts = await snapshotMounts(ctx);
  const point: MountHistoryPoint = {
    id: newId(),
    ts: Date.now(),
    kind: partial.kind,
    ...(partial.label !== undefined ? { label: partial.label } : {}),
    op: partial.op,
    mounts,
  };
  const file = loadHistory();
  file.points.push(point);
  prune(file);
  saveHistory(file);
  notifyHistoryChanged(ctx);
  return point;
}

/** 挂载/取消成功后追加自动点（fire-and-forget 安全，内部串行化） */
export function recordMountPoint(
  ctx: TemplatesContext,
  op: string,
): Promise<MountHistoryPoint> {
  return enqueueWrite(() => appendPoint(ctx, { kind: "auto", op }));
}

/** 手动命名备份：扫描当前状态存为命名点 */
export async function createNamedBackup(
  ctx: TemplatesContext,
  label: unknown,
): Promise<MountHistoryPoint> {
  const name = typeof label === "string" ? label.trim() : "";
  if (!name) throw new Error("备份名称不能为空");
  return enqueueWrite(() =>
    appendPoint(ctx, { kind: "named", label: name, op: `备份「${name}」` }),
  );
}

/** 按当前状态补记一个自动点（外部变更检测的「补记」入口） */
export function recordCurrent(
  ctx: TemplatesContext,
  op: unknown,
): Promise<MountHistoryPoint> {
  const text = typeof op === "string" && op.trim() ? op.trim() : "记录当前状态";
  return enqueueWrite(() => appendPoint(ctx, { kind: "auto", op: text }));
}

export async function renamePoint(
  ctx: TemplatesContext,
  id: unknown,
  label: unknown,
): Promise<MountHistoryPoint> {
  const pointId = typeof id === "string" ? id : "";
  const name = typeof label === "string" ? label.trim() : "";
  if (!name) throw new Error("备份名称不能为空");
  return enqueueWrite(async () => {
    const file = loadHistory();
    const point = file.points.find((p) => p.id === pointId);
    if (!point) throw new Error("状态点不存在");
    if (point.kind !== "named") throw new Error("只能重命名命名备份");
    point.label = name;
    point.op = `备份「${name}」`;
    saveHistory(file);
    notifyHistoryChanged(ctx);
    return point;
  });
}

export function deletePoint(ctx: TemplatesContext, id: unknown): Promise<void> {
  const pointId = typeof id === "string" ? id : "";
  return enqueueWrite(async () => {
    const file = loadHistory();
    const idx = file.points.findIndex((p) => p.id === pointId);
    if (idx < 0) throw new Error("状态点不存在");
    if (file.points[idx]!.kind !== "named") throw new Error("只能删除命名备份");
    file.points.splice(idx, 1);
    saveHistory(file);
    notifyHistoryChanged(ctx);
  });
}

// ── 历史列表 ─────────────────────────────────────────────────

export interface HistoryListPayload {
  /** 新 → 旧 */
  points: MountHistoryPoint[];
  /** 当前磁盘与最新状态点的不一致条目数（外部变更检测） */
  driftCount: number;
}

function diffCount(a: MountHistoryRecord[], b: MountHistoryRecord[]): number {
  const A = new Map(a.map((r) => [keyOf(r), r]));
  const B = new Map(b.map((r) => [keyOf(r), r]));
  let n = 0;
  for (const [k, r] of A) {
    const o = B.get(k);
    if (!o || !sameTarget(o, r)) n++;
  }
  for (const k of B.keys()) if (!A.has(k)) n++;
  return n;
}

export async function getHistory(
  ctx: TemplatesContext,
): Promise<HistoryListPayload> {
  const file = loadHistory();
  const points = [...file.points].reverse();
  let driftCount = 0;
  const newest = file.points.at(-1);
  if (newest) {
    const current = await snapshotMounts(ctx);
    driftCount = diffCount(newest.mounts, current);
  }
  return { points, driftCount };
}

// ── 差异恢复 ─────────────────────────────────────────────────

export type RestoreSkipReason =
  | "workspace-missing"
  | "source-missing"
  | "real-content";

export interface HistoryRestoreDiff {
  missing: MountHistoryRecord[];
  extra: MountHistoryRecord[];
  retarget: Array<{ current: MountHistoryRecord; target: MountHistoryRecord }>;
  skipped: Array<{ record: MountHistoryRecord; reason: RestoreSkipReason }>;
}

/** 校验一条记录能否建链：workspace 有效、模板源存在、目标位不是真实内容 */
function checkCreatable(
  ctx: TemplatesContext,
  record: MountHistoryRecord,
): RestoreSkipReason | null {
  if (!ctx.workspaces().includes(record.workspace)) return "workspace-missing";
  const source = join(TEMPLATES_DIR, record.template, record.sourceRel);
  if (!existsSync(source)) return "source-missing";
  const finalPath = join(record.workspace, record.linkRel);
  try {
    const st = lstatSync(finalPath);
    if (!st.isSymbolicLink()) return "real-content";
  } catch {
    // 目标不存在 = 可创建
  }
  return null;
}

async function findPoint(id: string): Promise<MountHistoryPoint> {
  const file = loadHistory();
  const point = file.points.find((p) => p.id === id);
  if (!point) throw new Error("状态点不存在");
  return point;
}

async function computeDiff(
  ctx: TemplatesContext,
  target: MountHistoryRecord[],
): Promise<HistoryRestoreDiff> {
  const current = await snapshotMounts(ctx);
  const currentByKey = new Map(current.map((r) => [keyOf(r), r]));
  const targetByKey = new Map(target.map((r) => [keyOf(r), r]));
  const diff: HistoryRestoreDiff = {
    missing: [],
    extra: [],
    retarget: [],
    skipped: [],
  };
  for (const r of target) {
    const cur = currentByKey.get(keyOf(r));
    if (!cur) {
      const reason = checkCreatable(ctx, r);
      if (reason) diff.skipped.push({ record: r, reason });
      else diff.missing.push(r);
      continue;
    }
    if (!sameTarget(cur, r)) {
      const reason = checkCreatable(ctx, r);
      if (reason) diff.skipped.push({ record: r, reason });
      else diff.retarget.push({ current: cur, target: r });
    }
  }
  for (const r of current) {
    if (!targetByKey.has(keyOf(r))) diff.extra.push(r);
  }
  return diff;
}

export async function previewRestore(
  ctx: TemplatesContext,
  id: unknown,
): Promise<HistoryRestoreDiff> {
  const point = await findPoint(typeof id === "string" ? id : "");
  return computeDiff(ctx, point.mounts);
}

export interface HistoryRestoreSummary {
  created: number;
  removed: number;
  retargeted: number;
  failed: Array<{ record: MountHistoryRecord; message: string }>;
  skipped: HistoryRestoreDiff["skipped"];
}

function linkTargetOf(record: MountHistoryRecord): {
  workspace: string;
  relPath: string;
} {
  const parent = dirname(record.linkRel);
  return { workspace: record.workspace, relPath: parent === "." ? "" : parent };
}

async function createOne(
  ctx: TemplatesContext,
  record: MountHistoryRecord,
  opts?: { replace?: boolean },
): Promise<void> {
  await createLink(
    { template: record.template, relPath: record.sourceRel },
    linkTargetOf(record),
    ctx.workspaces(),
    {
      name: basename(record.linkRel),
      ...(opts?.replace ? { replace: true } : {}),
    },
  );
}

export function applyRestore(
  ctx: TemplatesContext,
  id: unknown,
): Promise<HistoryRestoreSummary> {
  const pointId = typeof id === "string" ? id : "";
  return enqueueWrite(async () => {
    const point = await findPoint(pointId);
    const diff = await computeDiff(ctx, point.mounts);
    const summary: HistoryRestoreSummary = {
      created: 0,
      removed: 0,
      retargeted: 0,
      failed: [],
      skipped: diff.skipped,
    };

    // 先移除 / 替换，再创建，避免同名冲突
    for (const r of diff.extra) {
      try {
        await removeLinkAt(r.workspace, r.linkRel, ctx.workspaces());
        summary.removed++;
      } catch (e) {
        summary.failed.push({ record: r, message: errText(e) });
      }
    }
    for (const { current, target } of diff.retarget) {
      try {
        await removeLinkAt(
          current.workspace,
          current.linkRel,
          ctx.workspaces(),
        );
        await createOne(ctx, target, { replace: true });
        summary.retargeted++;
      } catch (e) {
        summary.failed.push({ record: target, message: errText(e) });
      }
    }
    for (const r of diff.missing) {
      try {
        await createOne(ctx, r);
        summary.created++;
      } catch (e) {
        summary.failed.push({ record: r, message: errText(e) });
      }
    }

    // 恢复本身也入历史（restore 点），可再回溯
    await appendPoint(ctx, {
      kind: "restore",
      op: `恢复至「${point.label ?? point.op}」`,
    });
    return summary;
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "Unknown error");
}

// ── IPC ──────────────────────────────────────────────────────

export function bindHistoryIpc(ctx: TemplatesContext): void {
  bindIpc("templates:history-list", "handle", () => getHistory(ctx));
  bindIpc("templates:history-create-backup", "handle", (_event, params) => {
    const p = params as { label?: unknown };
    return createNamedBackup(ctx, p?.label);
  });
  bindIpc("templates:history-record-current", "handle", (_event, params) => {
    const p = params as { op?: unknown };
    return recordCurrent(ctx, p?.op);
  });
  bindIpc("templates:history-rename", "handle", (_event, params) => {
    const p = params as { id?: unknown; label?: unknown };
    return renamePoint(ctx, p?.id, p?.label);
  });
  bindIpc("templates:history-delete", "handle", (_event, params) => {
    const p = params as { id?: unknown };
    return deletePoint(ctx, p?.id);
  });
  bindIpc("templates:history-preview-restore", "handle", (_event, params) => {
    const p = params as { id?: unknown };
    return previewRestore(ctx, p?.id);
  });
  bindIpc("templates:history-apply-restore", "handle", (_event, params) => {
    const p = params as { id?: unknown };
    return applyRestore(ctx, p?.id);
  });
}
