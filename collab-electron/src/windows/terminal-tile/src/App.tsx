import { useEffect, useRef, useState } from "react";
import { TerminalTab } from "@collab/components/Terminal";

/** Approximate terminal dimensions from the viewport before xterm mounts. */
function estimateTermSize(): { cols: number; rows: number } {
  const CHAR_WIDTH = 7.22; // Menlo 12px on macOS
  const CELL_HEIGHT = 17; // xterm line height at fontSize 12
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

    const createFreshSession = (target?: string, nextCwd?: string) => {
      const est = estimateTermSize();
      window.api
        .ptyCreate(nextCwd ?? cwd, est.cols, est.rows, target, tileId)
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
          const found = sessions.some(
            (session) => session.sessionId === existingSessionId,
          );
          if (!found) {
            throw new Error("Missing restored session");
          }
          return window.api.ptyReconnect(existingSessionId, cols, rows);
        })
        .then((result) => {
          if (result.scrollback) {
            setScrollbackData(result.scrollback);
          }
          setSessionId(existingSessionId);
        })
        .catch(async () => {
          setRestored(false);
          // Recover the original working directory from session
          // metadata so the fallback session opens in the right place.
          let fallbackCwd = cwd;
          let fallbackTarget: string | undefined;
          if (existingSessionId) {
            try {
              const meta = await window.api.ptyReadMeta(existingSessionId);
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

  // Claude Code deep integration: auto-resume session after PTY is ready
  useEffect(() => {
    if (!sessionId) return;
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
  }, [sessionId]);

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
    />
  );
}

export default App;
