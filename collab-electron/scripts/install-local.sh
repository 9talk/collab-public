#!/bin/bash
# Local development installer — builds and installs Collaborator from source.
# Usage:
#   ./scripts/install-local.sh            # default: removes old app, cleans dist
#   ./scripts/install-local.sh --keep     # keeps old app and dist

set -euo pipefail

KEEP=false
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=true ;;
  esac
done

# Resolve project root (one level up from scripts/)
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

BUILD_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Build time: $BUILD_TIME"

# Step 1: Clean build artifacts to avoid stale files
echo "Cleaning build artifacts..."
rm -rf "$PROJECT_DIR/out" "$PROJECT_DIR/dist"

# Step 2: Build + package with China-friendly electron mirror
echo "Building and packaging..."
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
  bun run --cwd "$PROJECT_DIR" package:unsigned -- --arch arm64

# Step 3: Replace the installed app
echo "Installing to /Applications..."

# 3a: 删除旧应用，确保删除干净（文件夹不存在）
if [ -d /Applications/Collaborator.app ]; then
  echo "Removing old Collaborator.app..."
  rm -rf /Applications/Collaborator.app

  # 循环检查直到确认删除成功
  RETRY=0
  MAX_RETRIES=10
  while [ -d /Applications/Collaborator.app ] && [ $RETRY -lt $MAX_RETRIES ]; do
    echo "  Old app still exists, retrying removal (attempt $((RETRY + 2)))..."
    sleep 0.5
    rm -rf /Applications/Collaborator.app
    RETRY=$((RETRY + 1))
  done

  if [ -d /Applications/Collaborator.app ]; then
    echo "ERROR: Failed to remove old Collaborator.app after $MAX_RETRIES attempts." >&2
    exit 1
  fi
  echo "  Old app removed successfully."
fi

# 3b: 安装新应用
SOURCE_APP="$PROJECT_DIR/dist/mac-arm64/Collaborator.app"
DEST_APP="/Applications/Collaborator.app"

cp -R "$SOURCE_APP" "$DEST_APP"

# 3c: 验证安装结果 — 对比源目录和目标目录，确保是新构建的版本
echo "Verifying installation..."
DIFF_OUTPUT="$(diff -rq "$SOURCE_APP" "$DEST_APP" 2>&1)" || true
if [ -n "$DIFF_OUTPUT" ]; then
  echo "ERROR: Installed app does not match the built version:" >&2
  echo "$DIFF_OUTPUT" >&2
  exit 1
fi
echo "  Installation verified — installed app matches built version."

# Step 4: Clean up build artifacts (unless --keep)
if [ "$KEEP" = false ]; then
  echo "Cleaning up dist/..."
  rm -rf "$PROJECT_DIR/dist"
fi

# Step 5: Notify completion
echo "Done. App installed at /Applications/Collaborator.app"
