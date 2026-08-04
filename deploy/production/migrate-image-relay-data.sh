#!/usr/bin/env bash
set -euo pipefail

# One-time, explicit migration for the pre-rename Image Relay SQLite/CAS tree.
# Normal deploys never recurse through image blobs or SQLite files.
if [ "$(id -u)" -ne 0 ]; then
  echo 'image relay data migration must run as root' >&2
  exit 1
fi

bb_legacy=/srv/billiardbuddy/data/relay
bb_target=/srv/billiardbuddy/data/image-relay
bb_legacy_containers="$(docker ps -aq \
  --filter 'label=com.docker.compose.project=billiardbuddy' \
  --filter 'label=com.docker.compose.service=relay')"

[ -z "$bb_legacy_containers" ] || { echo 'legacy relay container still exists; stop/remove it before moving its SQLite/CAS data' >&2; exit 1; }
[ -d "$bb_legacy" ] || { echo "missing legacy image relay data directory: $bb_legacy" >&2; exit 1; }
[ ! -e "$bb_target" ] || { echo "target image relay data directory already exists: $bb_target" >&2; exit 1; }
[ -f "$bb_legacy/relay.db" ] || { echo "missing legacy SQLite database: $bb_legacy/relay.db" >&2; exit 1; }

# /srv/billiardbuddy/data is one filesystem in the supported production layout,
# so this rename is atomic. Ownership is fixed only for this named migration
# target; it is never re-walked by normal release deployment.
mv "$bb_legacy" "$bb_target"
chown -R 1000:1000 "$bb_target"
[ "$(stat -c '%u:%g' "$bb_target")" = '1000:1000' ] || { echo 'migration ownership verification failed' >&2; exit 1; }

printf 'MIGRATED_IMAGE_RELAY_DATA=%s\n' "$bb_target"
