#!/bin/bash
# IntelliJ External Tool: 发送文件路径（含行号）到 Collaborator 聚焦 terminal
#
# IntelliJ 宏参数（按固定顺序传入）:
#   1 = $FilePathRelativeToProjectRoot$
#   2 = $SelectionStartLine$
#   3 = $SelectionEndLine$
#   4+ = $SelectedText$ 被 IntelliJ 按空白分割后的碎片
#        （有选中内容时至少产生 1 个碎片，无选中时为空 = 无额外参数）
#
# 注意：IDEA 侧 Arguments 必须给宏加双引号：
#   "$FilePathRelativeToProjectRoot$" $SelectionStartLine$ $SelectionEndLine$ "$SelectedText$"

FILE_PATH="$1"
START_LINE="$2"
END_LINE="$3"

# $4+ 存在意味着 $SelectedText$ 非空（有选中文本）
HAS_SELECTION=false
[ $# -gt 3 ] && HAS_SELECTION=true

if [ -n "$FILE_PATH" ]; then
  if [ -n "$START_LINE" ] && [ "$START_LINE" != "0" ] && [ -n "$END_LINE" ] && [ "$END_LINE" != "0" ] && [ "$END_LINE" -gt "$START_LINE" ]; then
    # 多行选中（起止行差 >= 1）→ @"path"#Lstart-end
    OUTPUT=" @\"${FILE_PATH}\"#L${START_LINE}-${END_LINE} "
  elif [ -n "$START_LINE" ] && [ "$START_LINE" != "0" ] && [ "$END_LINE" != "0" ] && $HAS_SELECTION; then
    # 单行有选中文本 → @"path"#L行号
    OUTPUT=" @\"${FILE_PATH}\"#L${START_LINE} "
  else
    # 无选中文本 → @"path"（引号包住以防路径含空格）
    OUTPUT=" @\"${FILE_PATH}\" "
  fi
else
  exit 1
fi

exec collab-canvas terminal write-focused "$OUTPUT"
