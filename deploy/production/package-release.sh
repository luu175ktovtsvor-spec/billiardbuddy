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
  gateway/managedResponses.ts
  gateway/mimoChat.ts
  gateway/visionBridge.ts
  gateway/qwenImageReasoning.ts
  gateway/providerRegistry.ts
  gateway/usageBudget.ts
  gateway/operationResultStore.ts
  gateway/validate-deployment-env.ts
  gateway/validate-mimo-capacity-env.sh
  gateway/validate-production-capacity-env.sh
  relay/app.ts
  relay/validate-production-env.sh
  ts/shared/product/providerContracts.ts
  ts/shared/product/providerGateway.ts
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
  gateway/app.ts \
  gateway/managedResponses.ts \
  gateway/validate-deployment-env.ts \
  relay/app.ts \
  release-manifest.json; do
  tar -tzf "$bb_output" "$bb_required" >/dev/null
done

printf 'PACKAGED_RELEASE=%s\n' "$bb_revision_sha"
