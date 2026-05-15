#!/bin/bash
# Local development installer — builds and installs Collaborator from source.
# Usage: ./scripts/install-local.sh

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building and packaging..."
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" \
  bun run --cwd "$PROJECT_DIR" package:unsigned

echo "Installing to /Applications..."
killall Collaborator 2>/dev/null || true
sleep 1
rm -rf /Applications/Collaborator.app
cp -R "$PROJECT_DIR/dist/mac-arm64/Collaborator.app" /Applications/Collaborator.app

echo "Cleaning up dist/..."
rm -rf "$PROJECT_DIR/dist"

echo "Done. Opening Collaborator..."
open /Applications/Collaborator.app
