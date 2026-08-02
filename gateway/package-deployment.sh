#!/bin/bash
# Build the exact self-contained files accepted by gateway/deploy.sh.
# Usage: gateway/package-deployment.sh /empty/output-directory
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 /empty/output-directory" >&2
  exit 64
fi

bb_package_dir="$1"
if [ -e "$bb_package_dir" ] && [ ! -d "$bb_package_dir" ]; then
  echo "output path is not a directory: $bb_package_dir" >&2
  exit 64
fi
mkdir -p "$bb_package_dir"
if [ -n "$(find "$bb_package_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "output directory must be empty: $bb_package_dir" >&2
  exit 64
fi

bb_script_dir="$(cd "$(dirname "$0")" && pwd)"
if command -v bun >/dev/null 2>&1; then
  bb_bun_bin="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  bb_bun_bin="$HOME/.bun/bin/bun"
else
  echo "bun is required to package the gateway" >&2
  exit 127
fi

"$bb_bun_bin" build "$bb_script_dir/app.ts" --outfile "$bb_package_dir/app.js" --target bun --format esm --sourcemap=none
"$bb_bun_bin" build "$bb_script_dir/validate-deployment-env.ts" --outfile "$bb_package_dir/validate-deployment-env.js" --target bun --format esm --sourcemap=none
install -m 755 "$bb_script_dir/deploy.sh" "$bb_package_dir/deploy.sh"
install -m 755 "$bb_script_dir/validate-mimo-capacity-env.sh" "$bb_package_dir/validate-mimo-capacity-env.sh"
install -m 755 "$bb_script_dir/validate-production-capacity-env.sh" "$bb_package_dir/validate-production-capacity-env.sh"

for bb_bundle in "$bb_package_dir/app.js" "$bb_package_dir/validate-deployment-env.js"; do
  if grep -Eq "from[[:space:]]*['\"](\./|\.\./)|import\([[:space:]]*['\"](\./|\.\./)" "$bb_bundle"; then
    echo "bundle retained a relative runtime import: $bb_bundle" >&2
    exit 1
  fi
done

echo "Gateway deployment package ready: $bb_package_dir"
