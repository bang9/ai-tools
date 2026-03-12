#!/bin/bash
set -euo pipefail

REPO="bang9/ai-tools"
INSTALL_DIR="$HOME/.local/bin"
SEMVER_TAG_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*)|[0-9A-Za-z-][0-9A-Za-z-]*)(\.((0|[1-9][0-9]*)|[0-9A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'

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
    local payload version

    if ! payload=$(download_text "https://api.github.com/repos/${REPO}/releases/latest"); then
        error "Failed to fetch latest release metadata from GitHub"
    fi
    version=$(printf '%s\n' "$payload" | awk -F'"' '$2 == "tag_name" { print $4; exit }')
    if [ -z "$version" ]; then
        error "Failed to fetch latest version from GitHub"
    fi
    validate_version_tag "$version" "latest release version"
    printf '%s\n' "$version"
}

download_text() {
    local url="$1"
    if command -v curl &> /dev/null; then
        curl -fsSL "$url"
        return $?
    fi
    if command -v wget &> /dev/null; then
        wget -q -O - "$url"
        return $?
    fi
    error "Neither curl nor wget is installed"
}

validate_version_tag() {
    local version="$1" source_label="$2"

    case "$version" in
        *$'\n'*|*$'\r'*)
            error "Invalid ${source_label}: must be a single-line semver tag"
            ;;
    esac

    if ! printf '%s\n' "$version" | grep -Eq "$SEMVER_TAG_PATTERN"; then
        error "Invalid ${source_label}: must be a semver tag, got ${version}"
    fi
}

download_file() {
    local url="$1" dest="$2"
    if command -v curl &> /dev/null; then
        if curl -fsSL -o "$dest" "$url"; then
            return 0
        fi
        rm -f "$dest"
        return 1
    fi
    if command -v wget &> /dev/null; then
        if wget -q -O "$dest" "$url"; then
            return 0
        fi
        rm -f "$dest"
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
        warn "Failed to download checksum manifest for ${asset_name}"
        cleanup_install_artifacts "$tmp" "$manifest"
        return 1
    fi

    expected_checksum=$(lookup_checksum "$manifest" "$asset_name")
    if [ -z "$expected_checksum" ]; then
        warn "Checksum entry not found for ${asset_name}"
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
        warn "Checksum mismatch for ${asset_name}"
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

    if [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "zsh" ]; then
        shell_profile="$HOME/.zshrc"
    elif [ -n "${BASH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "bash" ]; then
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
    if ! install_binary_with_checksum "$download_url" "$checksum_url" "$download_name" "${INSTALL_DIR}/${binary_name}"; then
        error "Failed to install ${name}. Verify the ${download_name} release asset and ${checksum_name} manifest for ${version}."
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

    for tool in claude-irc webform rewind; do
        if ! command -v "$tool" &> /dev/null && ! [ -x "${INSTALL_DIR}/$tool" ]; then
            install_binary "$tool" "$os" "$arch" "$version"
        else
            info "  $tool already installed"
        fi
    done

    ensure_path

    echo ""
    info "whip ${version} installed successfully!"
    echo ""
    echo "  Quick start:"
    echo "    whip task create \"My Task\" --desc \"Description here\""
    echo "    whip task assign <id>"
    echo "    whip task create \"API Task\" --workspace issue-sweep --desc \"Description here\""
    echo "    whip workspace show issue-sweep"
    echo "    whip dashboard"
    echo ""
}

main
