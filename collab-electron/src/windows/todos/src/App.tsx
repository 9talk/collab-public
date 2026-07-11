import { useCallback, useEffect, useState } from "react";
import "./App.css";

type Priority = "p0" | "p1" | "p2" | "p3";

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  priority: Priority | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

type Filter = "active" | "done" | "all";
type ModalMode = "add" | "edit" | null;

const PRIORITIES: { value: Priority; label: string; color: string }[] = [
  { value: "p0", label: "P0", color: "var(--destructive)" },
  { value: "p1", label: "P1", color: "#e68a2e" },
  { value: "p2", label: "P2", color: "#5c9bcf" },
  { value: "p3", label: "P3", color: "var(--muted-foreground)" },
];

const MACARON_COLORS = [
  { bg: "#FFD1DC" },
  { bg: "#B5EAD7" },
  { bg: "#C7CEEA" },
  { bg: "#FFDAC1" },
  { bg: "#E2F0CB" },
  { bg: "#F0E6EF" },
  { bg: "#D4F0F0" },
  { bg: "#FDE2E4" },
  { bg: "#FADADD" },
  { bg: "#C5E0D8" },
];

function hashTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return MACARON_COLORS[Math.abs(hash) % MACARON_COLORS.length].bg;
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim()) ?? text;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function App() {
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [filter, setFilter] = useState<Filter>("active");

  // Modal state
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [modalText, setModalText] = useState("");
  const [modalPriority, setModalPriority] = useState<Priority | null>(null);
  const [modalTags, setModalTags] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Load todos on mount
  useEffect(() => {
    (async () => {
      try {
        const data = await window.api.getPref("todos");
        if (Array.isArray(data)) {
          setTodos(data as TodoItem[]);
        }
      } catch {
        // Pref unavailable
      }
    })();
  }, []);

  const saveTodos = useCallback(async (next: TodoItem[]) => {
    setTodos(next);
    try {
      await window.api.setPref("todos", next);
    } catch {
      // Pref unavailable
    }
  }, []);

  // --- Modal handlers ---

  const openAddModal = useCallback(() => {
    setModalMode("add");
    setModalText("");
    setModalPriority(null);
    setModalTags("");
    setEditingId(null);
  }, []);

  const openEditModal = useCallback((todo: TodoItem) => {
    setModalMode("edit");
    setModalText(todo.text);
    setModalPriority(todo.priority);
    setModalTags(todo.tags.join(" "));
    setEditingId(todo.id);
  }, []);

  const closeModal = useCallback(() => {
    setModalMode(null);
  }, []);

  const submitModal = useCallback(() => {
    const text = modalText.trim();
    if (!text) return;
    const tags = modalTags
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    if (modalMode === "add") {
      const item: TodoItem = {
        id: generateId(),
        text,
        done: false,
        priority: modalPriority,
        tags,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
      };
      saveTodos([item, ...todos]);
    } else if (modalMode === "edit" && editingId) {
      saveTodos(
        todos.map((t) =>
          t.id === editingId
            ? {
                ...t,
                text,
                priority: modalPriority,
                tags,
                updatedAt: Date.now(),
              }
            : t,
        ),
      );
    }
    setModalMode(null);
  }, [
    modalMode,
    modalText,
    modalPriority,
    modalTags,
    editingId,
    saveTodos,
    todos,
  ]);

  const toggleTodo = useCallback(
    (id: string) => {
      saveTodos(
        todos.map((t) => {
          if (t.id !== id) return t;
          const nextDone = !t.done;
          return {
            ...t,
            done: nextDone,
            completedAt: nextDone ? Date.now() : null,
            updatedAt: Date.now(),
          };
        }),
      );
    },
    [saveTodos, todos],
  );

  const requestDelete = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(id);
  }, []);

  const confirmDelete = useCallback(() => {
    if (confirmDeleteId) {
      saveTodos(todos.filter((t) => t.id !== confirmDeleteId));
      setConfirmDeleteId(null);
    }
  }, [confirmDeleteId, saveTodos, todos]);

  const cancelDelete = useCallback(() => {
    setConfirmDeleteId(null);
  }, []);

  // Filter and sort
  const filtered = todos
    .filter((t) => {
      if (filter === "active") return !t.done;
      if (filter === "done") return t.done;
      return true;
    })
    .sort((a, b) => {
      const aIdx = a.priority
        ? PRIORITIES.findIndex((p) => p.value === a.priority)
        : PRIORITIES.length;
      const bIdx = b.priority
        ? PRIORITIES.findIndex((p) => p.value === b.priority)
        : PRIORITIES.length;
      if (aIdx !== bIdx) return aIdx - bIdx;
      const aTag = a.tags.join(",");
      const bTag = b.tags.join(",");
      if (aTag !== bTag) return aTag.localeCompare(bTag);
      return b.createdAt - a.createdAt;
    });

  return (
    <div className="todos">
      {/* Add todo button — matches nav's Add workspace style */}
      <div className="todo-add-row">
        <button className="todo-add-btn" onClick={openAddModal}>
          + 添加待办
        </button>
      </div>

      {/* Filter bar */}
      <div className="todo-filters">
        {(["active", "done", "all"] as Filter[]).map((f) => (
          <button
            key={f}
            className={`filter-btn${filter === f ? " active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "active" ? "进行中" : f === "done" ? "已完成" : "全部"}
          </button>
        ))}
        <span className="todo-count">{filtered.length}</span>
      </div>

      {/* Todo list */}
      <div className="todo-list">
        {filtered.map((todo) => (
          <div
            key={todo.id}
            className={`todo-item${todo.done ? " done" : ""}`}
            onClick={() => openEditModal(todo)}
          >
            <input
              type="checkbox"
              className="todo-checkbox"
              checked={todo.done}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggleTodo(todo.id)}
            />
            <div className="todo-body">
              <div className="todo-top-row">
                <span className="todo-text">{firstLine(todo.text)}</span>
                <button
                  className="delete-btn"
                  onClick={(e) => requestDelete(todo.id, e)}
                  title="删除"
                >
                  ×
                </button>
              </div>
              <div className="todo-meta">
                <span
                  className={`prio-badge${todo.priority ? ` prio-${todo.priority}` : ""}`}
                >
                  {todo.priority ? todo.priority.toUpperCase() : "—"}
                </span>
                {todo.tags.map((tag) => (
                  <span
                    key={tag}
                    className="tag-chip"
                    style={{ background: hashTagColor(tag) }}
                  >
                    {tag}
                  </span>
                ))}
                {todo.completedAt && (
                  <span className="done-time">
                    ✓ {formatTime(todo.completedAt)}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="todo-empty">
            {filter === "all"
              ? "暂无待办"
              : filter === "active"
                ? "没有进行中的待办"
                : "没有已完成的待办"}
          </div>
        )}
      </div>

      {/* Modal: add / edit */}
      {modalMode && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                {modalMode === "add" ? "添加待办" : "编辑待办"}
              </span>
              <button className="modal-close-btn" onClick={closeModal}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-field">
                <label className="modal-label">内容</label>
                <textarea
                  className="modal-textarea"
                  value={modalText}
                  onChange={(e) => setModalText(e.target.value)}
                  rows={3}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      submitModal();
                    }
                  }}
                />
              </div>
              <div className="modal-field">
                <label className="modal-label">优先级</label>
                <div
                  className="detail-prio-group"
                  role="radiogroup"
                  aria-label="优先级"
                >
                  <label
                    className={`prio-radio${modalPriority === null ? " active" : ""}`}
                  >
                    <input
                      type="radio"
                      name="modal-prio"
                      checked={modalPriority === null}
                      onChange={() => setModalPriority(null)}
                    />
                    无
                  </label>
                  {PRIORITIES.map((p) => (
                    <label
                      key={p.value}
                      className={`prio-radio${modalPriority === p.value ? " active" : ""}`}
                      style={{ "--prio-color": p.color } as React.CSSProperties}
                    >
                      <input
                        type="radio"
                        name="modal-prio"
                        checked={modalPriority === p.value}
                        onChange={() => setModalPriority(p.value)}
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="modal-field">
                <label className="modal-label">标签</label>
                <input
                  className="modal-input"
                  value={modalTags}
                  onChange={(e) => setModalTags(e.target.value)}
                  placeholder="以空格或逗号分隔"
                />
              </div>
              <div className="modal-tags-preview">
                {modalTags
                  .split(/[,，\s]+/)
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .map((tag) => (
                    <span
                      key={tag}
                      className="tag-chip"
                      style={{ background: hashTagColor(tag) }}
                    >
                      {tag}
                    </span>
                  ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="modal-btn cancel" onClick={closeModal}>
                取消
              </button>
              <button
                className="modal-btn confirm"
                onClick={submitModal}
                disabled={!modalText.trim()}
              >
                {modalMode === "add" ? "添加" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete dialog */}
      {confirmDeleteId && (
        <div className="modal-overlay" onClick={cancelDelete}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">确认删除</span>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 12, lineHeight: 1.5 }}>
                确定要删除这条待办吗？此操作不可撤销。
              </p>
            </div>
            <div className="modal-footer">
              <button className="modal-btn cancel" onClick={cancelDelete}>
                取消
              </button>
              <button className="modal-btn danger" onClick={confirmDelete}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
