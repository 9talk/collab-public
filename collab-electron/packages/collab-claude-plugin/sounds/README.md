# Sound Configuration for Collaborator Canvas Claude Code Plugin

Sound notifications are configured through the Collaborator settings UI.

## How it works

- Sound settings are stored in `~/.collaborator/claude-sounds.json`
- Each hook event maps to a sound file path
- `claude-beep.sh` reads this config and plays the configured sound
- If no sound file is configured for an event, nothing plays

## Configurable Events

- UserPromptSubmit — Played when user submits a prompt
- Stop — Played when Claude stops responding
- PermissionRequest — Played when a permission is requested
- PreCompact — Played before context compaction
- Setup — Played on session setup
- Notification — Played on Claude's "stop" notification

## Customizing

Use the Collaborator Settings UI (Claude → Sound section) to:

1. Enable sound notifications
2. Configure sound files for each event
3. The file browser lets you select .mp3, .wav, .aiff, or .m4a files
