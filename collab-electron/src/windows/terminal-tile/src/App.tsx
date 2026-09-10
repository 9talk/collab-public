import { useEffect, useRef, useState } from "react";
import { TerminalTab } from "@collab/components/Terminal";
import {
  estimateGrid,
  FALLBACK_CELL_HEIGHT,
  FALLBACK_CELL_WIDTH,
} from "./estimate-grid";

// Remote Client 应用里的 terminal webview 都是 Host 会话的镜像视图:
// 以会话 winsize 渲染(见 TerminalTab mirror prop),不参与会话尺寸仲裁。
const IS_MIRROR = window.api.getAppFlavor() === "remote";

/** 读主进程校准的 cell 度量(px/格);首个 tile 尚未 fit 上报时回落常量 */
function readCalibratedCell(): { cellW: number; cellH: number } {
  let cellW = FALLBACK_CELL_WIDTH;
  let cellH = FALLBACK_CELL_HEIGHT;
  try {
    const w = window.api.getPrefSync("terminalCellWidth");
    const h = window.api.getPrefSync("terminalCellHeight");
    if (typeof w === "number" && w > 0) cellW = w;
    if (typeof h === "number" && h > 0) cellH = h;
  } catch {
    /* 同步读取失败时使用常量 */
  }
  return { cellW, cellH };
}

/** Approximate terminal dimensions from pixel size before xterm mounts. */
function estimateFromPx(
  width: number,
  height: number,
): { cols: number; rows: number } {
  const { cellW, cellH } = readCalibratedCell();
  return estimateGrid(width, height, cellW, cellH);
}

function estimateTermSize(): { cols: number; rows: number } {
  return estimateFromPx(
    document.documentElement.clientWidth,
    document.documentElement.clientHeight,
  );
}

/** 初始估算:优先 spawn 时实测的内容区尺寸(webview 内容盒,与 cell 校准
 *  同一口径);缺失回落 tile 布局尺寸(整块、含标题栏,会高估约 1 列 2 行),
 *  再缺失用实时视口(挂载前可能未布局,仅作兜底) */
function estimateInitial(
  layout?: { width: number; height: number } | null,
  content?: { width: number; height: number } | null,
): { cols: number; rows: number } {
  if (content && content.width > 0 && content.height > 0) {
    return estimateFromPx(content.width, content.height);
  }
  return layout
    ? estimateFromPx(layout.width, layout.height)
    : estimateTermSize();
}

