#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

TARGET="${1:-tauri}"
APP_NAME="grove"
CLEANUP_FILES=()

cleanup() {
  local file
  for file in "${CLEANUP_FILES[@]-}"; do
    [ -n "$file" ] && rm -f "$file"
  done
}

trap cleanup EXIT

resolve_latest_tag() {
  local tag
  # Only full semver tags (vX.Y.Z) drive the app version — the release CI also
  # publishes a floating major tag (`v2`) that would otherwise win by creatordate
  # and produce a non-semver version Tauri's config parser rejects.
  tag="$(git tag --sort=-creatordate | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
  if [ -z "$tag" ]; then
    tag="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)"
  fi
  if [ -z "$tag" ]; then
    tag="$(node -p "require('./package.json').version" 2>/dev/null || printf '0.1.0')"
  fi
  printf '%s' "$tag"
}

normalize_app_version() {
  local raw="$1"
  raw="${raw#v}"
  printf '%s' "$raw"
}

compute_build_version() {
  date '+%y%m%d%H%M'
}

create_tauri_config_override() {
  local path="$1"
  printf '%s\n' '{' \
    "  \"version\": \"$APP_VERSION\"," \
    '  "bundle": {' \
    '    "macOS": {' \
    "      \"bundleVersion\": \"$BUILD_VERSION\"" \
    '    }' \
    '  }' \
    '}' > "$path"
}

LATEST_TAG="$(resolve_latest_tag)"
APP_VERSION="$(normalize_app_version "$LATEST_TAG")"
BUILD_VERSION="$(compute_build_version)"
ABOUT_LABEL="v${APP_VERSION}-${BUILD_VERSION}"

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile
echo "==> About version: ${APP_VERSION} (${BUILD_VERSION})"
echo "==> About label: ${ABOUT_LABEL}"

install_tauri() {
  local bundle_path="target/release/bundle/macos/${APP_NAME}.app"
  local install_path="/Applications/${APP_NAME}.app"
  local tauri_config_override

  tauri_config_override="$(mktemp -t grove-tauri-config)"
  CLEANUP_FILES+=("$tauri_config_override")
  create_tauri_config_override "$tauri_config_override"

  echo "==> Building Tauri app..."
  pnpm tauri build --bundles app --config "$tauri_config_override"

  echo "==> Installing to /Applications..."
  if [ -d "$install_path" ]; then
    rm -rf "$install_path"
  fi
  cp -r "$bundle_path" "$install_path"

  echo "==> Done! Open grove from /Applications or Spotlight."
  echo "==> Installed About version: ${APP_VERSION} (${BUILD_VERSION})"
}

install_electron() {
  local bundle_path="dist-electron/mac-arm64/Grove.app"
  local install_path="/Applications/${APP_NAME}-electron.app"

  echo "==> Building Electron app..."
  GROVE_APP_VERSION="$APP_VERSION" \
  GROVE_BUILD_VERSION="$BUILD_VERSION" \
  GROVE_ELECTRON_DIR_ONLY=1 \
  pnpm build:electron

  echo "==> Installing to /Applications..."
  if [ -d "$install_path" ]; then
    rm -rf "$install_path"
  fi
  cp -r "$bundle_path" "$install_path"

  echo "==> Done! Open grove-electron from /Applications or Spotlight."
  echo "==> Installed About version: ${APP_VERSION} (${BUILD_VERSION})"
}

case "$TARGET" in
  tauri)
    install_tauri
    ;;
  electron)
    install_electron
    ;;
  all)
    install_tauri
    install_electron
    ;;
  *)
    echo "Usage: $0 [tauri|electron|all]"
    exit 1
    ;;
esac
