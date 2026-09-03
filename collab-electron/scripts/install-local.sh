#!/bin/bash
# Local development installer — builds and installs Collaborator from source.
# Usage:
#   ./scripts/install-local.sh                         # auto-detect arch, removes old app, cleans dist
#   ./scripts/install-local.sh --keep                  # keeps old app and dist
#   ./scripts/install-local.sh --remote                # build+install Collaborator Remote (standalone Client)
#   ./scripts/install-local.sh --arch=arm64            # force arm64 build
#   ./scripts/install-local.sh --arch=x64              # force amd64/x64 build

set -euo pipefail

START_TIME=$(date +%s)

KEEP=false
REMOTE=false
ARCH=""
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=true ;;
    --remote) REMOTE=true ;;
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
if [ "$REMOTE" = true ]; then
  echo "Flavor: remote (Collaborator Remote)"
  APP_NAME="Collaborator Remote.app"
  DIST_DIR="dist-remote"
  PACKAGE_CMD="package:remote:unsigned"
else
  echo "Flavor: full (Collaborator)"
  APP_NAME="Collaborator.app"
  DIST_DIR="dist"
  PACKAGE_CMD="package:unsigned"
fi


# Resolve project root (one level up from scripts/)
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

BUILD_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Build time: $BUILD_TIME"

# Step 1: Clean build artifacts to avoid stale files
echo "Cleaning build artifacts..."
rm -rf "$PROJECT_DIR/out" "$PROJECT_DIR/dist" "$PROJECT_DIR/dist-remote"

# Step 2: Build + package with China-friendly electron mirror
echo "Building and packaging..."
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
  bun run --cwd "$PROJECT_DIR" "$PACKAGE_CMD" -- --arch "$ARCH" --no-zip

# Step 3: Replace the installed app
echo "Installing to /Applications..."

# 3a: 删除旧应用，确保删除干净（文件夹不存在）
DEST_APP="/Applications/$APP_NAME"
if [ -d "$DEST_APP" ]; then
  echo "Removing old $APP_NAME..."
  rm -rf "$DEST_APP"

  # 循环检查直到确认删除成功
  RETRY=0
  MAX_RETRIES=10
  while [ -d "$DEST_APP" ] && [ $RETRY -lt $MAX_RETRIES ]; do
    echo "  Old app still exists, retrying removal (attempt $((RETRY + 2)))..."
    sleep 0.5
    rm -rf "$DEST_APP"
    RETRY=$((RETRY + 1))
  done

  if [ -d "$DEST_APP" ]; then
    echo "ERROR: Failed to remove old $APP_NAME after $MAX_RETRIES attempts." >&2
    exit 1
  fi
  echo "  Old app removed successfully."
fi

# 3b: 安装新应用 (electron-builder output: arm64 → <dist>/mac-arm64, x64 → <dist>/mac)
if [ "$ARCH" = "arm64" ]; then
  SOURCE_APP="$PROJECT_DIR/$DIST_DIR/mac-arm64/$APP_NAME"
else
  SOURCE_APP="$PROJECT_DIR/$DIST_DIR/mac/$APP_NAME"
fi

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

# Step 4: 清理 Claude Code 插件缓存，确保 hooks/脚本加载新版本
# Claude Code 会把插件复制到 ~/.claude/plugins/cache/ 并从缓存读取配置，
# 本地重装后缓存不刷新会导致 hooks 等仍用旧版，故此处删除让其重新缓存。
echo "Clearing Claude Code plugin cache..."
rm -rf "$HOME/.claude/plugins/cache/collaborator"

# Step 5: Clean up build artifacts (unless --keep)
if [ "$KEEP" = false ]; then
  echo "Cleaning up $DIST_DIR/..."
  rm -rf "$PROJECT_DIR/$DIST_DIR"
fi

# Step 6: Notify completion
echo "Done. App installed at $DEST_APP"

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
echo "Build took ${ELAPSED}s"
