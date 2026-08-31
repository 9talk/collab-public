#!/usr/bin/env node
// collab-mcp-server.mjs — MCP stdio server
// 由 Claude Code 通过 plugin 的 mcpServers 拉起（collab-mcp-server.sh 包装）。
// 将 MCP tools/call 转发为 Collaborator 主进程 Unix socket 上的 JSON-RPC 调用。
// 无第三方依赖，协议层为 newline-delimited JSON-RPC（与 MCP stdio 传输一致）。
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCKET_FILE = join(homedir(), ".collab", "socket-path");
const SERVER_INFO = { name: "devtool", version: "0.1.0" };
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "devtool_start",
    description:
      "在指定项目目录启动服务，要求该目录下存在 start.sh 或 scripts/start.sh 脚本，否则报错。脚本必须是后台型的：启动服务进程后立即退出（exit 0），不能前台阻塞运行，否则判定超时失败。脚本通过 stdout 按行输出约定标记上报信息：COLLAB_PID:<pid>（必需，未上报判定启动失败 no-pid）、COLLAB_HTTP_PORT:<port>（HTTP 端口）、COLLAB_MESSAGE:<文本>（成功提示，如访问地址）、COLLAB_ERROR:<文本>（失败原因）。返回服务状态，status 为 running 即启动成功。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "项目目录的绝对路径" },
      },
      required: ["projectPath"],
    },
  },
  {
    name: "devtool_restart",
    description:
      "重启指定项目目录的服务：先停止整个进程组，再重新执行该目录下的启动脚本（start.sh 或 scripts/start.sh）。脚本要求与 devtool_start 相同：必须为后台型（启动服务进程后立即退出），并通过 stdout 输出 COLLAB_PID/COLLAB_HTTP_PORT/COLLAB_MESSAGE/COLLAB_ERROR 约定标记。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "项目目录的绝对路径" },
      },
      required: ["projectPath"],
    },
  },
  {
    name: "devtool_stop",
    description:
      "停止指定项目目录的服务，终止其整个进程组（含 start.sh 拉起的子进程）。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "项目目录的绝对路径" },
      },
      required: ["projectPath"],
    },
  },
  {
    name: "devtool_check",
    description: "检查指定项目目录的服务当前存活状态。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "项目目录的绝对路径" },
      },
      required: ["projectPath"],
    },
  },
  {
    name: "devtool_list",
    description: "列出所有由 Collaborator 管理的服务及其存活状态。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "devtool_logs",
    description:
      "查询指定项目目录服务的日志内容，默认返回末尾 200 行，lines 传入 0 或负数时返回全部。",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: { type: "string", description: "项目目录的绝对路径" },
        lines: {
          type: "number",
          description: "返回日志末尾行数，默认 200；0 或负数返回全部",
        },
      },
      required: ["projectPath"],
    },
  },
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function rpcCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    let socketPath;
    try {
      socketPath = readFileSync(SOCKET_FILE, "utf-8").trim();
    } catch {
      reject(new Error("collaborator is not running (no socket-path file)"));
      return;
    }
    const payload =
      JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n";
    const sock = createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("socket rpc timeout"));
    }, 150_000);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      sock.destroy();
      try {
        const resp = JSON.parse(buf.slice(0, nl));
        if (resp.error) reject(new Error(resp.error.message));
        else resolve(resp.result);
      } catch (err) {
        reject(err);
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function handleToolsCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (!name || !TOOLS.some((t) => t.name === name)) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `Unknown tool: ${name}` },
    });
    return;
  }
  try {
    const result = await rpcCall(name, args);
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      },
    });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }
  const { id, method, params } = msg ?? {};
  if (method === "initialize") {
    const requested = params?.protocolVersion;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          typeof requested === "string" ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    });
    return;
  }
  if (
    method === "notifications/initialized" ||
    method === "notifications/cancelled"
  ) {
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    void handleToolsCall(id, params);
    return;
  }
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
});
