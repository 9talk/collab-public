import { loadConfig, saveConfig, type AppConfig } from "./config";
import { registerMethod } from "./json-rpc-server";

interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  priority: "p0" | "p1" | "p2" | "p3" | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

function readTodos(): TodoItem[] {
  const config = loadConfig();
  const data = getPref(config, "todos");
  return Array.isArray(data) ? (data as TodoItem[]) : [];
}

function writeTodos(todos: TodoItem[]): void {
  const config = loadConfig();
  setPref(config, "todos", todos);
  saveConfig(config);
}

function getPref(config: AppConfig, key: string): unknown {
  return (
    (config as Record<string, unknown>)[key] ??
    (config.ui as Record<string, unknown>)?.[key]
  );
}

function setPref(config: AppConfig, key: string, value: unknown): void {
  if (!config.ui) config.ui = {};
  config.ui[key] = value;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function registerTodosRpc(): void {
  registerMethod(
    "todos.list",
    () => {
      return readTodos();
    },
    {
      description: "List all todos",
      params: {},
    },
  );

  registerMethod(
    "todos.add",
    (params: unknown) => {
      const p = params as { text: string; priority?: string; tags?: string[] };
      if (!p.text || typeof p.text !== "string") {
        throw new Error("text is required");
      }
      const todos = readTodos();
      const item: TodoItem = {
        id: generateId(),
        text: p.text,
        done: false,
        priority: (p.priority && ["p0", "p1", "p2", "p3"].includes(p.priority)
          ? p.priority
          : null) as TodoItem["priority"],
        tags: Array.isArray(p.tags) ? p.tags : [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
      };
      todos.unshift(item);
      writeTodos(todos);
      return item;
    },
    {
      description: "Add a new todo",
      params: {
        text: "string (required)",
        priority: "p0|p1|p2|p3 (optional)",
        tags: "string[] (optional)",
      },
    },
  );

  registerMethod(
    "todos.update",
    (params: unknown) => {
      const p = params as {
        id: string;
        text?: string;
        done?: boolean;
        priority?: string;
        tags?: string[];
      };
      if (!p.id || typeof p.id !== "string") {
        throw new Error("id is required");
      }
      const todos = readTodos();
      const idx = todos.findIndex((t) => t.id === p.id);
      if (idx < 0) throw new Error(`todo not found: ${p.id}`);
      const updated = { ...todos[idx] };
      if (p.text !== undefined) updated.text = p.text;
      if (p.done !== undefined) {
        updated.done = p.done;
        updated.completedAt = p.done ? Date.now() : null;
      }
      if (p.priority !== undefined) {
        updated.priority = ["p0", "p1", "p2", "p3"].includes(p.priority)
          ? (p.priority as TodoItem["priority"])
          : null;
      }
      if (p.tags !== undefined) updated.tags = p.tags;
      updated.updatedAt = Date.now();
      todos[idx] = updated;
      writeTodos(todos);
      return updated;
    },
    {
      description: "Update a todo",
      params: {
        id: "string (required)",
        text: "string (optional)",
        done: "boolean (optional)",
        priority: "p0|p1|p2|p3|null (optional)",
        tags: "string[] (optional)",
      },
    },
  );

  registerMethod(
    "todos.delete",
    (params: unknown) => {
      const p = params as { id: string };
      if (!p.id || typeof p.id !== "string") {
        throw new Error("id is required");
      }
      const todos = readTodos().filter((t) => t.id !== p.id);
      writeTodos(todos);
      return { deleted: true };
    },
    {
      description: "Delete a todo",
      params: { id: "string (required)" },
    },
  );
}
