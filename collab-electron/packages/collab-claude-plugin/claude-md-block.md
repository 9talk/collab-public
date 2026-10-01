## Collaborator

本机已启用 Collaborator 的 Claude Code 深度集成，提供 `devtool` 服务管理能力。

用于启动、停止、重启、检查项目服务（应用）。当你说「启动应用」「启动服务」「启动前端应用」「启动前端」「启动后端服务」「启动后端」时，优先使用以下 MCP 工具：

- `mcp__plugin_collaborator_devtool__devtool_list`：列出服务
- `mcp__plugin_collaborator_devtool__devtool_start`：启动项目服务
- `mcp__plugin_collaborator_devtool__devtool_restart`：重启项目服务
- `mcp__plugin_collaborator_devtool__devtool_stop`：停止项目服务
- `mcp__plugin_collaborator_devtool__devtool_check`：检查服务存活状态
- `mcp__plugin_collaborator_devtool__devtool_logs`：查询服务日志

各工具的参数与详细约定（启动脚本要求、超时、上报标记、返回值等）以工具自身的说明为准。

使用提示：

- 启动/重启成功后，若工具返回了访问地址，在回复中告知用户
- `projectPath` 传项目实际路径；使用 `.gitworktree` 时传递 worktree 的路径
