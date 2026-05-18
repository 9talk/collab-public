#!/bin/bash
# Local development installer — builds and installs Collaborator from source.
# Usage: ./scripts/install-local.sh

set -euo pipefail

# Resolve project root (one level up from scripts/)
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Step 1: Build + package with China-friendly electron mirror
echo "Building and packaging..."
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
  bun run --cwd "$PROJECT_DIR" package:unsigned

# Give file system a moment to settle, then replace the installed app
sleep 1
rm -rf /Applications/Collaborator.app
cp -R "$PROJECT_DIR/dist/mac-arm64/Collaborator.app" /Applications/Collaborator.app

# Step 2: Clean up build artifacts
echo "Cleaning up dist/..."
rm -rf "$PROJECT_DIR/dist"

# Step 3: Kill any running instance before launching the new one
echo "Installing to /Applications..."
kill $(pgrep -f "Collaborator.app/Contents/MacOS/Collaborator") 2>/dev/null || true

# Step 4: Launch the freshly installed app
echo "Done. Opening Collaborator..."
open /Applications/Collaborator.app
