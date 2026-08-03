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

for bb_required in "$bb_secret_root/gateway.env" "$bb_secret_root/relay.env" "$bb_secret_root/video-media-relay.env"; do
  [ -f "$bb_required" ] || { echo "missing $bb_required" >&2; exit 1; }
  chmod 600 "$bb_required"
done

install -d -m 0700 "$bb_data_root/gateway" "$bb_data_root/relay" "$bb_data_root/relay/blobs" "$bb_data_root/video-media-relay"
chown -R 1000:1000 "$bb_data_root/gateway" "$bb_data_root/relay" "$bb_data_root/video-media-relay"

# Both validators parse configuration as data and never source or print credentials.
bash "$bb_repo_root/gateway/validate-mimo-capacity-env.sh" "$bb_secret_root/gateway.env"
bash "$bb_repo_root/gateway/validate-production-capacity-env.sh" "$bb_secret_root/gateway.env"
bash "$bb_repo_root/relay/validate-production-env.sh" "$bb_secret_root/relay.env"
# Production hosts run the services in containers and do not require Bun on
# the host. Keep the Video Relay validator in the same pinned Bun runtime as
# its image so a missing host executable cannot bypass or block deployment.
docker run --rm --network none \
  -v "$bb_repo_root/video-media-relay:/app/video-media-relay:ro" \
  -v "$bb_secret_root/video-media-relay.env:/secrets/video-media-relay.env:ro" \
  oven/bun:1.3.14 \
  bun /app/video-media-relay/validate-deployment-env.ts /secrets/video-media-relay.env

bb_release_id="${BILLIARDBUDDY_RELEASE:-$(printf '%s' "$bb_source_revision" | cut -c1-12)}"
export BILLIARDBUDDY_RELEASE="$bb_release_id"

docker compose -f "$bb_compose_file" config --quiet
docker compose -f "$bb_compose_file" build --pull gateway relay video-media-relay
# Run the Gateway preflight under the exact Compose environment, including the
# private `http://relay:8790` hop. It opens neither the database nor a model connection.
docker compose -f "$bb_compose_file" run --rm --no-deps --entrypoint bun gateway \
  /app/gateway/validate-deployment-env.ts --process-env
docker compose -f "$bb_compose_file" up -d --wait --wait-timeout 180 gateway relay video-media-relay

curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8799/healthz >/dev/null
docker compose -f "$bb_compose_file" exec -T relay bun -e \
  "const response = await fetch('http://127.0.0.1:8790/healthz'); if (!response.ok) process.exit(1)"
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8791/readyz >/dev/null

ln -sfn "$bb_repo_root" /srv/billiardbuddy/current
printf 'DEPLOYED_RELEASE=%s\n' "$bb_release_id"
printf 'DEPLOYED_SOURCE_REVISION=%s\n' "$bb_source_revision"
