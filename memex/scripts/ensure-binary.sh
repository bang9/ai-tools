#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
DIST_FILE="$PLUGIN_ROOT/dist/mcp.js"

# Check if already built
if [ -f "$DIST_FILE" ]; then
    exit 0
fi

echo "Building memex..." >&2

cd "$PLUGIN_ROOT"

# Install dependencies and build
if command -v pnpm &> /dev/null; then
    pnpm install --frozen-lockfile 2>&1 >&2 || pnpm install 2>&1 >&2
    pnpm run build 2>&1 >&2
elif command -v npm &> /dev/null; then
    npm ci 2>&1 >&2 || npm install 2>&1 >&2
    npm run build 2>&1 >&2
else
    echo "Error: pnpm or npm is required to build memex." >&2
    echo "Install Node.js from https://nodejs.org/" >&2
    exit 1
fi

echo "memex built successfully" >&2
