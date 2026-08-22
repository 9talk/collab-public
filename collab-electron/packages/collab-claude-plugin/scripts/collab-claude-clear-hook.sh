#!/bin/bash
# Gate `collab-canvas terminal clear` on the settings toggle
# "调用 /clear 后清屏" (ui.claudeClearOnClear). Default: disabled.
# Runs the clear only when the toggle is explicitly enabled.

CFG="$HOME/.collab/config.json"

ENABLED=$(jq -r '.ui.claudeClearOnClear // false' "$CFG" 2>/dev/null)

case "$ENABLED" in
  true|1|yes|on) ;;
  *) exit 0 ;;
esac

TILE_ID="${1:-}"
if [ -n "$TILE_ID" ]; then
  collab-canvas terminal clear "$TILE_ID" 2>/dev/null || true
fi
