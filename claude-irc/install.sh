#!/bin/bash
set -euo pipefail

REPO="bang9/ai-tools"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="claude-irc"
SEMVER_TAG_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*)|[0-9A-Za-z-][0-9A-Za-z-]*)(\.((0|[1-9][0-9]*)|[0-9A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }
error() { echo -e "${RED}$1${NC}" >&2; exit 1; }

detect_os() {
    case "$(uname -s)" in
        Darwin) echo "darwin" ;;
        Linux)  echo "linux" ;;
        *) error "Unsupported operating system: $(uname -s)" ;;
    esac
}

detect_arch() {
    local arch
    arch="$(uname -m)"

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

get_latest_version() {
    local version
    version=$(curl -sfSL "https://api.github.com/repos/${REPO}/releases/latest" | awk -F'"' '$2 == "tag_name" { print $4; exit }')
    if [ -z "$version" ]; then
        error "Failed to fetch latest version from GitHub"
    fi
    if ! printf '%s\n' "$version" | grep -Eq "$SEMVER_TAG_PATTERN"; then
        error "Invalid release version from GitHub: $version"
    fi
    echo "$version"
}

download_file() {
    local url="$1" dest="$2"
    if command -v curl &> /dev/null; then
        curl -fsSL -o "$dest" "$url"
        return $?
    fi
    if command -v wget &> /dev/null; then
        wget -q -O "$dest" "$url"
        return $?
    fi
    echo "Neither curl nor wget is installed" >&2
    return 1
}

sha256_file() {
    local file="$1"
    if command -v sha256sum &> /dev/null; then
        sha256sum "$file" | awk '{print $1}'
        return $?
    fi
    if command -v shasum &> /dev/null; then
        shasum -a 256 "$file" | awk '{print $1}'
        return $?
    fi
    if command -v openssl &> /dev/null; then
        openssl dgst -sha256 "$file" | awk '{print $NF}'
        return $?
    fi
    echo "No SHA-256 tool found (tried sha256sum, shasum, openssl)" >&2
    return 1
}

lookup_checksum() {
    local manifest="$1" asset_name="$2"
    awk -v name="$asset_name" '
        NF >= 2 {
            file = $2
            sub(/^\*/, "", file)
            if (file == name) {
                print $1
                exit
            }
        }
    ' "$manifest"
}

cleanup_install_artifacts() {
    rm -f "$1" "$2"
}

install_binary_with_checksum() {
    local download_url="$1" checksum_url="$2" asset_name="$3" dest="$4"
    local tmp manifest
    local expected_checksum actual_checksum

    tmp=$(mktemp "${dest}.tmp.XXXXXX")
    manifest=$(mktemp "${dest}.checksums.XXXXXX")

    if ! download_file "$checksum_url" "$manifest"; then
        echo "Failed to download checksum manifest: ${checksum_url}" >&2
        cleanup_install_artifacts "$tmp" "$manifest"
        return 1
    fi

    expected_checksum=$(lookup_checksum "$manifest" "$asset_name")
    if [ -z "$expected_checksum" ]; then
        echo "Checksum entry not found for ${asset_name} in ${checksum_url}" >&2
        cleanup_install_artifacts "$tmp" "$manifest"
        return 1
    fi

    if ! download_file "$download_url" "$tmp"; then
        cleanup_install_artifacts "$tmp" "$manifest"
        return 1
    fi

    if ! actual_checksum=$(sha256_file "$tmp"); then
        cleanup_install_artifacts "$tmp" "$manifest"
        return 1
    fi

    if [ "$actual_checksum" != "$expected_checksum" ]; then
        echo "Checksum mismatch for ${asset_name}: expected ${expected_checksum}, got ${actual_checksum}" >&2
        cleanup_install_artifacts "$tmp" "$manifest"
        return 1
    fi

    if ! chmod +x "$tmp"; then
        cleanup_install_artifacts "$tmp" "$manifest"
        return 1
    fi

    if ! mv -f "$tmp" "$dest"; then
        cleanup_install_artifacts "$tmp" "$manifest"
        return 1
    fi

    rm -f "$manifest"
    return 0
}

ensure_path() {
    local shell_profile=""
    local shell_name=""

    if [ -n "${SHELL:-}" ]; then
        shell_name="$(basename "$SHELL")"
    fi

    if [ -n "${ZSH_VERSION:-}" ] || [ "$shell_name" = "zsh" ]; then
        shell_profile="$HOME/.zshrc"
    elif [ -n "${BASH_VERSION:-}" ] || [ "$shell_name" = "bash" ]; then
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
            {
                echo ""
                echo "# Added by claude-irc installer"
                echo "export PATH=\"$INSTALL_DIR:\$PATH\""
            } >> "$shell_profile"
            warn "Added $INSTALL_DIR to PATH in $shell_profile"
            warn "Run 'source $shell_profile' or restart your terminal to use claude-irc"
        fi
    else
        warn "Could not detect shell profile. Add $INSTALL_DIR to your PATH manually."
    fi
}

main() {
    echo "Setting up claude-irc..."
    echo ""

    local os arch version binary_name checksum_name download_url checksums_url

    os=$(detect_os)
    arch=$(detect_arch)
    version=$(get_latest_version)

    binary_name="claude-irc-${os}-${arch}"
    checksum_name="${BINARY_NAME}-checksums.txt"

    download_url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"
    checksums_url="https://github.com/${REPO}/releases/download/${version}/${checksum_name}"

    echo "  Version:      $version"
    echo "  Platform:     ${os}/${arch}"
    echo "  Install path: ${INSTALL_DIR}/${BINARY_NAME}"
    echo ""

    mkdir -p "$INSTALL_DIR"

    info "Downloading ${binary_name}..."
    if ! install_binary_with_checksum "$download_url" "$checksums_url" "$binary_name" "${INSTALL_DIR}/${BINARY_NAME}"; then
        error "Download failed. Check if the release exists: https://github.com/${REPO}/releases/tag/${version}"
    fi

    ensure_path

    echo ""
    info "claude-irc ${version} installed successfully!"
}

main
