#!/usr/bin/env bash
set -euo pipefail

desktop_root="$(cd "$(dirname "$0")/.." && pwd)"
source_svg="$desktop_root/public/app-icon.svg"
public_png="$desktop_root/public/app-icon.png"
icons_dir="$desktop_root/runtime-assets/icons"
icon_temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/billiardbuddy-icons.XXXXXX")"
iconset_dir="$icon_temp_dir/BilliardBuddy.iconset"

cleanup() {
  node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$icon_temp_dir"
}
trap cleanup EXIT

mkdir -p "$iconset_dir" "$icons_dir"
sips -s format png "$source_svg" --out "$public_png" >/dev/null

resize_png() {
  local size="$1"
  local output="$2"
  sips -z "$size" "$size" "$public_png" --out "$output" >/dev/null
}

resize_png 512 "$icons_dir/icon.png"
for size in 32 64 128; do
  resize_png "$size" "$icons_dir/${size}x${size}.png"
done
for size in 30 44 71 89 107 142 150 284 310; do
  resize_png "$size" "$icons_dir/Square${size}x${size}Logo.png"
done

resize_png 16 "$iconset_dir/icon_16x16.png"
resize_png 32 "$iconset_dir/icon_16x16@2x.png"
resize_png 32 "$iconset_dir/icon_32x32.png"
resize_png 64 "$iconset_dir/icon_32x32@2x.png"
resize_png 128 "$iconset_dir/icon_128x128.png"
resize_png 256 "$iconset_dir/icon_128x128@2x.png"
resize_png 256 "$iconset_dir/icon_256x256.png"
resize_png 512 "$iconset_dir/icon_256x256@2x.png"
resize_png 512 "$iconset_dir/icon_512x512.png"
resize_png 1024 "$iconset_dir/icon_512x512@2x.png"
iconutil -c icns "$iconset_dir" -o "$icons_dir/icon.icns"
sips -z 256 256 -s format ico "$public_png" --out "$icons_dir/icon.ico" >/dev/null

echo "BilliardBuddy icons regenerated from public/app-icon.svg"
