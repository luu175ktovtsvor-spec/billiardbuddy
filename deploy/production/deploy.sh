#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo 'production deploy must run as root' >&2
  exit 1
fi

bb_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bb_repo_root="$(cd "$bb_script_dir/../.." && pwd)"
bb_compose_file="$bb_script_dir/compose.yml"
bb_secret_root=/srv/billiardbuddy/secrets
bb_data_root=/srv/billiardbuddy/data
bb_release_manifest="$bb_repo_root/release-manifest.json"

[ -f "$bb_release_manifest" ] || { echo "missing $bb_release_manifest" >&2; exit 1; }
bb_source_revision="$(sed -nE 's/^\{"schema_version":1,"git_revision":"([0-9a-f]{40})"\}$/\1/p' "$bb_release_manifest")"
[[ "$bb_source_revision" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid $bb_release_manifest" >&2; exit 1; }

for bb_required in "$bb_secret_root/gateway.env" "$bb_secret_root/image-relay.env"; do
  [ -f "$bb_required" ] || { echo "missing $bb_required" >&2; exit 1; }
  chmod 600 "$bb_required"
done

# Never let a renamed service start against an empty database while the previous
# Image Relay facts still exist under the legacy directory. The one-time server
# migration is deliberately operator-visible and happens only after the old
# container is stopped and both directory contents have been inventoried.
bb_legacy_image_db="$bb_data_root/relay/relay.db"
bb_image_db="$bb_data_root/image-relay/relay.db"
if [ -f "$bb_legacy_image_db" ] && [ ! -f "$bb_image_db" ]; then
  echo "image relay data migration required: $bb_legacy_image_db -> $bb_image_db" >&2
  exit 1
fi

install -d -m 0700 "$bb_data_root/gateway" "$bb_data_root/image-relay" "$bb_data_root/image-relay/blobs"
chown -R 1000:1000 "$bb_data_root/gateway" "$bb_data_root/image-relay"

bb_release_id="${BILLIARDBUDDY_RELEASE:-$(printf '%s' "$bb_source_revision" | cut -c1-12)}"
export BILLIARDBUDDY_RELEASE="$bb_release_id"

docker compose -f "$bb_compose_file" config --quiet
docker compose -f "$bb_compose_file" build --pull gateway image-relay
# One preflight owns model selection, secret-slot presence, capacity and quota
# policy validation under the exact Compose environment. It opens neither the
# database nor a model connection and never prints secret values.
docker compose -f "$bb_compose_file" run --rm --no-deps --entrypoint bun gateway \
  /app/gateway/validate-deployment-env.ts --process-env
docker compose -f "$bb_compose_file" run --rm --no-deps --entrypoint bun image-relay \
  /app/relay/validate-deployment-env.ts --process-env
docker compose -f "$bb_compose_file" up -d --wait --wait-timeout 180 gateway image-relay

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8799/healthz >/dev/null
docker compose -f "$bb_compose_file" exec -T image-relay bun -e \
  "const response = await fetch('http://127.0.0.1:8790/healthz'); if (!response.ok) process.exit(1)"

ln -sfn "$bb_repo_root" /srv/billiardbuddy/current
printf 'DEPLOYED_RELEASE=%s\n' "$bb_release_id"
printf 'DEPLOYED_SOURCE_REVISION=%s\n' "$bb_source_revision"
