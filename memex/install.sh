#!/bin/bash
set -e

REPO="bang9/ai-tools"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="memex"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }
error() { echo -e "${RED}$1${NC}" >&2; exit 1; }

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Darwin) echo "darwin" ;;
        Linux)  echo "linux" ;;
        MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
        *) error "Unsupported operating system: $(uname -s)" ;;
    esac
}

# Detect architecture (with Rosetta detection)
detect_arch() {
    local arch
    arch="$(uname -m)"

    # Detect Rosetta 2 on macOS
    if [ "$(uname -s)" = "Darwin" ] && [ "$arch" = "x86_64" ]; then
        if sysctl -n sysctl.proc_translated 2>/dev/null | grep -q 1; then
            arch="arm64"
        fi
    fi

    case "$arch" in
        x86_64|amd64) echo "amd64" ;;
        arm64|aarch64) echo "arm64" ;;
        *) error "Unsupported architecture: $arch" ;;
    esac
}

# Get latest version from GitHub API
get_latest_version() {
    local version
    version=$(curl -sfSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)
    if [ -z "$version" ]; then
        error "Failed to fetch latest version from GitHub"
    fi
    echo "$version"
}

# Add to PATH via shell profile
ensure_path() {
    local shell_profile=""

    if [ -n "$ZSH_VERSION" ] || [ "$(basename "$SHELL")" = "zsh" ]; then
        shell_profile="$HOME/.zshrc"
    elif [ -n "$BASH_VERSION" ] || [ "$(basename "$SHELL")" = "bash" ]; then
        if [ -f "$HOME/.bash_profile" ]; then
            shell_profile="$HOME/.bash_profile"
        else
            shell_profile="$HOME/.bashrc"
        fi
    fi

    if echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
        return 0
    fi

    if [ -n "$shell_profile" ]; then
        if ! grep -q "$INSTALL_DIR" "$shell_profile" 2>/dev/null; then
            echo "" >> "$shell_profile"
            echo "# Added by memex installer" >> "$shell_profile"
            echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$shell_profile"
            warn "Added $INSTALL_DIR to PATH in $shell_profile"
            warn "Run 'source $shell_profile' or restart your terminal to use memex"
        fi
    else
        warn "Could not detect shell profile. Add $INSTALL_DIR to your PATH manually."
    fi
}

main() {
    echo "Setting up memex..."
    echo ""

    local os arch version binary_name download_url

    os=$(detect_os)
    arch=$(detect_arch)
    version=$(get_latest_version)

    binary_name="memex-${os}-${arch}"
    if [ "$os" = "windows" ]; then
        binary_name="${binary_name}.exe"
        BINARY_NAME="memex.exe"
    fi

    download_url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"

    echo "  Version:      $version"
    echo "  Platform:     ${os}/${arch}"
    echo "  Install path: ${INSTALL_DIR}/${BINARY_NAME}"
    echo ""

    # Create install directory
    mkdir -p "$INSTALL_DIR"

    # Download binary
    info "Downloading ${binary_name}..."
    if ! curl -fsSL -o "${INSTALL_DIR}/${BINARY_NAME}" "$download_url"; then
        error "Download failed. Check if the release exists: https://github.com/${REPO}/releases/tag/${version}"
    fi

    # Make executable
    chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

    # Ensure PATH
    ensure_path

    echo ""
    info "memex ${version} installed successfully!"
}

main
