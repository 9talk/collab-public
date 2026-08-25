import { registerMethod } from "./json-rpc-server";
import * as services from "./service-manager";

function requireProjectPath(params: unknown): string {
  const projectPath = (params as { projectPath?: unknown } | null)?.projectPath;
  if (typeof projectPath !== "string" || projectPath.trim() === "") {
    throw new Error("projectPath is required");
  }
  return projectPath;
}

/**
 * 注册 devtool_* JSON-RPC 方法，供 stdio MCP 桥接进程（plugin 内的
 * collab-mcp-server.mjs）通过 Unix socket 转发调用。服务管理逻辑在
 * service-manager 中，随 Collaborator 常驻。
 */
export function registerServiceRpc(): void {
  registerMethod(
    "devtool_start",
    async (params) => services.startService(requireProjectPath(params)),
    {
      description:
        "在指定项目目录启动服务，要求该目录下存在 start.sh 脚本，否则报错。返回服务状态。",
      params: { projectPath: "string (required)" },
    },
  );

  registerMethod(
    "devtool_restart",
    async (params) => services.restartService(requireProjectPath(params)),
    {
      description:
        "重启指定项目目录的服务：先停止整个进程组，再重新执行该目录下的 start.sh。",
      params: { projectPath: "string (required)" },
    },
  );

  registerMethod(
    "devtool_stop",
    async (params) => services.stopService(requireProjectPath(params)),
    {
      description:
        "停止指定项目目录的服务，终止其整个进程组（含 start.sh 拉起的子进程）。",
      params: { projectPath: "string (required)" },
    },
  );

  registerMethod(
    "devtool_check",
    (params) => services.checkService(requireProjectPath(params)),
    {
      description: "检查指定项目目录的服务当前存活状态。",
      params: { projectPath: "string (required)" },
    },
  );

  registerMethod("devtool_list", () => services.listServices(), {
    description:
      "列出当前存活的（running）服务；每次调用会先清理超过 1 天的已退出记录。",
    params: {},
  });

  registerMethod(
    "devtool_logs",
    (params) =>
      services.readServiceLogs(
        requireProjectPath(params),
        (params as { lines?: unknown } | null)?.lines as number | undefined,
      ),
    {
      description:
        "查询指定项目目录服务的日志内容，默认返回末尾 200 行，lines 传入 0 或负数时返回全部。",
      params: {
        projectPath: "string (required)",
        lines: "number (optional, 默认 200)",
      },
    },
  );
}
