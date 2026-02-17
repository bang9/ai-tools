#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PLUGIN_ROOT/bin"
MCP_BINARY="$BIN_DIR/memex-mcp"

REPO="bang9/ai-tools"

# Check if binary exists and is executable
if [ -x "$MCP_BINARY" ]; then
    exit 0
fi

mkdir -p "$BIN_DIR"

# Detect OS and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

case "$OS" in
    darwin|linux) ;;
    mingw*|msys*|cygwin*) OS="windows" ;;
    *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

BINARY_NAME="memex-mcp-${OS}-${ARCH}"
if [ "$OS" = "windows" ]; then
    BINARY_NAME="${BINARY_NAME}.exe"
fi

# Get latest release version from GitHub API
echo "Fetching latest release version..." >&2
VERSION=$(curl -sfSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)

if [ -z "$VERSION" ]; then
    echo "Failed to fetch latest version, using fallback v1.0.0" >&2
    VERSION="v1.0.0"
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY_NAME}"

echo "Downloading memex-mcp ${VERSION} from ${DOWNLOAD_URL}..." >&2

# Try to download pre-built binary
if command -v curl &> /dev/null; then
    if curl -fsSL -o "$MCP_BINARY" "$DOWNLOAD_URL"; then
        chmod +x "$MCP_BINARY"
        echo "memex-mcp ${VERSION} downloaded successfully" >&2
        exit 0
    fi
elif command -v wget &> /dev/null; then
    if wget -q -O "$MCP_BINARY" "$DOWNLOAD_URL"; then
        chmod +x "$MCP_BINARY"
        echo "memex-mcp ${VERSION} downloaded successfully" >&2
        exit 0
    fi
fi

echo "Failed to download pre-built binary. Trying to build from source..." >&2

# Fallback: try to build if Go is installed
if command -v go &> /dev/null; then
    echo "Building memex-mcp from source..." >&2
    cd "$PLUGIN_ROOT"
    go build -o "$MCP_BINARY" ./cmd/memex-mcp
    echo "memex-mcp built successfully" >&2
    exit 0
fi

echo "Error: Could not download binary and Go is not installed." >&2
echo "Please install Go or download the binary manually from:" >&2
echo "  ${DOWNLOAD_URL}" >&2
exit 1
