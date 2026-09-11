import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClockCounterClockwise,
  PencilSimple,
  Star,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { useT, type TplKey } from "./i18n";

interface HistoryMount {
  template: string;
  sourceRel: string;
  workspace: string;
  linkRel: string;
  broken: boolean;
}

interface HistoryPoint {
  id: string;
  ts: number;
  kind: "auto" | "named" | "restore";
  label?: string;
  op: string;
  mounts: HistoryMount[];
}

interface HistoryPayload {
  points: HistoryPoint[];
  driftCount: number;
}

type SkipReason = "workspace-missing" | "source-missing" | "real-content";

interface RestoreDiff {
  missing: HistoryMount[];
  extra: HistoryMount[];
  retarget: Array<{ current: HistoryMount; target: HistoryMount }>;
  skipped: Array<{ record: HistoryMount; reason: SkipReason }>;
}

interface RestoreSummary {
  created: number;
  removed: number;
  retargeted: number;
  failed: Array<{ record: HistoryMount; message: string }>;
  skipped: RestoreDiff["skipped"];
}

interface PromptInput {
  titleKey: TplKey;
  placeholderKey?: TplKey;
  initial: string;
  submitLabelKey?: TplKey;
  onSubmit: (value: string) => Promise<string | null>;
}

type View =
  | { mode: "list" }
  | { mode: "preview"; pointId: string; diff: RestoreDiff }
  | { mode: "result"; summary: RestoreSummary };

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "Unknown error");
  return msg.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function baseName(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? `${hh}:${mm}`
    : `${d.getMonth() + 1}-${d.getDate()} ${hh}:${mm}`;
}

