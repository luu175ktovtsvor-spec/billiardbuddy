#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'usage: package-release.sh OUTPUT_TAR_GZ [GIT_REVISION]' >&2
  exit 64
fi

bb_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bb_repo_root="$(cd "$bb_script_dir/../.." && pwd)"
bb_output="$1"
bb_revision="${2:-HEAD}"
bb_revision_sha="$(git -C "$bb_repo_root" rev-parse --verify "${bb_revision}^{commit}")"
bb_manifest_dir="$(mktemp -d "${TMPDIR:-/tmp}/billiardbuddy-release-manifest.XXXXXX")"
bb_manifest_path="$bb_manifest_dir/release-manifest.json"

cleanup_manifest() {
  unlink "$bb_manifest_path" 2>/dev/null || true
  rmdir "$bb_manifest_dir" 2>/dev/null || true
}
trap cleanup_manifest EXIT

bb_runtime_paths=(
  deploy/production
  gateway/app.ts
  gateway/installationAuth.ts
  gateway/transcription.ts
  gateway/modelCapacity.ts
  gateway/capacityPolicy.ts
  gateway/quotaPolicy.ts
  gateway/providerCredentials.ts
  gateway/serviceCredentials.ts
  gateway/managedResponses.ts
  gateway/mimoChat.ts
  gateway/visionBridge.ts
  gateway/qwenImageReasoning.ts
  gateway/providerRegistry.ts
  gateway/usageBudget.ts
  gateway/operationResultStore.ts
  gateway/validate-deployment-env.ts
  relay/app.ts
  relay/capacityPolicy.ts
  relay/quotaPolicy.ts
  relay/providerCredentials.ts
  relay/identityIntrospection.ts
  relay/resultCredentials.ts
  relay/validate-deployment-env.ts
  video-media-relay/app.ts
  video-media-relay/objectStore.ts
  video-media-relay/providerRegistry.ts
  video-media-relay/capacityPolicy.ts
  video-media-relay/identityIntrospection.ts
  video-media-relay/network.ts
  video-media-relay/validate-deployment-env.ts
  video-media-relay/contracts/relayApi.ts
  video-media-relay/providers/dashscope.ts
  ts/package.json
  ts/bun.lock
  ts/shared/kernel/providerAdmission.ts
  ts/shared/kernel/deploymentEnvironment.ts
  ts/shared/product/providerContracts.ts
  ts/shared/product/modelCatalog.ts
  ts/shared/product/providerGateway.ts
  ts/shared/product/serviceIntrospection.ts
  ts/shared/product/imageRelayProtocol.ts
  ts/shared/product/imageVisualReasoning.ts
)

mkdir -p "$(dirname "$bb_output")"
printf '{"schema_version":1,"git_revision":"%s"}\n' "$bb_revision_sha" > "$bb_manifest_path"
git -C "$bb_repo_root" archive --format=tar --add-file="$bb_manifest_path" "$bb_revision_sha" "${bb_runtime_paths[@]}" | gzip -9 > "$bb_output"
test -s "$bb_output"

for bb_required in \
  deploy/production/compose.yml \
  deploy/production/deploy.sh \
  deploy/production/Dockerfile.gateway \
  deploy/production/Dockerfile.relay \
  deploy/production/Dockerfile.video-media-relay \
  deploy/production/container-entrypoint.sh \
  deploy/production/gateway-smoke.ts \
  deploy/production/image-relay-smoke.ts \
  deploy/production/production-smoke.ts \
  deploy/production/video-media-smoke.ts \
  deploy/production/migrate-relay-secrets.ts \
  deploy/production/install-nginx-relay-routes.sh \
  deploy/production/migrate-image-relay-data.sh \
  deploy/production/nginx/billiardbuddy-relay-routes.conf \
  gateway/app.ts \
  gateway/managedResponses.ts \
  gateway/serviceCredentials.ts \
  gateway/validate-deployment-env.ts \
  relay/app.ts \
  relay/capacityPolicy.ts \
  relay/quotaPolicy.ts \
  relay/identityIntrospection.ts \
  video-media-relay/app.ts \
  video-media-relay/objectStore.ts \
  video-media-relay/providerRegistry.ts \
  video-media-relay/capacityPolicy.ts \
  video-media-relay/identityIntrospection.ts \
  video-media-relay/network.ts \
  video-media-relay/validate-deployment-env.ts \
  video-media-relay/contracts/relayApi.ts \
  video-media-relay/providers/dashscope.ts \
  ts/shared/kernel/providerAdmission.ts \
  ts/shared/kernel/deploymentEnvironment.ts \
  ts/shared/product/providerContracts.ts \
  ts/shared/product/modelCatalog.ts \
  ts/shared/product/serviceIntrospection.ts \
  ts/shared/product/imageVisualReasoning.ts \
  ts/package.json \
  ts/bun.lock \
  release-manifest.json; do
  tar -tzf "$bb_output" "$bb_required" >/dev/null
done

printf 'PACKAGED_RELEASE=%s\n' "$bb_revision_sha"
