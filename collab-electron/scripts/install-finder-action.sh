#!/bin/bash
# Installs the Finder quick action that sends selected paths to the focused
# terminal tile in Collaborator (via the collab-canvas CLI).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_WORKFLOW="$SCRIPT_DIR/../resources/collab-quick-action/CollaboratorSendPath.workflow"
DEST_WORKFLOW="$HOME/Library/Services/CollaboratorSendPath.workflow"

if [ ! -d "$SRC_WORKFLOW" ]; then
  echo "ERROR: quick action source not found: $SRC_WORKFLOW" >&2
  exit 1
fi

rm -rf "$DEST_WORKFLOW"
mkdir -p "$HOME/Library/Services"
cp -R "$SRC_WORKFLOW" "$DEST_WORKFLOW"

# Refresh the services registration so the menu item appears without re-login.
if [ -x /System/Library/CoreServices/pbs ]; then
  /System/Library/CoreServices/pbs -flush
fi

echo "Finder quick action installed: $DEST_WORKFLOW"
