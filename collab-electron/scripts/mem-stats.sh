#!/bin/bash
# Collaborator 内存占用统计脚本
# 采集 3 次取 RSS 均值
# 用法: bash scripts/mem-stats.sh

set -euo pipefail

MAIN_PID=$(pgrep -x "Collaborator" | head -1)
if [[ -z "$MAIN_PID" ]]; then
  echo "Collaborator 未运行"
  exit 1
fi

get_descendants() {
  local pid="$1"
  local result="$pid"
  local children
  children=$(pgrep -P "$pid" 2>/dev/null || true)
  for c in $children; do
    result="$result $(get_descendants "$c")"
  done
  echo "$result"
}

SAMPLE_COUNT=3
TOTAL_SAMPLES=""

echo ""
echo "=== Collaborator 内存占用 (采集 $SAMPLE_COUNT 次取均值, $(date +%H:%M:%S)) ==="
echo ""

for ((s=1; s<=SAMPLE_COUNT; s++)); do
  sleep 1

  ALL_PIDS=$(get_descendants "$MAIN_PID" | tr ' ' '\n' | sort -nu)
  TMPFILE=$(mktemp)
  trap 'rm -f "$TMPFILE"' EXIT

  for pid in $ALL_PIDS; do
    read -r rss args <<< "$(ps -o rss= -o args= -p "$pid" 2>/dev/null || true)"
    [[ -z "$rss" || "$rss" == "0" ]] && continue
    rss_bytes=$((rss * 1024))

    if [[ "$pid" == "$MAIN_PID" ]]; then
      label="主进程"
    elif echo "$args" | grep -q -- "--type=gpu-process"; then
      label="GPU 进程"
    elif echo "$args" | grep -q -- "--type=utility.*NetworkService"; then
      label="网络服务"
    elif echo "$args" | grep -q -- "--type=utility.*NodeService"; then
      label="节点服务"
    elif echo "$args" | grep -q -- "--type=utility"; then
      label="工具进程"
    elif echo "$args" | grep -q "pty-sidecar"; then
      label="PTY 服务"
    elif echo "$args" | grep -qE "(^|/)(zsh|bash|fish|dash)( |$)"; then
      base=$(echo "$args" | awk '{print $1}' | xargs basename 2>/dev/null || echo "shell")
      label="Shell ($base)"
    elif echo "$args" | grep -q "claude"; then
      label="Claude Code"
    elif echo "$args" | grep -qE "(^|/)node( |\$)"; then
      label="Node.js 工具"
    elif echo "$args" | grep -q -- "--type=renderer"; then
      if echo "$args" | grep -qF -- "--enable-blink-features"; then
        label="Webview 渲染"
      else
        label="主窗口渲染"
      fi
    else
      label="其他"
    fi

    echo "$label|$rss_bytes" >> "$TMPFILE"
  done

  echo "  第 $s 次采样:"
  awk -F'|' '
    {a[$1]+=$2; c[$1]++}
    END{for(k in a) printf "    %-20s %3d 个  %5d MB\n", k, c[k], int(a[k]/1024/1024)}
  ' "$TMPFILE" | sort

  # 收集总 RSS（字节）用于后续平均
  sample_total=$(awk -F'|' '{s+=$2} END{printf "%.0f", s}' "$TMPFILE")
  TOTAL_SAMPLES="$TOTAL_SAMPLES $sample_total"
  echo ""
done

# 算均值和偏差
sum=0
min=""
max=""
for v in $TOTAL_SAMPLES; do
  sum=$((sum + v))
  if [[ -z "$min" || "$v" -lt "$min" ]]; then min=$v; fi
  if [[ -z "$max" || "$v" -gt "$max" ]]; then max=$v; fi
done

avg=$((sum / SAMPLE_COUNT / 1024 / 1024))
min_mb=$((min / 1024 / 1024))
max_mb=$((max / 1024 / 1024))
echo "  ─────────────────────────────────"
printf "  总计 (均值)                    %5d MB\n" "$avg"
printf "  范围                   %5d ~ %5d MB\n" "$min_mb" "$max_mb"
echo ""