function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [restored, setRestored] = useState(false);
  const [scrollbackData, setScrollbackData] = useState<string | null>(null);

  // Parse URL params once
  const paramsRef = useRef<URLSearchParams | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    paramsRef.current = params;
    const existingSessionId = params.get("sessionId");
    const isRestored = params.get("restored") === "1";
    const cwd = params.get("cwd") || undefined;
    const tileId = params.get("tileId") || undefined;
    const layoutParam = params.get("layout");
    let layout:
      | { x: number; y: number; width: number; height: number }
      | undefined;
    if (layoutParam) {
      try {
        const parsed = JSON.parse(layoutParam);
        if (
          typeof parsed?.x === "number" &&
          typeof parsed?.y === "number" &&
          typeof parsed?.width === "number" &&
          typeof parsed?.height === "number"
        ) {
          layout = parsed;
        }
      } catch {
        // 非法 layout 忽略，镜像创建时回退到自动布局
      }
    }
    const contentParam = params.get("content");
    let content: { width: number; height: number } | undefined;
    if (contentParam) {
      try {
        const parsed = JSON.parse(contentParam);
        if (
          typeof parsed?.width === "number" &&
          typeof parsed?.height === "number"
        ) {
          content = parsed;
        }
      } catch {
        // 非法 content 忽略，估算回落 layout/实时视口
      }
    }

    const createFreshSession = (target?: string, nextCwd?: string) => {
      const est = estimateInitial(layout, content);
      window.api
        .ptyCreate(nextCwd ?? cwd, est.cols, est.rows, target, tileId, layout)
        .then((result) => {
          setSessionId(result.sessionId);
          window.api.notifyPtySessionId(result.sessionId);
        })
        .catch(() => {
          setExited(true);
        });
    };

    if (isRestored && existingSessionId) {
      setRestored(true);
      const est = estimateInitial(layout, content);

      window.api
        .ptyDiscover()
        .then((sessions) => {
          const session = sessions.find(
            (s) => s.sessionId === existingSessionId,
          );
          if (!session) {
            throw new Error("Missing restored session");
          }
          // 已有会话以现行 winsize 为权威:sidecar reconnect 会按传入尺寸
          // resize PTY,若用本地估算(挂载前窗口未布局时偏小甚至落到
          // 80x24)会把运行中的会话改小,全屏程序(如 Claude Code)收到
          // SIGWINCH 重排后下方留白。会话从未设过尺寸(缺失)才回落布局估算。
          const rcCols =
            session.cols && session.cols > 0 ? session.cols : est.cols;
          const rcRows =
            session.rows && session.rows > 0 ? session.rows : est.rows;
          return window.api.ptyReconnect(existingSessionId, rcCols, rcRows);
        })
        .then((result) => {
          if (result.scrollback) {
            setScrollbackData(result.scrollback);
          }
          setSessionId(existingSessionId);
        })
        .catch(async () => {
          if (IS_MIRROR) {
            // 镜像端绝不在 Host 侧自建会话:reconnect 失败 = Host 端会话
            // 尚未就绪(画布恢复中/会话重建中)。镜像 tile 存在的前提是
            // Host 画布有它——Host 端 fallback 重建后会广播 pty-opened,
            // B 端 shell 据此更新镜像 tile 指向并重建 webview;本循环仅
            // 在旧指向仍有效期间轮询等待会话就位(webview 销毁自然停止)。
            const retry = () => {
              window.api
                .ptyDiscover()
                .then((sessions) => {
                  const session = sessions.find(
                    (s: { sessionId: string }) =>
                      s.sessionId === existingSessionId,
                  );
                  if (!session) {
                    setTimeout(retry, 2000);
                    return;
                  }
                  const rcCols = session.cols ?? est.cols;
                  const rcRows = session.rows ?? est.rows;
                  window.api
                    .ptyReconnect(existingSessionId, rcCols, rcRows)
                    .then((result) => {
                      if (result.scrollback) {
                        setScrollbackData(result.scrollback);
                      }
                      setSessionId(existingSessionId);
                    })
                    .catch(() => setTimeout(retry, 2000));
                })
                .catch(() => setTimeout(retry, 2000));
            };
            retry();
            return;
          }
          setRestored(false);
          // Recover the original working directory from session
          // metadata so the fallback session opens in the right place.
          let fallbackCwd = cwd;
          let fallbackTarget: string | undefined;
          if (existingSessionId) {
            try {
              const meta = window.api.ptyReadMeta(existingSessionId);
              if (!fallbackCwd && meta?.cwd) fallbackCwd = meta.cwd;
              if (meta?.target) fallbackTarget = meta.target;
            } catch {
              // Metadata unavailable — fall through to default
            }
          }
          createFreshSession(fallbackTarget, fallbackCwd);
        });

      return;
    }

    if (existingSessionId) {
      setSessionId(existingSessionId);
      return;
    }

    createFreshSession();
  }, []);

  // Claude Code deep integration: auto-resume session after PTY is ready.
  // Skip when restored === true (reconnected to an existing PTY session,
  // e.g. saveMemMode rebuild) — the terminal is already running and claude
  // is likely still active.
  useEffect(() => {
    if (!sessionId || restored) return;
    const params = paramsRef.current;
    const tileId = params?.get("tileId");
    if (!tileId) return;

    let cancelled = false;

    const tryClaudeResume = async () => {
      try {
        // 1. Check if deep integration is enabled
        const enabled = await window.api.getPref("claudeIntegration");
        if (!enabled) return;

        // 2. Get the claude CLI command
        const rawCmd = await window.api.getPref("claudeCommand");
        const claudeCmd =
          typeof rawCmd === "string" && rawCmd ? rawCmd : "claude";

        // 3. Get binding for this tile
        const binding = await window.api.getClaudeBinding(tileId);
        if (!binding?.sessionId) return;

        // 4. Check if the binding has expired
        const timeoutDays = (await window.api.getPref("claudeTimeout")) ?? 7;
        if (binding.updatedAt > 0) {
          const elapsed = Date.now() - binding.updatedAt;
          if (elapsed > timeoutDays * 86400000) return;
        } else {
          // updatedAt === 0 means old format / expired
          return;
        }

        // 5. Wait a moment for shell to initialize, then resume
        setTimeout(() => {
          if (cancelled) return;
          window.api.ptyWrite(
            sessionId,
            `${claudeCmd} --resume ${binding.sessionId}\n`,
          );
        }, 1000);
      } catch {
        // Silently ignore errors (e.g., IPC failures during shutdown)
      }
    };

    tryClaudeResume();
    return () => {
      cancelled = true;
    };
  }, [sessionId, restored]);

  useEffect(() => {
    if (!sessionId) return;
    const handleExit = (payload: { sessionId: string; exitCode: number }) => {
      if (payload.sessionId === sessionId) {
        setExited(true);
      }
    };
    window.api.onPtyExit(sessionId, handleExit);
    return () => window.api.offPtyExit(sessionId, handleExit);
  }, [sessionId]);

  if (exited) {
    return <div className="terminal-tile-exited">Session ended</div>;
  }

  if (!sessionId) {
    return <div className="terminal-tile-loading">Connecting...</div>;
  }

  return (
    <TerminalTab
      sessionId={sessionId}
      visible={true}
      restored={restored}
      scrollbackData={scrollbackData}
      mirror={IS_MIRROR}
    />
  );
}

export default App;
