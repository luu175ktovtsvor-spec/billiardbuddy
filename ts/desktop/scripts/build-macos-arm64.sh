#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DESKTOP_DIR}/.." && pwd)"

TARGET_TRIPLE="aarch64-apple-darwin"
CANONICAL_OUTPUT_DIR="${DESKTOP_DIR}/build-artifacts/macos-arm64"
ELECTRON_OUTPUT_DIR="${DESKTOP_DIR}/build-artifacts/electron"
ELECTRON_BUILDER_CLI="${DESKTOP_DIR}/node_modules/electron-builder/out/cli/cli.js"
BUILD_LOCK_DIR="${DESKTOP_DIR}/build-artifacts/.macos-arm64-build.lock"

usage() {
  cat <<'EOF'
Build BilliardBuddy desktop for macOS Apple Silicon with Electron Builder.

Usage:
  ./desktop/scripts/build-macos-arm64.sh [extra electron-builder args...]

Environment:
  SKIP_INSTALL=1   Skip `bun install` in the repo root and desktop app.
  SIGN_BUILD=1     Allow electron-builder to auto-discover signing identities.
  REBUILD_NATIVE=1 Run `electron-builder install-app-deps` before packaging.
  BB_AGENT_ONLY_BUILD=1
                   Skip media toolchain staging and package verification.
  MAC_TARGETS      Electron Builder macOS targets. Defaults to "dmg zip".
  BB_MEDIA_TOOLCHAIN_SOURCE_DIR
                   Directory containing audited LGPL ffmpeg/ffprobe, LICENSE.txt, and media-toolchain-source.json.
  OPEN_OUTPUT=1    Open the canonical artifact output directory in Finder after a successful build.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[build-macos-arm64] This script must run on macOS." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "[build-macos-arm64] This script is intended for Apple Silicon hosts (arm64)." >&2
  exit 1
fi

export BB_AGENT_ONLY_BUILD="${BB_AGENT_ONLY_BUILD:-0}"

acquire_build_lock() {
  mkdir -p "$(dirname "${BUILD_LOCK_DIR}")"

  if mkdir "${BUILD_LOCK_DIR}" 2>/dev/null; then
    printf '%s\n' "$$" > "${BUILD_LOCK_DIR}/pid"
    return 0
  fi

  local owner_pid=""
  if [[ -f "${BUILD_LOCK_DIR}/pid" ]]; then
    owner_pid="$(<"${BUILD_LOCK_DIR}/pid")"
  fi
  if [[ "${owner_pid}" =~ ^[0-9]+$ ]] && kill -0 "${owner_pid}" 2>/dev/null; then
    echo "[build-macos-arm64] Another macOS build is already running (pid ${owner_pid})." >&2
    exit 1
  fi

  rm -rf "${BUILD_LOCK_DIR}"
  if ! mkdir "${BUILD_LOCK_DIR}" 2>/dev/null; then
    echo "[build-macos-arm64] Another macOS build acquired the lock." >&2
    exit 1
  fi
  printf '%s\n' "$$" > "${BUILD_LOCK_DIR}/pid"
}

release_build_lock() {
  rm -f "${BUILD_LOCK_DIR}/pid"
  rmdir "${BUILD_LOCK_DIR}" 2>/dev/null || true
}

acquire_build_lock
trap release_build_lock EXIT INT TERM

for command in bun node codesign hdiutil; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "[build-macos-arm64] Missing required command: ${command}" >&2
    exit 1
  fi
done

read -r -a MAC_TARGET_ARRAY <<< "${MAC_TARGETS:-dmg zip}"
if [[ "${#MAC_TARGET_ARRAY[@]}" -eq 0 ]]; then
  echo "[build-macos-arm64] MAC_TARGETS must contain at least one electron-builder macOS target." >&2
  exit 1
fi

has_mac_target() {
  local target="$1"
  for candidate in "${MAC_TARGET_ARRAY[@]}"; do
    if [[ "${candidate}" == "${target}" ]]; then
      return 0
    fi
  done
  return 1
}

if has_mac_target "dmg"; then
  STALE_DMG_MOUNTS="$(hdiutil info | grep -F "${ELECTRON_OUTPUT_DIR}/.temp" || true)"
  if [[ -n "${STALE_DMG_MOUNTS}" ]]; then
    echo "[build-macos-arm64] Found stale Electron Builder temporary DMG mounts in this worktree:" >&2
    echo "${STALE_DMG_MOUNTS}" >&2
    echo "[build-macos-arm64] Detach the stale disk image or restart DiskImages before building the dmg target." >&2
    echo "[build-macos-arm64] To verify the update zip path without DMG, rerun with MAC_TARGETS=zip." >&2
    exit 1
  fi
fi

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  echo "[build-macos-arm64] Installing root dependencies..."
  (cd "${REPO_ROOT}" && bun install)

  echo "[build-macos-arm64] Installing desktop dependencies..."
  (cd "${DESKTOP_DIR}" && bun install)
fi

if [[ "${BB_AGENT_ONLY_BUILD}" == "1" ]]; then
  echo "[build-macos-arm64] Agent-only build: skipping media toolchain staging."
else
  echo "[build-macos-arm64] Staging audited media toolchain..."
  (cd "${DESKTOP_DIR}" && BB_MEDIA_TOOLCHAIN_PLATFORM=darwin bun run stage:media-toolchain)
fi

echo "[build-macos-arm64] Building and staging managed Codex engine..."
(cd "${DESKTOP_DIR}" && CODEX_ENGINE_TARGET="${TARGET_TRIPLE}" bun run stage:codex-engine)

echo "[build-macos-arm64] Building and staging local Agent plugins..."
(cd "${DESKTOP_DIR}" && bun run stage:agent-plugins -- --target "${TARGET_TRIPLE}")
(cd "${DESKTOP_DIR}" && bun run stage:chrome-plugin -- --target "${TARGET_TRIPLE}")
(cd "${DESKTOP_DIR}" && bun run stage:browser-plugin -- --target "${TARGET_TRIPLE}")
(cd "${DESKTOP_DIR}" && bun run stage:record-replay-plugin -- --target "${TARGET_TRIPLE}")

echo "[build-macos-arm64] Cleaning stale Electron outputs..."
rm -rf "${DESKTOP_DIR}/dist"
rm -rf "${DESKTOP_DIR}/electron-dist"
rm -rf "${ELECTRON_OUTPUT_DIR}"
rm -rf "${CANONICAL_OUTPUT_DIR}"
rm -f "${DESKTOP_DIR}/tsconfig.tsbuildinfo"
rm -rf "${DESKTOP_DIR}/runtime-assets/binaries/billiardbuddy-sidecar-"*

echo "[build-macos-arm64] Building sidecars for ${TARGET_TRIPLE}..."
(cd "${DESKTOP_DIR}" && SIDECAR_TARGET_TRIPLE="${TARGET_TRIPLE}" bun run build:sidecars)

echo "[build-macos-arm64] Building renderer and Electron main/preload bundles..."
(cd "${DESKTOP_DIR}" && bun run build && bun run build:electron)

if [[ "${REBUILD_NATIVE:-0}" == "1" ]]; then
  echo "[build-macos-arm64] Rebuilding native dependencies for Electron ABI..."
  (cd "${DESKTOP_DIR}" && node "${ELECTRON_BUILDER_CLI}" install-app-deps)
fi

echo "[build-macos-arm64] Cleaning empty dmg-builder cache directories..."
(cd "${DESKTOP_DIR}" && bash ./scripts/clean-dmg-builder-cache.sh)

BUILDER_ARGS=(node "${ELECTRON_BUILDER_CLI}" --mac "${MAC_TARGET_ARRAY[@]}" --arm64 --publish never)
if [[ "${SIGN_BUILD:-0}" != "1" ]]; then
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  # package.json sets mac.notarize=true for the signed CI release path. A local
  # build has no Developer ID credentials, so sign the complete app ad-hoc and
  # disable notarization while retaining strict bundle-integrity verification.
  BUILDER_ARGS+=(-c.mac.identity=- -c.mac.notarize=false)
fi
if [[ "$#" -gt 0 ]]; then
  BUILDER_ARGS+=("$@")
fi

echo "[build-macos-arm64] Packaging Electron app..."
(cd "${DESKTOP_DIR}" && "${BUILDER_ARGS[@]}")

mkdir -p "${CANONICAL_OUTPUT_DIR}"
find "${CANONICAL_OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

if [[ -d "${ELECTRON_OUTPUT_DIR}/mac-arm64" ]]; then
  find "${ELECTRON_OUTPUT_DIR}/mac-arm64" -maxdepth 1 -type d -name '*.app' -exec cp -R {} "${CANONICAL_OUTPUT_DIR}/" \;
fi
find "${ELECTRON_OUTPUT_DIR}" -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.zip' -o -name '*.blockmap' -o -name 'latest-mac.yml' \) -exec cp -f {} "${CANONICAL_OUTPUT_DIR}/" \;

cat > "${CANONICAL_OUTPUT_DIR}/BUILD_INFO.txt" <<EOF
Target triple: ${TARGET_TRIPLE}
Builder output: ${ELECTRON_OUTPUT_DIR}
Canonical output: ${CANONICAL_OUTPUT_DIR}
Built at: $(date '+%Y-%m-%d %H:%M:%S %z')
EOF

echo
echo "[build-macos-arm64] Build finished."
echo "[build-macos-arm64] Canonical output: ${CANONICAL_OUTPUT_DIR}"

if [[ "${OPEN_OUTPUT:-0}" == "1" ]]; then
  open "${CANONICAL_OUTPUT_DIR}"
fi
