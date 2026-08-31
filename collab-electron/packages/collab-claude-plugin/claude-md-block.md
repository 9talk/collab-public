## Collaborator

本机已启用 Collaborator 的 Claude Code 深度集成，提供 `devtool` 服务管理能力。

### devtool

用于启动、停止、重启、检查项目服务（应用）。当你说「启动应用」「启动服务」「启动前端应用」「启动前端」「启动后端服务」「启动后端」时，优先使用本工具集，包含以下工具：

- `devtool_list`：列出当前存活的（running）服务；每次调用会先清理超过 1 天的已退出记录
- `devtool_start`：启动项目服务；启动脚本必须为后台型（启动服务进程后立即退出，通过 stdout 上报 `COLLAB_PID:` 等约定标记），否则判定失败；启动成功后，在回复中向用户提示浏览器访问地址（如 `http://localhost:[port]`）
- `devtool_restart`：重启项目服务（先停止整个进程组，再重新启动）；脚本要求同 `devtool_start`，重启成功后同样提示浏览器访问地址（如 `http://localhost:[port]`）
- `devtool_stop`：停止项目服务（终止整个进程组）
- `devtool_check`：检查指定项目服务的存活状态
- `devtool_logs`：查询项目服务的运行日志（默认返回末尾 200 行）

使用条件：

- 通过 `projectPath` 参数传入实际项目路径；使用 `.gitworktree` 时应传递 worktree 的路径
- 项目目录下必须存在 `start.sh`
