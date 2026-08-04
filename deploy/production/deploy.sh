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
bb_nginx_vhost="${BILLIARDBUDDY_NGINX_ROOT_VHOST:-}"

[ -f "$bb_release_manifest" ] || { echo "missing $bb_release_manifest" >&2; exit 1; }
bb_source_revision="$(sed -nE 's/^\{"schema_version":1,"git_revision":"([0-9a-f]{40})"\}$/\1/p' "$bb_release_manifest")"
[[ "$bb_source_revision" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid $bb_release_manifest" >&2; exit 1; }

# The route installer must be pointed at the vhost selected by an explicit
# read-only server inventory. Never infer the root-domain site and risk
# overwriting an unrelated Nginx configuration.
[ -n "$bb_nginx_vhost" ] || { echo 'BILLIARDBUDDY_NGINX_ROOT_VHOST must name the inventoried zzyppz.cn vhost' >&2; exit 1; }
bash "$bb_script_dir/install-nginx-relay-routes.sh" --verify-vhost "$bb_nginx_vhost"

for bb_required in "$bb_secret_root/gateway.env" "$bb_secret_root/image-relay.env" "$bb_secret_root/video-media-relay.env"; do
  [ -f "$bb_required" ] || { echo "missing $bb_required" >&2; exit 1; }
  chmod 600 "$bb_required"
done

bb_release_id="${BILLIARDBUDDY_RELEASE:-$(printf '%s' "$bb_source_revision" | cut -c1-12)}"
export BILLIARDBUDDY_RELEASE="$bb_release_id"

# A release must first prove that its static Compose graph, images and all
# three secret/config validators are usable.  This stage intentionally uses
# `docker run`, not `docker compose run`: Compose would materialise the image
# relay's bind mount and could create an empty /srv/.../image-relay directory
# before the one-time legacy-data cutover has happened.  Validators do not open
# a database or contact a provider, so disposable /tmp paths are sufficient.
# A failed cutover can therefore be corrected and re-run without rebuilding.
docker compose -f "$bb_compose_file" config --quiet
docker compose -f "$bb_compose_file" build --pull gateway image-relay video-media-relay
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --env-file "$bb_secret_root/gateway.env" --env GW_DB=/tmp/usage.db \
  "billiardbuddy/gateway:$bb_release_id" bun /app/gateway/validate-deployment-env.ts --process-env
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --env-file "$bb_secret_root/image-relay.env" --env RELAY_DB=/tmp/relay.db --env RELAY_BLOB_DIR=/tmp/blobs \
  --env RELAY_HOST=0.0.0.0 --env RELAY_PORT=8790 \
  --env IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE=http://gateway:8799 \
  --env IMAGE_RELAY_PUBLIC_BASE=https://zzyppz.cn/image-generation \
  "billiardbuddy/image-relay:$bb_release_id" bun /app/relay/validate-deployment-env.ts --process-env
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --env-file "$bb_secret_root/video-media-relay.env" --env VIDEO_MEDIA_RELAY_DB=/tmp/video-media-relay.db \
  --env VIDEO_MEDIA_RELAY_HOST=0.0.0.0 --env VIDEO_MEDIA_RELAY_PORT=8791 \
  --env VIDEO_MEDIA_GATEWAY_INTROSPECTION_BASE=http://gateway:8799 \
  "billiardbuddy/video-media-relay:$bb_release_id" bun /app/video-media-relay/validate-deployment-env.ts --process-env

# Never let a renamed service start against an empty database while the previous
# Image Relay facts still exist under the legacy directory. The one-time server
# migration is deliberately operator-visible and happens only after the old
# container is stopped and both directory contents have been inventoried.
bb_legacy_relay_containers="$(docker ps -aq \
  --filter 'label=com.docker.compose.project=billiardbuddy' \
  --filter 'label=com.docker.compose.service=relay')"
if [ -n "$bb_legacy_relay_containers" ]; then
  echo 'legacy relay container still exists; stop/remove it and inventory data before deploying image-relay' >&2
  exit 1
fi
bb_legacy_image_data="$bb_data_root/relay"
bb_legacy_relay_env="$bb_secret_root/relay.env"
if [ -e "$bb_legacy_image_data" ]; then
  echo "image relay data migration/retirement required: $bb_legacy_image_data -> $bb_data_root/image-relay (use deploy/production/migrate-image-relay-data.sh after inventory; it creates and retains $bb_data_root/image-relay-recovery until image smoke passes)" >&2
  exit 1
fi
if [ -e "$bb_legacy_relay_env" ]; then
  echo "legacy relay secret remains: $bb_legacy_relay_env; retire it after inventory before deploying image-relay" >&2
  exit 1
fi

ensure_service_data_directory() {
  bb_directory="$1"
  if [ ! -e "$bb_directory" ]; then
    install -d -m 0700 "$bb_directory"
    chown 1000:1000 "$bb_directory"
  fi
  [ -d "$bb_directory" ] || { echo "service data path is not a directory: $bb_directory" >&2; exit 1; }
  [ "$(stat -c '%u:%g' "$bb_directory")" = '1000:1000' ] || {
    echo "service data directory has unexpected ownership: $bb_directory (expected 1000:1000; correct it as a one-time targeted maintenance action)" >&2
    exit 1
  }
}

ensure_service_data_directory "$bb_data_root/gateway"
ensure_service_data_directory "$bb_data_root/image-relay"
ensure_service_data_directory "$bb_data_root/image-relay/blobs"
ensure_service_data_directory "$bb_data_root/video-media-relay"
docker compose -f "$bb_compose_file" up -d --wait --wait-timeout 180 gateway image-relay video-media-relay

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8799/healthz >/dev/null
docker compose -f "$bb_compose_file" exec -T image-relay bun -e \
  "const response = await fetch('http://127.0.0.1:8790/healthz'); if (!response.ok) process.exit(1)"
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8791/readyz >/dev/null

# Install the versioned route fragment only after all loopback services are
# healthy. The installer atomically replaces the fragment, tests Nginx and
# reloads it; any unexpected root-domain vhost fails closed before this point.
bash "$bb_script_dir/install-nginx-relay-routes.sh" "$bb_nginx_vhost"

ln -sfn "$bb_repo_root" /srv/billiardbuddy/current
printf 'DEPLOYED_RELEASE=%s\n' "$bb_release_id"
printf 'DEPLOYED_SOURCE_REVISION=%s\n' "$bb_source_revision"
