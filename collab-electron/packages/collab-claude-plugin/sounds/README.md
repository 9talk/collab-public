# Sound Configuration for Collaborator Canvas Claude Code Plugin

Sound notifications are configured through the Collaborator settings UI.

## How it works

- Sound files are bundled with the plugin under `sounds/claude/zh/<event>.mp3`
- Sound settings are stored in `~/.collab/claude-sounds.json` as a master
  `enabled` switch plus a per-event `true/false` checkbox
- `claude-beep.sh <event>` plays `sounds/claude/zh/<event>.mp3` when the event
  is enabled and the file exists
- If the config file is missing, a built-in default set is used
  (UserPromptSubmit, Stop, Notification, PermissionRequest, PreCompact)

## Configurable Events

- UserPromptSubmit — Played when user submits a prompt
- Stop — Played when Claude stops responding
- Notification — Played on Claude's "stop" notification
- PermissionRequest — Played when a permission is requested
- PreCompact — Played before context compaction
- SessionStart — Played when a session starts
- SessionEnd — Played when a session ends
- PreToolUse — Played before a tool runs
- PostToolUseFailure — Played when a tool fails
- SubagentStart — Played when a subagent starts
- SubagentStop — Played when a subagent stops

## Customizing

Use the Collaborator Settings UI (Claude → Sound section) to:

1. Toggle the master sound switch
2. Check each event you want sound for — no file selection needed
