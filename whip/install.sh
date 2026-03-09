#!/bin/bash
set -e

REPO="bang9/ai-tools"
INSTALL_DIR="$HOME/.local/bin"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }
error() { echo -e "${RED}$1${NC}" >&2; exit 1; }
step() { echo -e "${CYAN}→${NC} $1"; }

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

download_optional_file() {
    local url="$1" dest="$2"
    local http_code output

    if command -v curl &> /dev/null; then
        if ! http_code=$(curl -sSL -w '%{http_code}' -o "$dest" "$url"); then
            rm -f "$dest"
            return 1
        fi
        case "$http_code" in
            200) return 0 ;;
            404)
                rm -f "$dest"
                return 2
                ;;
        esac
        rm -f "$dest"
        return 1
    fi

    if command -v wget &> /dev/null; then
        if output=$(wget -q -S -O "$dest" "$url" 2>&1); then
            return 0
        fi
        rm -f "$dest"
        if printf '%s\n' "$output" | grep -Eq 'HTTP/[0-9.]+\s+404'; then
            return 2
        fi
        return 1
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

install_binary_with_optional_checksum() {
    local download_url="$1" checksum_url="$2" asset_name="$3" dest="$4"
    local tmp="${dest}.tmp.$$" manifest="${tmp}.checksums"
    local expected_checksum actual_checksum checksum_status

    if download_optional_file "$checksum_url" "$manifest"; then
        expected_checksum=$(lookup_checksum "$manifest" "$asset_name")
        if [ -z "$expected_checksum" ]; then
            warn "Checksum entry not found for ${asset_name}"
            rm -f "$tmp" "$manifest"
            return 1
        fi
    else
        checksum_status=$?
        if [ "$checksum_status" -eq 2 ]; then
            warn "Checksum manifest not found for ${asset_name}; installing without checksum verification"
            rm -f "$manifest"
            expected_checksum=""
        else
            rm -f "$tmp" "$manifest"
            return 1
        fi
    fi

    if ! download_file "$download_url" "$tmp"; then
        rm -f "$tmp" "$manifest"
        return 1
    fi

    if [ -n "$expected_checksum" ]; then
        if ! actual_checksum=$(sha256_file "$tmp"); then
            rm -f "$tmp" "$manifest"
            return 1
        fi

        if [ "$actual_checksum" != "$expected_checksum" ]; then
            warn "Checksum mismatch for ${asset_name}"
            rm -f "$tmp" "$manifest"
            return 1
        fi
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
            echo "# Added by whip installer" >> "$shell_profile"
            echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$shell_profile"
            warn "Added $INSTALL_DIR to PATH in $shell_profile"
            warn "Run 'source $shell_profile' or restart your terminal"
        fi
    else
        warn "Could not detect shell profile. Add $INSTALL_DIR to your PATH manually."
    fi
}

install_binary() {
    local name=$1 os=$2 arch=$3 version=$4
    local download_name="${name}-${os}-${arch}"
    local binary_name="$name"
    local checksum_name="${name}-checksums.txt"

    if [ "$os" = "windows" ]; then
        download_name="${download_name}.exe"
        binary_name="${name}.exe"
    fi

    local download_url="https://github.com/${REPO}/releases/download/${version}/${download_name}"
    local checksum_url="https://github.com/${REPO}/releases/download/${version}/${checksum_name}"

    step "Installing ${name} ${version}..."
    if ! install_binary_with_optional_checksum "$download_url" "$checksum_url" "$download_name" "${INSTALL_DIR}/${binary_name}"; then
        warn "Failed to download ${name}. It will be installed on first use via plugin hook."
        return 1
    fi
    info "  ${name} installed"
    return 0
}

main() {
    echo ""
    echo -e "${CYAN}Setting up whip — Task Orchestrator for Claude Code${NC}"
    echo ""

    local os arch version

    os=$(detect_os)
    arch=$(detect_arch)
    version=$(get_latest_version)

    echo "  Version:      $version"
    echo "  Platform:     ${os}/${arch}"
    echo "  Install path: ${INSTALL_DIR}"
    echo ""

    mkdir -p "$INSTALL_DIR"

    # Install whip
    install_binary "whip" "$os" "$arch" "$version"

    # Install required tools
    echo ""
    step "Installing required tools..."

    if ! command -v claude-irc &> /dev/null && ! [ -x "${INSTALL_DIR}/claude-irc" ]; then
        install_binary "claude-irc" "$os" "$arch" "$version" || true
    else
        info "  claude-irc already installed"
    fi

    if ! command -v webform &> /dev/null && ! [ -x "${INSTALL_DIR}/webform" ]; then
        install_binary "webform" "$os" "$arch" "$version" || true
    else
        info "  webform already installed"
    fi

    ensure_path

    echo ""
    info "whip ${version} installed successfully!"
    echo ""
    echo "  Quick start:"
    echo "    whip create \"My Task\" --desc \"Description here\""
    echo "    whip assign <id>"
    echo "    whip dashboard"
    echo ""
}

main
