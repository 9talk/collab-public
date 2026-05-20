import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface AgentChatTileProps {
  tileId: string;
  cwd?: string;
  theme?: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

export default function AgentChatTile({ cwd, theme = "dark" }: AgentChatTileProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const bg = theme === "light" ? "#ffffff" : "#111827";
  const border = theme === "light" ? "#e5e7eb" : "#374151";
  const userBg = theme === "light" ? "#dbeafe" : "#1e3a5f";
  const userColor = theme === "light" ? "#1e40af" : "#93c5fd";
  const assistantBg = theme === "light" ? "#f3f4f6" : "#1f2937";
  const muted = theme === "light" ? "#6b7280" : "#9ca3af";

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Listen for agent events
  useEffect(() => {
    const unsubData = listen("agent:data", (event) => {
      const payload = event.payload as { sessionId: string; data: string };
      if (payload.sessionId !== sessionId) return;

      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.isStreaming) {
          return [
            ...prev.slice(0, -1),
            { ...last, content: last.content + payload.data },
          ];
        }
        return [
          ...prev,
          {
            id: `msg_${Date.now()}`,
            role: "assistant",
            content: payload.data,
            timestamp: Date.now(),
            isStreaming: true,
          },
        ];
      });
    });

    const unsubDone = listen("agent:done", (event) => {
      const payload = event.payload as { sessionId: string };
      if (payload.sessionId !== sessionId) return;
      setIsRunning(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.isStreaming) {
          return [...prev.slice(0, -1), { ...last, isStreaming: false }];
        }
        return prev;
      });
      inputRef.current?.focus();
    });

    const unsubError = listen("agent:error", (event) => {
      const payload = event.payload as { sessionId: string; error: string };
      if (payload.sessionId !== sessionId) return;
      setIsRunning(false);
      setError(payload.error);
    });

    return () => {
      unsubData.then((fn) => fn());
      unsubDone.then((fn) => fn());
      unsubError.then((fn) => fn());
    };
  }, [sessionId]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isRunning) return;

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: input.trim(),
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsRunning(true);
    setError(null);

    try {
      // Spawn agent if not already running
      if (!sessionId) {
        const workDir = cwd || ".";
        const result = await invoke<{ session_id: string; resumed: boolean }>("agent_spawn", {
          cwd: workDir,
        });
        setSessionId(result.session_id);
        // Now send the prompt to the spawned session
        await invoke("agent_prompt", {
          session_id: result.session_id,
          text: userMsg.content,
        });
      } else {
        await invoke("agent_prompt", {
          session_id: sessionId,
          text: userMsg.content,
        });
      }
    } catch (e) {
      console.error("[AgentChat] Failed to send prompt:", e);
      setIsRunning(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [input, isRunning, sessionId, cwd]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = async () => {
    if (sessionId) {
      await invoke("agent_cancel", { sessionId });
    }
    setIsRunning(false);
  };

  const handleClear = () => {
    setMessages([]);
    setSessionId(null);
    setError(null);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: bg }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: "8px",
        padding: "6px 12px", borderBottom: `1px solid ${border}`,
        fontSize: "12px", flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600, color: theme === "light" ? "#111827" : "#ffffff" }}>
          Agent
        </span>
        {isRunning && (
          <span style={{ color: "#f59e0b", fontSize: "11px" }}>● Running</span>
        )}
        <div style={{ flex: 1 }} />
        {isRunning && (
          <button
            onClick={handleStop}
            style={{
              padding: "2px 8px", borderRadius: "4px", fontSize: "11px",
              backgroundColor: "#dc2626", color: "#fff", border: "none", cursor: "pointer",
            }}
          >
            Stop
          </button>
        )}
        <button
          onClick={handleClear}
          style={{
            padding: "2px 8px", borderRadius: "4px", fontSize: "11px",
            backgroundColor: theme === "light" ? "#e5e7eb" : "#374151", color: theme === "light" ? "#111827" : "#fff",
            border: "none", cursor: "pointer",
          }}
        >
          Clear
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: "flex",
              justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div style={{
              maxWidth: "85%",
              padding: "8px 12px",
              borderRadius: "12px",
              fontSize: "13px",
              lineHeight: "1.5",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              backgroundColor: msg.role === "user" ? userBg : assistantBg,
              color: msg.role === "user" ? userColor : (theme === "light" ? "#111827" : "#ffffff"),
            }}>
              {msg.content}
              {msg.isStreaming && <span style={{ opacity: 0.5 }}> ▌</span>}
            </div>
          </div>
        ))}

        {messages.length === 0 && !isRunning && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: muted, fontSize: "13px" }}>
            <div style={{ textAlign: "center" }}>
              <p style={{ marginBottom: "8px" }}>Agent Chat</p>
              <p style={{ fontSize: "11px" }}>Type a message to start a conversation</p>
            </div>
          </div>
        )}

        {error && (
          <div style={{ textAlign: "center", color: "#ef4444", fontSize: "12px", padding: "8px" }}>
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: "8px 12px", borderTop: `1px solid ${border}`, display: "flex", gap: "8px" }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isRunning ? "Agent is working..." : "Message the agent..."}
          disabled={isRunning}
          rows={1}
          style={{
            flex: 1, padding: "8px 12px", borderRadius: "8px",
            backgroundColor: theme === "light" ? "#f3f4f6" : "#1f2937",
            color: theme === "light" ? "#111827" : "#ffffff",
            border: `1px solid ${border}`, outline: "none",
            fontSize: "13px", resize: "none", lineHeight: "1.4",
            fontFamily: "inherit",
          }}
        />
        <button
          onClick={handleSend}
          disabled={isRunning || !input.trim()}
          style={{
            width: "36px", height: "36px", borderRadius: "8px",
            backgroundColor: "#2563eb", color: "#fff",
            border: "none", cursor: isRunning || !input.trim() ? "not-allowed" : "pointer",
            opacity: isRunning || !input.trim() ? 0.4 : 1,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: "18px",
          }}
        >
          ↑
        </button>
      </div>
    </div>
  );
}
