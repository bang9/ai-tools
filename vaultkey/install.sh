#!/bin/bash
set -e

REPO="bang9/ai-tools"
INSTALL_DIR="$HOME/.local/bin"
BINARY_NAME="vaultkey"

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
        MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
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
    version=$(curl -sfSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)
    if [ -z "$version" ]; then
        error "Failed to fetch latest version from GitHub"
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
    error "Neither curl nor wget is installed"
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
    error "No SHA-256 tool found (tried sha256sum, shasum, openssl)"
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

install_verified_binary() {
    local download_url="$1" checksum_url="$2" asset_name="$3" dest="$4"
    local tmp="${dest}.tmp.$$" manifest="${tmp}.checksums"
    local expected_checksum actual_checksum

    if ! download_file "$checksum_url" "$manifest"; then
        rm -f "$tmp" "$manifest"
        return 1
    fi

    expected_checksum=$(lookup_checksum "$manifest" "$asset_name")
    if [ -z "$expected_checksum" ]; then
        warn "Checksum entry not found for ${asset_name}"
        rm -f "$tmp" "$manifest"
        return 1
    fi

    if ! download_file "$download_url" "$tmp"; then
        rm -f "$tmp" "$manifest"
        return 1
    fi

    if ! actual_checksum=$(sha256_file "$tmp"); then
        rm -f "$tmp" "$manifest"
        return 1
    fi

    if [ "$actual_checksum" != "$expected_checksum" ]; then
        warn "Checksum mismatch for ${asset_name}"
        rm -f "$tmp" "$manifest"
        return 1
    fi

    if ! chmod +x "$tmp"; then
        rm -f "$tmp" "$manifest"
        return 1
    fi

    rm -f "$dest"
    if ! mv "$tmp" "$dest"; then
        rm -f "$tmp" "$manifest"
        return 1
    fi

    rm -f "$manifest"
    return 0
}

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
            echo "# Added by vaultkey installer" >> "$shell_profile"
            echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$shell_profile"
            warn "Added $INSTALL_DIR to PATH in $shell_profile"
            warn "Run 'source $shell_profile' or restart your terminal to use vaultkey"
        fi
    else
        warn "Could not detect shell profile. Add $INSTALL_DIR to your PATH manually."
    fi
}

main() {
    echo "Setting up vaultkey..."
    echo ""

    local os arch version binary_name checksum_name download_url checksums_url

    os=$(detect_os)
    arch=$(detect_arch)
    version=$(get_latest_version)

    binary_name="vaultkey-${os}-${arch}"
    checksum_name="${BINARY_NAME}-checksums.txt"
    if [ "$os" = "windows" ]; then
        binary_name="${binary_name}.exe"
        BINARY_NAME="vaultkey.exe"
    fi

    download_url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"
    checksums_url="https://github.com/${REPO}/releases/download/${version}/${checksum_name}"

    echo "  Version:      $version"
    echo "  Platform:     ${os}/${arch}"
    echo "  Install path: ${INSTALL_DIR}/${BINARY_NAME}"
    echo ""

    mkdir -p "$INSTALL_DIR"

    info "Downloading ${binary_name}..."
    if ! install_verified_binary "$download_url" "$checksums_url" "$binary_name" "${INSTALL_DIR}/${BINARY_NAME}"; then
        error "Download failed. Check if the release exists: https://github.com/${REPO}/releases/tag/${version}"
    fi

    ensure_path

    echo ""
    info "vaultkey ${version} installed successfully!"
}

main
