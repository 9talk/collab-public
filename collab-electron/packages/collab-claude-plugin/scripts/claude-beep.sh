#!/bin/bash
# claude-beep.sh - Play notification sounds based on event name
#
# Usage:
#   claude-beep.sh <event-name>
#
# Reads ~/.collaborator/claude-sounds.json for:
#   - "enabled": if false, no sound plays
#   - "<event-name>": path to sound file for that event
# If the event has no configured sound file, no sound is played.

EVENT="${1:-}"
[ -z "$EVENT" ] && exit 0

CONFIG="$HOME/.collaborator/claude-sounds.json"
[ ! -f "$CONFIG" ] && exit 0

export CLAUDE_SOUND_EVENT="$EVENT"
SOUND=$(python3 <<-'PYEOF' 2>/dev/null
import json, os
cfg = os.path.expanduser("~/.collaborator/claude-sounds.json")
event = os.environ.get("CLAUDE_SOUND_EVENT", "")
try:
    with open(cfg) as f:
        data = json.load(f)
    # Check master enabled flag
    if not data.get("enabled", True):
        exit(0)
    path = data.get(event, "")
    if path:
        print(path)
except Exception:
    pass
PYEOF
)

# Exit if python3 produced no output (event not found)
[ -z "$SOUND" ] && exit 0

[ -f "$SOUND" ] && afplay "$SOUND" 2>/dev/null || true
