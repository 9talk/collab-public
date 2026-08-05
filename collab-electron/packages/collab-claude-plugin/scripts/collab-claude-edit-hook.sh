#!/bin/bash
# Claude Code PostToolUse hook: forward file-edit events to Collaborator
#
# Usage:
#   collab-claude-edit-hook.sh <tileId>   # Read JSON from stdin, forward via collab-canvas
#   collab-claude-edit-hook.sh            # Without tileId: only save JSON to a file
#
# stdin JSON (PostToolUse with Edit|Write|MultiEdit|NotebookEdit matcher):
#   {
#     "tool_name": "Edit",
#     "tool_input": {
#       "file_path": "/abs/path",
#       "old_string": "...",
#       "new_string": "..."
#     },
#     "tool_result": { ... },
#     "session_id": "abc123",
#     "cwd": "/working/dir",
#     "exact_path": "/abs/path",
#     ...
#   }
#
# The event is persisted to a numbered temp file, then (when a tileId is
# given) forwarded to the Collaborator main process via:
#   collab-canvas claude edit <tileId> <file>

TILE_ID="${1:-}"

# Read stdin JSON
INPUT=$(cat)

# Persist the event for debugging / replay
EVENT_DIR="${TMPDIR:-/tmp}/collab-claude-events"
mkdir -p "$EVENT_DIR" 2>/dev/null || true
SEQ=0
while [ -f "$EVENT_DIR/event-$SEQ.json" ]; do
  SEQ=$((SEQ + 1))
done
EVENT_FILE="$EVENT_DIR/event-$SEQ.json"
printf '%s\n' "$INPUT" > "$EVENT_FILE"

# Forward to Collaborator when bound to a tile
if [ -n "$TILE_ID" ]; then
  collab-canvas claude edit "$TILE_ID" "$EVENT_FILE" 2>/dev/null || true
fi
