#!/usr/bin/env bash
set -euo pipefail

# One-time, explicit migration for the pre-rename Image Relay SQLite/CAS tree.
# It deliberately leaves a root-only recovery snapshot behind.  Normal deploys
# never recurse through image blobs or SQLite files, and this script never
# deletes the snapshot: an operator may remove it only after the new release's
# submit/poll/result/ACK smoke is known to have passed.

bb_test_mode="${BILLIARDBUDDY_IMAGE_RELAY_MIGRATION_TEST_MODE:-}"
bb_data_root="${BILLIARDBUDDY_IMAGE_RELAY_DATA_ROOT:-/srv/billiardbuddy/data}"

fail() {
  echo "image relay data migration failed: $*" >&2
  exit 1
}

if [ "$bb_test_mode" = '1' ]; then
  # This narrowly scoped seam lets the companion test exercise the exact
  # migration script without Docker or root. Production may never override its
  # fixed /srv data root through this environment variable.
  case "$bb_data_root" in /*) ;; *) fail 'test data root must be an absolute path' ;; esac
  bb_expected_uid="$(id -u)"
  bb_expected_gid="$(id -g)"
  bb_snapshot_uid="$bb_expected_uid"
  bb_snapshot_gid="$bb_expected_gid"
  bb_skip_container_check=1
elif [ -n "$bb_test_mode" ]; then
  fail 'BILLIARDBUDDY_IMAGE_RELAY_MIGRATION_TEST_MODE must be exactly 1 when set'
else
  [ "$bb_data_root" = '/srv/billiardbuddy/data' ] || fail 'production data root is fixed at /srv/billiardbuddy/data'
  [ "$(id -u)" -eq 0 ] || fail 'image relay data migration must run as root'
  bb_expected_uid=1000
  bb_expected_gid=1000
  bb_snapshot_uid=0
  bb_snapshot_gid=0
  bb_skip_container_check=0
fi

bb_legacy="$bb_data_root/relay"
bb_target="$bb_data_root/image-relay"
# The directory name is intentionally deterministic and must be absent. This
# makes a retry fail closed rather than overwriting the only recovery evidence.
bb_snapshot="$bb_data_root/image-relay-recovery"

fsync_path() {
  bun -e 'import { closeSync, fsyncSync, openSync } from "node:fs"; const path = process.argv[1]; if (!path) process.exit(64); const fd = openSync(path, "r"); try { fsyncSync(fd) } finally { closeSync(fd) }' -- "$1"
}

same_device() {
  bun -e 'import { statSync } from "node:fs"; const [left, right] = process.argv.slice(1); if (!left || !right || statSync(left).dev !== statSync(right).dev) process.exit(1)' -- "$1" "$2"
}

checkpoint_sqlite() {
  bun -e 'import { Database } from "bun:sqlite"; const path = process.argv[1]; if (!path) process.exit(64); const db = new Database(path); try { const row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | null; if (Number(row?.busy ?? 0) !== 0) throw new Error("SQLite checkpoint remained busy") } finally { db.close() }' -- "$1"
}

assert_safe_tree() {
  # find -xdev only avoids descending through a mount point; it still prints
  # that mount point and a later recursive copy could cross it. Walk via lstat
  # and require every directory/file to have the root device explicitly.
  bun -e 'import { lstatSync, readdirSync } from "node:fs"; const root = process.argv[1]; if (!root) process.exit(64); const rootStat = lstatSync(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`not a real directory: ${root}`); const testFakeMount = process.env.BILLIARDBUDDY_IMAGE_RELAY_MIGRATION_TEST_MODE === "1" ? process.env.BILLIARDBUDDY_IMAGE_RELAY_TEST_FAKE_NESTED_MOUNT : undefined; const visit = (path: string, relative: string): void => { const stat = lstatSync(path); const simulatedDevice = testFakeMount === relative ? rootStat.dev + 1 : stat.dev; if (simulatedDevice !== rootStat.dev) throw new Error(`refusing nested mountpoint in migration tree: ${relative || "."}`); if (stat.isSymbolicLink()) throw new Error(`refusing symbolic link in migration tree: ${relative || "."}`); if (!stat.isDirectory() && !stat.isFile()) throw new Error(`refusing non-regular file in migration tree: ${relative || "."}`); if (relative.includes("\\n") || relative.includes("\\r")) throw new Error(`refusing control character in migration path: ${relative}`); if (stat.isDirectory()) for (const child of readdirSync(path)) visit(`${path}/${child}`, relative ? `${relative}/${child}` : child) }; visit(root, "")' -- "$1" || fail 'unsafe migration tree'
}

normalise_snapshot_permissions() {
  local root="$1"
  find -P "$root" -xdev -type d -exec chmod 700 {} +
  find -P "$root" -xdev -type f -exec chmod 600 {} +
}

verify_tree_owner_and_mode() {
  local root="$1" uid="$2" gid="$3"
  bun -e 'import { lstatSync, readdirSync } from "node:fs"; const [root, uidText, gidText] = process.argv.slice(1); const uid = Number(uidText); const gid = Number(gidText); const visit = (path: string): void => { const stat = lstatSync(path); if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`unexpected tree entry: ${path}`); const required = stat.isDirectory() ? 0o700 : 0o600; if ((stat.mode & 0o777) !== required || stat.uid !== uid || stat.gid !== gid) throw new Error(`owner or mode mismatch: ${path}`); if (stat.isDirectory()) for (const child of readdirSync(path)) visit(`${path}/${child}`) }; visit(root)' -- "$root" "$uid" "$gid"
}

write_and_verify_snapshot_manifest() {
  local source="$1" snapshot="$2" path relative source_hash snapshot_hash source_size snapshot_size source_count=0 snapshot_count=0 source_directories=0 snapshot_directories=0
  : > "$snapshot/manifest.sha256"
  chmod 600 "$snapshot/manifest.sha256"
  while IFS= read -r -d '' path; do
    relative="${path#"$source"}"
    relative="${relative#/}"
    [ -n "$relative" ] || relative='.'
    [ -d "$snapshot/$relative" ] || fail "snapshot directory missing: $relative"
    printf 'D\t%s\n' "$relative" >> "$snapshot/manifest.sha256"
    source_directories=$((source_directories + 1))
  done < <(find -P "$source" -xdev -type d -print0)
  while IFS= read -r -d '' path; do
    [ -f "$path" ] || continue
    relative="${path#"$source"/}"
    source_hash="$(shasum -a 256 "$path" | awk '{print $1}')"
    snapshot_hash="$(shasum -a 256 "$snapshot/$relative" | awk '{print $1}')"
    source_size="$(wc -c < "$path" | tr -d '[:space:]')"
    snapshot_size="$(wc -c < "$snapshot/$relative" | tr -d '[:space:]')"
    [ "$source_hash" = "$snapshot_hash" ] && [ "$source_size" = "$snapshot_size" ] || fail "snapshot hash mismatch: $relative"
    printf 'F\t%s\t%s\t%s\n' "$source_hash" "$source_size" "$relative" >> "$snapshot/manifest.sha256"
    source_count=$((source_count + 1))
  done < <(find -P "$source" -xdev -type f -print0)
  while IFS= read -r -d '' path; do
    relative="${path#"$snapshot"/}"
    [ "$relative" = 'manifest.sha256' ] || snapshot_count=$((snapshot_count + 1))
  done < <(find -P "$snapshot" -xdev -type f -print0)
  [ "$source_count" -eq "$snapshot_count" ] || fail 'snapshot contains a different regular-file count'
  while IFS= read -r -d '' path; do snapshot_directories=$((snapshot_directories + 1)); done < <(find -P "$snapshot" -xdev -type d -print0)
  [ "$source_directories" -eq "$snapshot_directories" ] || fail 'snapshot contains a different directory count'
  fsync_path "$snapshot/manifest.sha256"
}

create_recovery_snapshot() {
  [ ! -e "$bb_snapshot" ] || fail "recovery snapshot already exists: $bb_snapshot"
  mkdir -m 700 "$bb_snapshot"
  # The old Relay is stopped and WAL has been checkpointed; cp preserves every
  # regular SQLite/CAS byte. The preceding tree validation makes recursive copy
  # safe and the later hash manifest proves complete content equality.
  cp -pR "$bb_legacy/." "$bb_snapshot"
  # cp -p intentionally retains the historical service ownership. The recovery
  # copy must instead be root-only, independent of the live service account.
  chown -R "$bb_snapshot_uid:$bb_snapshot_gid" "$bb_snapshot"
  normalise_snapshot_permissions "$bb_snapshot"
  write_and_verify_snapshot_manifest "$bb_legacy" "$bb_snapshot"
  verify_tree_owner_and_mode "$bb_snapshot" "$bb_snapshot_uid" "$bb_snapshot_gid"
  while IFS= read -r -d '' path; do fsync_path "$path"; done < <(find -P "$bb_snapshot" -xdev -type f -print0)
  while IFS= read -r -d '' path; do fsync_path "$path"; done < <(find -P "$bb_snapshot" -xdev -type d -print0)
  fsync_path "$bb_data_root"
}

if [ "$bb_skip_container_check" -eq 0 ]; then
  bb_legacy_containers="$(docker ps -aq \
    --filter 'label=com.docker.compose.project=billiardbuddy' \
    --filter 'label=com.docker.compose.service=relay')"
  [ -z "$bb_legacy_containers" ] || fail 'legacy relay container still exists; stop/remove it before snapshotting SQLite/CAS data'
fi

[ -d "$bb_data_root" ] && [ ! -L "$bb_data_root" ] || fail "missing or unsafe data root: $bb_data_root"
[ ! -e "$bb_target" ] || fail "target image relay data directory already exists: $bb_target"
[ -d "$bb_legacy" ] && [ ! -L "$bb_legacy" ] || fail "missing legacy image relay data directory: $bb_legacy"
[ -f "$bb_legacy/relay.db" ] && [ ! -L "$bb_legacy/relay.db" ] || fail "missing legacy SQLite database: $bb_legacy/relay.db"
[ -d "$bb_legacy/blobs" ] && [ ! -L "$bb_legacy/blobs" ] || fail "missing legacy image relay blob directory: $bb_legacy/blobs"
assert_safe_tree "$bb_legacy"
same_device "$bb_legacy" "$bb_data_root" || fail 'legacy data and target parent are not on one filesystem; refusing non-atomic move'

# A failed checkpoint proves a writer has not really stopped. It is deliberately
# before snapshot creation and before any rename.
checkpoint_sqlite "$bb_legacy/relay.db" || fail 'legacy SQLite checkpoint failed; confirm the old Relay is fully stopped'
assert_safe_tree "$bb_legacy"
create_recovery_snapshot

if [ "$bb_test_mode" = '1' ] && [ "${BILLIARDBUDDY_IMAGE_RELAY_TEST_FAIL_AFTER_SNAPSHOT:-}" = '1' ]; then
  fail 'forced test failure after recovery snapshot'
fi

# `same_device` above makes this a rename(2), not a copy/delete. Persist its
# parent directory before declaring the historical source moved.
mv "$bb_legacy" "$bb_target"
fsync_path "$bb_data_root"
chown -R "$bb_expected_uid:$bb_expected_gid" "$bb_target"
normalise_snapshot_permissions "$bb_target"
verify_tree_owner_and_mode "$bb_target" "$bb_expected_uid" "$bb_expected_gid"
fsync_path "$bb_data_root"

printf 'MIGRATED_IMAGE_RELAY_DATA=%s\n' "$bb_target"
printf 'IMAGE_RELAY_RECOVERY_SNAPSHOT=%s\n' "$bb_snapshot"
