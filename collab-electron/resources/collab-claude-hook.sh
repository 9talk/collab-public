#!/bin/bash
# Claude Code session hook: 将 Claude Code session 与 canvas tile 绑定
#
# 用法:
#   collab-claude-hook.sh <tileId>          # 从 stdin 读 JSON，记录 session_id
#   collab-claude-hook.sh                   # 只保存 JSON 到文件（不绑定）
#   collab-claude-hook.sh <tileId> < <file> # 从文件读 JSON
#
# stdin JSON 需包含 session_id 字段：
#   {"session_id": "abc123", ...}
#
# 当 tileId 和 session_id 均存在时，自动调用:
#   collab-canvas claude bind <tileId> <sessionId>

TILE_ID="${1:-}"

# 读取 stdin 的 JSON
INPUT=$(cat)

# 提取 session_id
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# 当 tileId 和 session_id 都存在时，记录绑定
if [ -n "$TILE_ID" ] && [ -n "$SESSION_ID" ]; then
  collab-canvas claude bind "$TILE_ID" "$SESSION_ID" 2>/dev/null || true
fi
