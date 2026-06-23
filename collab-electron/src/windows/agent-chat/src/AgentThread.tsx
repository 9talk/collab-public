import {
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
} from "@assistant-ui/react";
import { ArrowUp } from "lucide-react";
import { MarkdownText } from "./MarkdownText";
import { ToolCallFallback } from "./ToolCallCard";

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div
        className="max-w-[85%] rounded-2xl px-4 py-2 text-[13px]"
        style={{
          background: "var(--chat-message-user-bg)",
          color: "var(--chat-message-user-text)",
        }}
      >
        <MessagePrimitive.Content />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex">
      <div className="max-w-[95%] text-[13px]">
        <MessagePrimitive.Content
          components={{
            Text: MarkdownText,
            tools: {
              Fallback: ToolCallFallback,
            },
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function Composer({ ready }: { ready: boolean }) {
  return (
    <div>
      {!ready && (
        <div className="mb-1 text-center text-xs text-muted-foreground">
          Reconnecting...
        </div>
      )}
      <ComposerPrimitive.Root className="flex items-end gap-2 rounded-xl border border-border bg-card p-2">
        <ComposerPrimitive.Input
          autoFocus
          disabled={!ready}
          placeholder={ready ? "Message the agent..." : "Reconnecting..."}
          className="flex-1 resize-none bg-transparent px-2 py-1 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          rows={1}
        />
        <ComposerPrimitive.Send
          disabled={!ready}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-30"
        >
          <ArrowUp size={16} />
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </div>
  );
}

export function AgentThread({ ready }: { ready: boolean }) {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col px-4 pb-4 text-foreground">
      <ThreadPrimitive.Viewport className="scrollbar-hover min-h-0 flex flex-1 flex-col overflow-y-auto px-3 pt-4">
        <div className="flex flex-col gap-4">
          <ThreadPrimitive.Messages
            components={{
              UserMessage,
              AssistantMessage,
            }}
          />
        </div>
      </ThreadPrimitive.Viewport>
      <div className="">
        <Composer ready={ready} />
      </div>
    </ThreadPrimitive.Root>
  );
}
