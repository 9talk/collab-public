#!/bin/bash
# Local development installer — builds and installs Collaborator from source.
# Usage:
#   ./scripts/install-local.sh                         # auto-detect arch, removes old app, cleans dist
#   ./scripts/install-local.sh --keep                  # keeps old app and dist
#   ./scripts/install-local.sh --arch=arm64            # force arm64 build
#   ./scripts/install-local.sh --arch=x64              # force amd64/x64 build

set -euo pipefail

START_TIME=$(date +%s)

KEEP=false
ARCH=""
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=true ;;
    --arch=*) ARCH="${arg#--arch=}" ;;
    --arch) echo "ERROR: --arch requires a value (e.g., --arch=arm64)" >&2; exit 1 ;;
  esac
done

# Auto-detect architecture if not specified
if [ -z "$ARCH" ]; then
  MACHINE="$(uname -m)"
  case "$MACHINE" in
    x86_64) ARCH="x64" ;;
    arm64) ARCH="arm64" ;;
    *) echo "ERROR: Unsupported architecture: $MACHINE" >&2; exit 1 ;;
  esac
fi

# Validate architecture
case "$ARCH" in
  x64|arm64) ;;
  *) echo "ERROR: Unsupported arch: $ARCH (use x64 or arm64)" >&2; exit 1 ;;
esac

echo "Building for architecture: $ARCH"

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
  bun run --cwd "$PROJECT_DIR" package:unsigned -- --arch "$ARCH" --no-zip

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

# 3b: 安装新应用 (electron-builder output: arm64 → dist/mac-arm64, x64 → dist/mac)
if [ "$ARCH" = "arm64" ]; then
  SOURCE_APP="$PROJECT_DIR/dist/mac-arm64/Collaborator.app"
else
  SOURCE_APP="$PROJECT_DIR/dist/mac/Collaborator.app"
fi
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

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
echo "Build took ${ELAPSED}s"
