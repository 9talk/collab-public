/**
 * Mock window.api for standalone browser testing.
 * Simulates the ACP agent IPC without Electron.
 */

type UpdateCb = (params: unknown) => void;
type CompleteCb = (data: { sessionId: string; stopReason: string }) => void;
type ErrorCb = (data: { sessionId: string; error: string }) => void;
type ExitCb = (data: { sessionId: string }) => void;

const listeners = {
  update: [] as UpdateCb[],
  complete: [] as CompleteCb[],
  error: [] as ErrorCb[],
  exit: [] as ExitCb[],
};

function emit(type: keyof typeof listeners, data: unknown) {
  for (const cb of listeners[type]) {
    (cb as (d: unknown) => void)(data);
  }
}

function simulateResponse(sessionId: string, userText: string) {
  const response =
    `You said: "${userText}"\n\n` +
    "This is a **mock response** from the dev shim. " +
    "It supports:\n\n" +
    "- Streaming text chunks\n" +
    "- Tool calls\n" +
    "- Markdown rendering\n\n" +
    "| Feature | Status |\n" +
    "|---------|--------|\n" +
    "| Text | Working |\n" +
    "| Tools | Simulated |\n";

  // Simulate streaming: split into chunks
  const chunks = response.match(/.{1,40}/g) ?? [response];
  let delay = 100;

  for (const chunk of chunks) {
    setTimeout(() => {
      emit("update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        },
      });
    }, delay);
    delay += 50;
  }

  // Simulate a tool call after text
  setTimeout(() => {
    emit("update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `call_${Date.now()}`,
        title: "bash",
        kind: "command",
        status: "in_progress",
        rawInput: { command: `echo "${userText}"` },
      },
    });
  }, delay);
  delay += 200;

  // Tool call complete
  setTimeout(() => {
    emit("update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: `call_${Date.now() - 200}`,
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: userText,
            },
          },
        ],
      },
    });
  }, delay);
  delay += 100;

  // Prompt complete
  setTimeout(() => {
    emit("complete", {
      sessionId,
      stopReason: "end_turn",
    });
  }, delay);
}

export function installDevShim() {
  if ((window as any).api) return; // Real preload exists

  const sessionId = "dev-session-" + Date.now();

  (window as any).api = {
    agentSpawn: async () => {
      console.log("[dev-shim] agentSpawn");
      return { sessionId };
    },

    agentPrompt: async (sid: string, text: string) => {
      console.log("[dev-shim] agentPrompt:", text);
      simulateResponse(sid, text);
    },

    agentCancel: async () => {
      console.log("[dev-shim] agentCancel");
    },

    agentKill: async () => {
      console.log("[dev-shim] agentKill");
    },

    onAgentUpdate: (cb: UpdateCb) => {
      listeners.update.push(cb);
      return () => {
        const i = listeners.update.indexOf(cb);
        if (i >= 0) listeners.update.splice(i, 1);
      };
    },

    onAgentPromptComplete: (cb: CompleteCb) => {
      listeners.complete.push(cb);
      return () => {
        const i = listeners.complete.indexOf(cb);
        if (i >= 0) listeners.complete.splice(i, 1);
      };
    },

    onAgentPromptError: (cb: ErrorCb) => {
      listeners.error.push(cb);
      return () => {
        const i = listeners.error.indexOf(cb);
        if (i >= 0) listeners.error.splice(i, 1);
      };
    },

    onAgentExit: (cb: ExitCb) => {
      listeners.exit.push(cb);
      return () => {
        const i = listeners.exit.indexOf(cb);
        if (i >= 0) listeners.exit.splice(i, 1);
      };
    },

    sendToHost: () => {},
  };

  console.log("[dev-shim] Mock API installed");
}
