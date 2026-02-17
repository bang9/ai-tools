#!/bin/bash
set -e

REPO="bang9/ai-tools"
INSTALL_DIR="$HOME/.local/bin"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }
error() { echo -e "${RED}$1${NC}" >&2; exit 1; }

# Check Node.js
if ! command -v node &> /dev/null; then
    error "Node.js is required. Install from https://nodejs.org/"
fi

# Get latest version
get_latest_version() {
    local version
    version=$(curl -sfSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)
    if [ -z "$version" ]; then
        error "Failed to fetch latest version from GitHub"
    fi
    echo "$version"
}

# Add to PATH
ensure_path() {
    local shell_profile=""
    if [ -n "$ZSH_VERSION" ] || [ "$(basename "$SHELL")" = "zsh" ]; then
        shell_profile="$HOME/.zshrc"
    elif [ -n "$BASH_VERSION" ] || [ "$(basename "$SHELL")" = "bash" ]; then
        shell_profile="${HOME}/.bash_profile"
        [ ! -f "$shell_profile" ] && shell_profile="$HOME/.bashrc"
    fi

    if echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
        return 0
    fi

    if [ -n "$shell_profile" ] && ! grep -q "$INSTALL_DIR" "$shell_profile" 2>/dev/null; then
        echo "" >> "$shell_profile"
        echo "# Added by memex installer" >> "$shell_profile"
        echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$shell_profile"
        warn "Added $INSTALL_DIR to PATH in $shell_profile"
        warn "Run 'source $shell_profile' or restart your terminal to use memex"
    fi
}

main() {
    echo "Setting up memex..."
    echo ""

    local version
    version=$(get_latest_version)

    echo "  Version:  $version"
    echo ""

    # Clone to temp dir, build, copy CLI
    local tmpdir
    tmpdir=$(mktemp -d)
    trap "rm -rf $tmpdir" EXIT

    info "Downloading source..."
    curl -sfSL "https://github.com/${REPO}/archive/refs/tags/${version}.tar.gz" | tar xz -C "$tmpdir" --strip-components=1

    cd "$tmpdir/memex"

    info "Installing dependencies..."
    if command -v pnpm &> /dev/null; then
        pnpm install --frozen-lockfile 2>/dev/null || pnpm install
    else
        npm ci 2>/dev/null || npm install
    fi

    info "Building..."
    npm run build

    # Install CLI
    mkdir -p "$INSTALL_DIR"
    cp dist/cli.js "${INSTALL_DIR}/memex"
    chmod +x "${INSTALL_DIR}/memex"

    ensure_path

    echo ""
    info "memex ${version} installed successfully!"
}

main
