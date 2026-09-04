import { useEffect, useRef, useState } from "react";
import { TerminalTab } from "@collab/components/Terminal";

// Remote Client 应用里的 terminal webview 都是 Host 会话的镜像视图:
// 以会话 winsize 渲染(见 TerminalTab mirror prop),不参与会话尺寸仲裁。
const IS_MIRROR = window.api.getAppFlavor() === "remote";

const CHAR_WIDTH = 7.0; // 实测 xterm cell 宽(Menlo 12px on macOS,与 TerminalTab 渲染一致)
const CELL_HEIGHT = 14; // 实测 xterm cell 高;旧值 17 使初始 winsize 行数比视口少约 7 行,全屏程序下方留白

/** Approximate terminal dimensions from the viewport before xterm mounts. */
function estimateTermSize(): { cols: number; rows: number } {
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  return {
    cols: Math.max(80, Math.floor(w / CHAR_WIDTH)),
    rows: Math.max(24, Math.floor(h / CELL_HEIGHT)),
  };
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

    const createFreshSession = (target?: string, nextCwd?: string) => {
      // 优先按 tile 目标布局尺寸估算(挂载前的 webview 是未布局的窗口
      // 尺寸,会让初始 winsize 偏大,全屏程序随后错位)。
      const est = layout
        ? {
            cols: Math.max(80, Math.floor(layout.width / CHAR_WIDTH)),
            rows: Math.max(24, Math.floor(layout.height / CELL_HEIGHT)),
          }
        : estimateTermSize();
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
      const { cols, rows } = estimateTermSize();

      window.api
        .ptyDiscover()
        .then((sessions) => {
          const session = sessions.find(
            (s) => s.sessionId === existingSessionId,
          );
          if (!session) {
            throw new Error("Missing restored session");
          }
          // 镜像端必须以会话现行 winsize 回连:sidecar reconnect 会按传入
          // 尺寸 resize PTY,若传本地视口尺寸(通常比 Host 小)会把权威
          // winsize 改小,全屏程序(如 Claude Code)按缩小后的行数排布,
          // 渲染在更大的可视区里下方留白。
          const rcCols = IS_MIRROR && session.cols ? session.cols : cols;
          const rcRows = IS_MIRROR && session.rows ? session.rows : rows;
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
                  const rcCols = session.cols ?? cols;
                  const rcRows = session.rows ?? rows;
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
