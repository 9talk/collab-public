#!/bin/bash
# update-mcp-project-path.sh - Update MCP project path from current directory
#
# Usage:
#   update-mcp-project-path.sh <project-path>
#
# This script is called on SessionStart to ensure MCP servers have the
# correct project context. Customize this script as needed.

PROJECT_PATH="${1:-$(pwd)}"

if [ -z "$PROJECT_PATH" ]; then
  exit 0
fi

# Export the project path for MCP context
# Customize this function for your MCP server configuration
update_mcp_config() {
  local config_file="$HOME/.claude/mcp.json"
  if [ -f "$config_file" ]; then
    # Update project path in MCP config if needed
    # This is a safe no-op by default - customize per your setup
    :
  fi
}

update_mcp_config
