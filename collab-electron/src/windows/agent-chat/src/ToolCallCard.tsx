import { type ComponentType } from "react";
import {
  Terminal,
  FileText,
  Pencil,
  Search,
  Globe,
  Wrench,
  Check,
  Loader2,
} from "lucide-react";

const TOOL_ICONS: Record<string, ComponentType<{ size: number }>> = {
  bash: Terminal,
  Bash: Terminal,
  read_file: FileText,
  Read: FileText,
  edit_file: Pencil,
  Edit: Pencil,
  Write: Pencil,
  search: Search,
  Grep: Search,
  Glob: Search,
  web: Globe,
  WebSearch: Globe,
  WebFetch: Globe,
};

function getIcon(toolName: string) {
  return TOOL_ICONS[toolName] ?? Wrench;
}

function getLabel(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return toolName;
  const a = args as Record<string, unknown>;

  if (a.command && typeof a.command === "string") {
    return a.command.length > 60 ? a.command.slice(0, 57) + "..." : a.command;
  }
  if (a.path && typeof a.path === "string") {
    const parts = (a.path as string).split("/");
    return parts[parts.length - 1] ?? toolName;
  }
  if (a.file_path && typeof a.file_path === "string") {
    const parts = (a.file_path as string).split("/");
    return parts[parts.length - 1] ?? toolName;
  }
  if (a.pattern && typeof a.pattern === "string") {
    return `/${a.pattern}/`;
  }
  return toolName;
}

export function ToolCallFallback({
  toolName,
  args,
  result,
  status,
}: {
  toolName: string;
  args: unknown;
  argsText: string;
  result: unknown;
  status: { type: string };
}) {
  const Icon = getIcon(toolName);
  const label = getLabel(toolName, args);
  const isRunning = status.type === "running";

  return (
    <details className="my-1 rounded-lg border border-border bg-card text-xs">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-muted-foreground select-none">
        {isRunning ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Check size={12} className="text-green-500" />
        )}
        <Icon size={12} />
        <span className="font-mono truncate">{label}</span>
      </summary>
      <div className="border-t border-border px-3 py-2">
        {args && (
          <pre className="whitespace-pre-wrap break-all font-mono opacity-80">
            {JSON.stringify(args, null, 2)}
          </pre>
        )}
        {result !== undefined && (
          <div className="mt-2 border-t border-border pt-2">
            <pre className="whitespace-pre-wrap break-all font-mono opacity-70">
              {typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
