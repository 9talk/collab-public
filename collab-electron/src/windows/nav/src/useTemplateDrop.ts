import { useCallback, useEffect, useRef, useState } from "react";

export interface TemplateDragPayload {
  template: string;
  relPath: string;
  name: string;
  isDir: boolean;
}

interface Options {
  /** 目标节点是否允许放置（workspace 根 / 普通目录；文件与链接内部禁止） */
  isDropAllowed: (targetPath: string) => boolean;
  /** 放置落定（targetPath 为绝对路径） */
  onDrop: (targetPath: string) => void;
}

/**
 * 放置目标规则（设计 6.2）：仅 workspace 根与普通目录可放置；文件节点、
 * 软链接节点自身及其内部（防止写入污染模板源）、树空白区域一律禁止。
 */
export function isTemplateDropTarget(
  item:
    | {
        kind: string;
        isSymlink?: boolean;
        linkAncestor?: boolean;
      }
    | undefined,
): boolean {
  if (!item) return false;
  if (item.kind !== "folder" && item.kind !== "workspace") return false;
  if (item.isSymlink || item.linkAncestor) return false;
  return true;
}

/**
 * 接收来自模板管理窗口的跨窗口拖拽：模板窗口 dragstart 时主进程登记
 * 载荷并广播 template-drag:start，本 hook 据此进入接收态；dragover 只对
 * 合法目标 preventDefault（浏览器据此给出可/禁光标），drop 时回调。
 */
export function useTemplateDrop({ isDropAllowed, onDrop }: Options) {
  const [payload, setPayload] = useState<TemplateDragPayload | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const payloadRef = useRef<TemplateDragPayload | null>(null);

  const setPayloadBoth = useCallback((next: TemplateDragPayload | null) => {
    payloadRef.current = next;
    setPayload(next);
    if (next === null) setDropTargetPath(null);
  }, []);

  useEffect(() => {
    const offStart = window.api.onTemplateDragStart((p) => setPayloadBoth(p));
    const offEnd = window.api.onTemplateDragEnd(() => setPayloadBoth(null));
    return () => {
      offStart?.();
      offEnd?.();
    };
  }, [setPayloadBoth]);

  // 拖拽期间全局切换光标（合法目标 drop-target 样式由调用方传入 dropTargetPath）
  useEffect(() => {
    document.body.classList.toggle("template-drag-active", payload !== null);
    return () => document.body.classList.remove("template-drag-active");
  }, [payload]);

  const handleDragOver = useCallback(
    (e: React.DragEvent, targetPath: string) => {
      if (!payloadRef.current) return;
      if (!isDropAllowed(targetPath)) {
        e.dataTransfer.dropEffect = "none";
        setDropTargetPath((prev) => (prev === null ? prev : null));
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropTargetPath((prev) => (prev === targetPath ? prev : targetPath));
    },
    [isDropAllowed],
  );

  const handleDragLeave = useCallback(() => {
    setDropTargetPath((prev) => (prev === null ? prev : null));
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetPath: string) => {
      if (!payloadRef.current) return;
      e.preventDefault();
      setDropTargetPath(null);
      if (!isDropAllowed(targetPath)) return;
      onDrop(targetPath);
    },
    [isDropAllowed, onDrop],
  );

  return {
    active: payload !== null,
    payload,
    dropTargetPath,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
