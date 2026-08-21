#!/usr/bin/env bash
# 由 Claude Code plugin mcpServers 拉起：用 Collaborator 主进程的 node（ELECTRON_RUN_AS_NODE）
# 运行同目录的 collab-mcp-server.mjs，把 MCP stdio 桥接到主进程 socket。
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(cat "$HOME/.collab/node-path" 2>/dev/null)" || true
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "error: collaborator is not running (no node-path file)" >&2
  exit 2
fi
ELECTRON_RUN_AS_NODE=1 exec "$NODE_BIN" "$DIR/collab-mcp-server.mjs" "$@"
