export const CLAUDE_SOUND_EVENTS = [
  "UserPromptSubmit",
  "Stop",
  "Notification",
  "PermissionRequest",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
] as const;

export type ClaudeSoundEvent = (typeof CLAUDE_SOUND_EVENTS)[number];

// 默认开启的事件参考历史 ~/.collab/claude-sounds.json 里已启用的 5 项，
// 其余内置声音事件默认关闭。
export const DEFAULT_CLAUDE_SOUNDS: Record<ClaudeSoundEvent, boolean> = {
  UserPromptSubmit: true,
  Stop: true,
  Notification: true,
  PermissionRequest: true,
  PreCompact: true,
  SessionStart: false,
  SessionEnd: false,
  PreToolUse: false,
  PostToolUseFailure: false,
  SubagentStart: false,
  SubagentStop: false,
};
