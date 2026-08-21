## Collaborator

本机已启用 Collaborator 的 Claude Code 深度集成，提供 `devtool` 服务管理能力。

### devtool

用于启动、停止、重启、检查项目服务（应用）。当你说「启动应用」「启动服务」「启动前端应用」「启动前端」「启动后端服务」「启动后端」时，优先使用本工具集，包含以下工具：

- `devtool_list`：列出所有由 Collaborator 管理的服务及其存活状态
- `devtool_start`：启动项目服务
- `devtool_restart`：重启项目服务（先停止整个进程组，再重新启动）
- `devtool_stop`：停止项目服务（终止整个进程组）
- `devtool_check`：检查指定项目服务的存活状态
- `devtool_logs`：查询项目服务的运行日志（默认返回末尾 200 行）

使用条件：

- 通过 `projectPath` 参数传入实际项目路径；使用 `.gitworktree` 时应传递 worktree 的路径
- 项目目录下必须存在 `start.sh`
