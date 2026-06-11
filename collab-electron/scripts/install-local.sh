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
rm -rf /Applications/Collaborator.app
cp -R "$PROJECT_DIR/dist/mac-arm64/Collaborator.app" /Applications/Collaborator.app

# Step 4: Clean up build artifacts (unless --keep)
if [ "$KEEP" = false ]; then
  echo "Cleaning up dist/..."
  rm -rf "$PROJECT_DIR/dist"
fi

# Step 5: Notify completion
echo "Done. App installed at /Applications/Collaborator.app"
