#!/bin/bash
# Claude Code session hook: bind Claude Code session to a canvas tile
#
# Usage:
#   collab-claude-hook.sh <tileId>          # Read JSON from stdin, record session_id
#   collab-claude-hook.sh                   # Only save JSON to a file (no binding)
#   collab-claude-hook.sh <tileId> < <file> # Read JSON from a file
#
# stdin JSON must include a session_id field:
#   {"session_id": "abc123", ...}
#
# When both tileId and session_id are present, automatically calls:
#   collab-canvas claude bind <tileId> <sessionId>

TILE_ID="${1:-}"

# Read stdin JSON
INPUT=$(cat)

# Extract session_id
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# When both tileId and session_id exist, record the binding
if [ -n "$TILE_ID" ] && [ -n "$SESSION_ID" ]; then
  collab-canvas claude bind "$TILE_ID" "$SESSION_ID" 2>/dev/null || true
fi
