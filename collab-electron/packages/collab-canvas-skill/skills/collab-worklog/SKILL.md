# Collaborator Work Log

记录并回顾 Claude Code 的工作过程。**仅当用户明确要求**回顾/总结历史工作
(如「今天做了什么」「最近在这个项目的进展」「帮我写日报」)时使用;日常
任务不要主动读取记录。

## 记录位置

`~/.collab/worklog/YYYY-MM-DD.jsonl`(本地时区日期),一行一条:

| 字段         | 含义                                                  |
| ------------ | ----------------------------------------------------- |
| `ts`         | 提问时间(ISO, 带时区偏移)                             |
| `session_id` | Claude Code 会话 id                                   |
| `cwd`        | 提问时的工作目录(项目路径)                            |
| `prompt`     | 用户输入原文                                          |
| `transcript` | 该会话的完整对话文件路径(`~/.claude/projects/...` 下) |

## 查询方式

按用户的时间范围直接读对应日期文件;`jq` 过滤,例如:

```bash
# 某天全部记录
cat ~/.collab/worklog/2026-10-09.jsonl | jq -c '{ts,cwd,prompt}'

# 某项目(按 cwd 前缀)某天的提问
jq -r 'select(.cwd | startswith("/path/to/project")) | "\(.ts) \(.prompt)"' \
  ~/.collab/worklog/2026-10-09.jsonl
```

## 汇总与深入

- 总结「做了什么」:按 cwd 分组读 prompt;需要了解结果(回答、改了哪些
  文件、跑了什么命令)时,顺 `transcript` 字段读取完整对话文件再归纳。
- 写日报/总结:默认覆盖用户指定的日期范围,按项目(cwd)组织,结论里
  引用关键 prompt 与主要改动;除非用户要求,不要逐条罗列流水账。
- 同一记录文件可能很大:先 `head`/`tail` 或 jq 过滤,避免整文件直读。
