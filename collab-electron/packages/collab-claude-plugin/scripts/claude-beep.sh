#!/bin/bash
# claude-beep.sh - Play built-in notification sounds based on event name
#
# Usage:
#   claude-beep.sh <event-name>
#
# Sound files are bundled with the plugin under sounds/claude/zh/<event>.mp3.
# Enabled events come from ~/.collab/claude-sounds.json:
#   - "enabled": master switch, if false no sound plays
#   - "<event-name>": true/false per-event checkbox
# Legacy path-string values are treated as enabled.
# If the config file is missing, a built-in default event set is used.
#
# Each play attempt is logged to ~/.collab/logs/claude-beep-YYYY-MM-DD.log
# (one file per day). Logs older than the current day are pruned.

EVENT="${1:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
SOUND_DIR="$PLUGIN_ROOT/sounds/claude/zh"

LOG_DIR="$HOME/.collab/logs"
LOG_FILE="$LOG_DIR/claude-beep-$(date +%Y-%m-%d).log"

log() {
  printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*" >>"$LOG_FILE"
}

prune_logs() {
  mkdir -p "$LOG_DIR"
  local today day
  today="$(date +%Y-%m-%d)"
  for f in "$LOG_DIR"/claude-beep-*.log; do
    [ -e "$f" ] || continue
    day="${f##*/}"
    day="${day#claude-beep-}"
    day="${day%.log}"
    [[ "$day" < "$today" ]] && rm -f "$f"
  done
}

prune_logs

if [ -z "$EVENT" ]; then
  log "skip NO-EVENT"
  exit 0
fi

SOUND_FILE="$SOUND_DIR/$EVENT.mp3"
if [ ! -f "$SOUND_FILE" ]; then
  log "skip NO-BUNDLED-SOUND event=$EVENT"
  exit 0
fi

CONFIG="$HOME/.collab/claude-sounds.json"
STATUS="default"
if [ -f "$CONFIG" ]; then
  export CLAUDE_SOUND_EVENT="$EVENT"
  STATUS=$(python3 <<-'PYEOF' 2>/dev/null
import json, os
cfg = os.path.expanduser("~/.collab/claude-sounds.json")
event = os.environ.get("CLAUDE_SOUND_EVENT", "")
try:
    with open(cfg) as f:
        data = json.load(f)
    if not data.get("enabled", True):
        print("__DISABLED__")
        exit(0)
    value = data.get(event, "")
    if value is True:
        print("true")
    elif value is False:
        print("false")
    elif isinstance(value, str) and value:
        print("true")
except Exception:
    pass
PYEOF
)
  [ -z "$STATUS" ] && STATUS="default"
fi

case "$STATUS" in
  __DISABLED__)
    log "skip DISABLED event=$EVENT"
    exit 0
    ;;
  false)
    log "skip OFF event=$EVENT"
    exit 0
    ;;
esac

# 无配置文件时的默认开启事件（与默认配置保持一致）
if [ "$STATUS" = "default" ]; then
  case "$EVENT" in
    UserPromptSubmit|Stop|Notification|PermissionRequest|PreCompact) ;;
    *)
      log "skip DEFAULT-OFF event=$EVENT"
      exit 0
      ;;
  esac
fi

if err="$(afplay "$SOUND_FILE" 2>&1)"; then
  log "play OK event=$EVENT sound=$SOUND_FILE"
else
  log "play FAIL event=$EVENT sound=$SOUND_FILE err=${err:-unknown}"
fi
