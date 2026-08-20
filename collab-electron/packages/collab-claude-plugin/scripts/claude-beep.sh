#!/bin/bash
# claude-beep.sh - Play notification sounds based on event name
#
# Usage:
#   claude-beep.sh <event-name>
#
# Reads ~/.collab/claude-sounds.json for:
#   - "enabled": if false, no sound plays
#   - "<event-name>": path to sound file for that event
# If the event has no configured sound file, no sound is played.
#
# Each play attempt is logged to ~/.collab/logs/claude-beep-YYYY-MM-DD.log
# (one file per day). Logs older than the current day are pruned.

EVENT="${1:-}"

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

CONFIG="$HOME/.collab/claude-sounds.json"
if [ ! -f "$CONFIG" ]; then
  log "skip NO-CONFIG event=$EVENT"
  exit 0
fi

export CLAUDE_SOUND_EVENT="$EVENT"
SOUND=$(python3 <<-'PYEOF' 2>/dev/null
import json, os
cfg = os.path.expanduser("~/.collab/claude-sounds.json")
event = os.environ.get("CLAUDE_SOUND_EVENT", "")
try:
    with open(cfg) as f:
        data = json.load(f)
    # Check master enabled flag
    if not data.get("enabled", True):
        print("__DISABLED__")
        exit(0)
    path = data.get(event, "")
    if path:
        print(path)
except Exception:
    pass
PYEOF
)

if [ "$SOUND" = "__DISABLED__" ]; then
  log "skip DISABLED event=$EVENT"
  exit 0
fi

# No sound configured for this event
if [ -z "$SOUND" ]; then
  log "skip NO-SOUND event=$EVENT"
  exit 0
fi

if [ ! -f "$SOUND" ]; then
  log "skip MISSING event=$EVENT sound=$SOUND"
  exit 0
fi

if err="$(afplay "$SOUND" 2>&1)"; then
  log "play OK event=$EVENT sound=$SOUND"
else
  log "play FAIL event=$EVENT sound=$SOUND err=${err:-unknown}"
fi
