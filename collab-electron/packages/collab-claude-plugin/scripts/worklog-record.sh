#!/bin/bash
# Claude Code UserPromptSubmit hook: 把本次 prompt 记录到工作记录 jsonl。
#
# 从 stdin 读取 hook JSON, 追加一行到 ~/.collab/worklog/YYYY-MM-DD.jsonl
# (本地时区)。缺 session_id/prompt 或任何写入失败都静默跳过, 绝不阻塞
# Claude Code。
set -u

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

[ -z "$SESSION_ID" ] && exit 0
[ -z "$PROMPT" ] && exit 0

WORKLOG_DIR="${HOME}/.collab/worklog"
mkdir -p "$WORKLOG_DIR" 2>/dev/null || exit 0

TS=$(date +"%Y-%m-%dT%H:%M:%S%z")
FILE="${WORKLOG_DIR}/$(date +%F).jsonl"

jq -nc \
  --arg ts "$TS" \
  --arg session_id "$SESSION_ID" \
  --arg cwd "$CWD" \
  --arg prompt "$PROMPT" \
  --arg transcript "$TRANSCRIPT" \
  '{ts:$ts, session_id:$session_id, cwd:$cwd, prompt:$prompt, transcript:$transcript}' \
  >> "$FILE" 2>/dev/null || true
exit 0