export default function HistoryPanel({
  onClose,
  onRequestInput,
}: {
  onClose: () => void;
  onRequestInput: (state: PromptInput) => void;
}) {
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const t = useT();

  const load = useCallback(async () => {
    try {
      const r = (await window.api.templatesHistoryList()) as HistoryPayload;
      setData(
        r && Array.isArray(r.points)
          ? { points: r.points, driftCount: r.driftCount ?? 0 }
          : { points: [], driftCount: 0 },
      );
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => window.api.onTemplatesHistoryChanged(() => void load()),
    [load],
  );

  const points = useMemo(() => data?.points ?? [], [data]);
  const selected = useMemo(
    () => points.find((p) => p.id === selectedId) ?? null,
    [points, selectedId],
  );

  // 列表刷新后选中点被删 / 已淘汰 → 回到列表态
  useEffect(() => {
    if (data && selectedId && !points.some((p) => p.id === selectedId)) {
      setSelectedId(null);
      setView({ mode: "list" });
    }
  }, [data, points, selectedId]);

  // Esc：预览 / 结果层级返回列表，列表态关闭面板（模态框在上时优先让位）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".modal-overlay")) return;
      if (view.mode !== "list") {
        setView({ mode: "list" });
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, onClose]);

  const createBackup = () => {
    onRequestInput({
      titleKey: "history.newBackup",
      placeholderKey: "history.backupName",
      initial: points.length === 0 ? t("history.baseline") : "",
      submitLabelKey: "dialog.create",
      onSubmit: async (value) => {
        try {
          await window.api.templatesHistoryCreateBackup({ label: value });
          return null;
        } catch (e) {
          return errText(e);
        }
      },
    });
  };

  const renameBackup = (p: HistoryPoint) => {
    onRequestInput({
      titleKey: "history.renameBackup",
      initial: p.label ?? "",
      submitLabelKey: "dialog.ok",
      onSubmit: async (value) => {
        try {
          await window.api.templatesHistoryRename({ id: p.id, label: value });
          return null;
        } catch (e) {
          return errText(e);
        }
      },
    });
  };

  const recordCurrent = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.templatesHistoryRecordCurrent({
        op: t("history.driftOp"),
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const openPreview = async (p: HistoryPoint) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const diff = (await window.api.templatesHistoryPreviewRestore({
        id: p.id,
      })) as RestoreDiff;
      setView({ mode: "preview", pointId: p.id, diff });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmRestore = async (pointId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const summary = (await window.api.templatesHistoryApplyRestore({
        id: pointId,
      })) as RestoreSummary;
      setView({ mode: "result", summary });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (p: HistoryPoint) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.templatesHistoryDelete({ id: p.id });
      setConfirmDeleteId(null);
      setSelectedId(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const srcLabel = useCallback(
    (r: HistoryMount) =>
      `${r.template}/${r.sourceRel || t("mounts.templateRoot")}`,
    [t],
  );

  const mountRow = (r: HistoryMount, key: number) => (
    <div
      key={key}
      className="history-mount-row"
      title={`${r.workspace}/${r.linkRel}`}
    >
      <span className="history-mount-src">{srcLabel(r)}</span>
      <span className="history-mount-arrow">→</span>
      <span className="history-mount-dst">{`${baseName(r.workspace)}/${r.linkRel}`}</span>
      {r.broken && (
        <span className="history-broken" title={t("link.broken")}>
          <Warning size={10} weight="bold" />
        </span>
      )}
    </div>
  );

  return (
    <div className="history-overlay" onClick={onClose}>
      <div className="modal history-panel" onClick={(e) => e.stopPropagation()}>
        {view.mode === "list" && (
          <>
            <div className="history-header">
              <h3>{t("history.title")}</h3>
              <button
                type="button"
                className="primary history-new-backup"
                onClick={createBackup}
              >
                {t("history.newBackup")}
              </button>
              <button
                type="button"
                className="mounts-refresh"
                title={t("toolbar.close")}
                onClick={onClose}
              >
                <X size={12} />
              </button>
            </div>

            {data !== null && data.driftCount > 0 && (
              <div className="history-drift">
                <Warning size={13} weight="bold" />
                <span className="history-drift-text">
                  {t("history.drift", { n: String(data.driftCount) })}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void recordCurrent()}
                >
                  {t("history.recordCurrent")}
                </button>
              </div>
            )}

            {error && <p className="modal-error">{error}</p>}

            {data === null ? (
              <div className="history-empty">{t("history.loading")}</div>
            ) : points.length === 0 ? (
              <div className="history-empty">
                <ClockCounterClockwise
                  size={30}
                  weight="thin"
                  style={{ opacity: 0.4 }}
                />
                <p>{t("history.empty")}</p>
                <p>{t("history.emptyHint")}</p>
                <button type="button" onClick={createBackup}>
                  {t("history.newBackup")}
                </button>
              </div>
            ) : (
              <>
                <div className="history-list">
                  {points.map((p) => (
                    <div
                      key={p.id}
                      className={`history-row${
                        p.id === selectedId ? " selected" : ""
                      }`}
                      onClick={() => {
                        setSelectedId(p.id);
                        setConfirmDeleteId(null);
                      }}
                    >
                      <span
                        className={`history-kind${
                          p.kind === "named" ? " named" : ""
                        }`}
                      >
                        {p.kind === "named" ? (
                          <Star size={11} weight="fill" />
                        ) : (
                          <span className="history-dot" />
                        )}
                      </span>
                      <span className="history-op" title={p.op}>
                        {p.op}
                      </span>
                      {p.kind === "named" && (
                        <span
                          className="history-row-actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {confirmDeleteId === p.id ? (
                            <>
                              <button
                                type="button"
                                className="danger"
                                disabled={busy}
                                onClick={() => void doDelete(p)}
                              >
                                {t("history.deleteConfirm")}
                              </button>
                              <button
                                type="button"
                                title={t("dialog.cancel")}
                                onClick={() => setConfirmDeleteId(null)}
                              >
                                <X size={11} />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                title={t("history.rename")}
                                onClick={() => renameBackup(p)}
                              >
                                <PencilSimple size={12} />
                              </button>
                              <button
                                type="button"
                                title={t("history.delete")}
                                onClick={() => setConfirmDeleteId(p.id)}
                              >
                                <Trash size={12} />
                              </button>
                            </>
                          )}
                        </span>
                      )}
                      <span className="history-time">{fmtTime(p.ts)}</span>
                    </div>
                  ))}
                </div>

                {selected && (
                  <div className="history-detail">
                    <div className="history-detail-head">
                      <span>
                        {t("history.mountsCount", {
                          n: String(selected.mounts.length),
                        })}
                      </span>
                      <span className="history-time">
                        {fmtTime(selected.ts)}
                      </span>
                    </div>
                    <div className="history-mounts">
                      {selected.mounts.length === 0 ? (
                        <div className="history-mount-row history-muted">
                          {t("history.noMounts")}
                        </div>
                      ) : (
                        selected.mounts.map(mountRow)
                      )}
                    </div>
                    <div className="modal-actions">
                      {selected.kind === "named" && (
                        <>
                          <button
                            type="button"
                            onClick={() => renameBackup(selected)}
                          >
                            <PencilSimple
                              size={11}
                              style={{ verticalAlign: "-1px" }}
                            />{" "}
                            {t("history.rename")}
                          </button>
                          {confirmDeleteId === selected.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                              >
                                {t("dialog.cancel")}
                              </button>
                              <button
                                type="button"
                                className="danger"
                                disabled={busy}
                                onClick={() => void doDelete(selected)}
                              >
                                {t("history.deleteConfirm")}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="danger"
                              onClick={() => setConfirmDeleteId(selected.id)}
                            >
                              <Trash
                                size={11}
                                style={{ verticalAlign: "-1px" }}
                              />{" "}
                              {t("history.delete")}
                            </button>
                          )}
                        </>
                      )}
                      <button
                        type="button"
                        className="primary"
                        disabled={busy}
                        onClick={() => void openPreview(selected)}
                      >
                        {t("history.restore")}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {view.mode === "preview" && (
          <PreviewView
            point={points.find((p) => p.id === view.pointId) ?? null}
            diff={view.diff}
            busy={busy}
            error={error}
            onBack={() => setView({ mode: "list" })}
            onConfirm={() => void confirmRestore(view.pointId)}
          />
        )}

        {view.mode === "result" && (
          <ResultView
            summary={view.summary}
            onDone={() => setView({ mode: "list" })}
          />
        )}
      </div>
    </div>
  );
}

// ── 预览（四分类） ──

function PreviewView({
  point,
  diff,
  busy,
  error,
  onBack,
  onConfirm,
}: {
  point: HistoryPoint | null;
  diff: RestoreDiff;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const actionable =
    diff.missing.length + diff.extra.length + diff.retarget.length;

  const row = (r: HistoryMount, key: number) => (
    <div
      key={key}
      className="history-mount-row"
      title={`${r.workspace}/${r.linkRel}`}
    >
      <span className="history-mount-src">
        {r.template}/{r.sourceRel || t("mounts.templateRoot")}
      </span>
      <span className="history-mount-arrow">→</span>
      <span className="history-mount-dst">
        {`${baseName(r.workspace)}/${r.linkRel}`}
      </span>
    </div>
  );

  const skippedRow = (
    s: { record: HistoryMount; reason: SkipReason },
    key: number,
  ) => (
    <div
      key={key}
      className="history-mount-row"
      title={`${s.record.workspace}/${s.record.linkRel}`}
    >
      <span className="history-mount-dst">
        {`${baseName(s.record.workspace)}/${s.record.linkRel}`}
      </span>
      <span className="history-reason">
        {t(`history.preview.reason.${s.reason}` as TplKey)}
      </span>
    </div>
  );

  return (
    <>
      <div className="history-header">
        <h3>{point ? point.op : t("history.restore")}</h3>
        {point && <span className="history-time">{fmtTime(point.ts)}</span>}
      </div>
      {error && <p className="modal-error">{error}</p>}
      <div className="history-preview">
        {actionable === 0 && (
          <p className="hint">{t("history.preview.allMatch")}</p>
        )}
        {diff.missing.length > 0 && (
          <div className="history-group">
            <div className="history-group-title missing">
              {t("history.preview.missing", {
                n: String(diff.missing.length),
              })}
            </div>
            {diff.missing.map(row)}
          </div>
        )}
        {diff.extra.length > 0 && (
          <div className="history-group">
            <div className="history-group-title extra">
              {t("history.preview.extra", { n: String(diff.extra.length) })}
            </div>
            {diff.extra.map(row)}
          </div>
        )}
        {diff.retarget.length > 0 && (
          <div className="history-group">
            <div className="history-group-title retarget">
              {t("history.preview.retarget", {
                n: String(diff.retarget.length),
              })}
            </div>
            {diff.retarget.map(({ current, target }, i) => (
              <div
                key={i}
                className="history-mount-row"
                title={`${target.workspace}/${target.linkRel}`}
              >
                <span className="history-mount-dst">
                  {`${baseName(target.workspace)}/${target.linkRel}`}
                </span>
                <span className="history-mount-src">
                  {current.template}/
                  {current.sourceRel || t("mounts.templateRoot")}
                </span>
                <span className="history-mount-arrow">→</span>
                <span className="history-mount-src">
                  {target.template}/
                  {target.sourceRel || t("mounts.templateRoot")}
                </span>
              </div>
            ))}
          </div>
        )}
        {diff.skipped.length > 0 && (
          <div className="history-group">
            <div className="history-group-title skipped">
              {t("history.preview.skipped", { n: String(diff.skipped.length) })}
            </div>
            {diff.skipped.map(skippedRow)}
          </div>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onBack}>
          {t("history.preview.back")}
        </button>
        {actionable > 0 && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={onConfirm}
          >
            {t("history.preview.confirm")}
          </button>
        )}
      </div>
    </>
  );
}

// ── 结果摘要 ──

function ResultView({
  summary,
  onDone,
}: {
  summary: RestoreSummary;
  onDone: () => void;
}) {
  const t = useT();
  const counts: Array<[TplKey, number]> = [
    ["history.result.created", summary.created],
    ["history.result.removed", summary.removed],
    ["history.result.retargeted", summary.retargeted],
    ["history.result.failed", summary.failed.length],
  ];
  return (
    <>
      <div className="history-header">
        <h3>{t("history.result.title")}</h3>
      </div>
      <div className="history-result">
        {counts.map(([key, n]) => (
          <div key={key} className="history-result-row">
            <span>{t(key, { n: String(n) })}</span>
          </div>
        ))}
      </div>
      {summary.failed.length > 0 && (
        <div className="history-group">
          <div className="history-group-title extra">
            {t("history.result.failed", {
              n: String(summary.failed.length),
            })}
          </div>
          {summary.failed.map((f, i) => (
            <div
              key={i}
              className="history-mount-row"
              title={`${f.record.workspace}/${f.record.linkRel}`}
            >
              <span className="history-mount-dst">
                {`${baseName(f.record.workspace)}/${f.record.linkRel}`}
              </span>
              <span className="history-reason">{f.message}</span>
            </div>
          ))}
        </div>
      )}
      {summary.skipped.length > 0 && (
        <div className="history-group">
          <div className="history-group-title skipped">
            {t("history.preview.skipped", {
              n: String(summary.skipped.length),
            })}
          </div>
          {summary.skipped.map((s, i) => (
            <div
              key={i}
              className="history-mount-row"
              title={`${s.record.workspace}/${s.record.linkRel}`}
            >
              <span className="history-mount-dst">
                {`${baseName(s.record.workspace)}/${s.record.linkRel}`}
              </span>
              <span className="history-reason">
                {t(`history.preview.reason.${s.reason}` as TplKey)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="primary" onClick={onDone}>
          {t("history.result.done")}
        </button>
      </div>
    </>
  );
}
