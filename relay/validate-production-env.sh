#!/usr/bin/env bash
# Validate non-secret relay durability/capacity fields without sourcing relay.env.
# The file also contains the OpenAI key and relay bearer token, so executing it is
# never acceptable during a deployment preflight.
set -euo pipefail

output_mode='summary'
if [[ "${1:-}" == '--print-blob-dir' ]]; then
  output_mode='blob-dir'
  shift
fi

env_file="${1:-}"
if [[ $# -ne 1 || -z "$env_file" || ! -f "$env_file" ]]; then
  echo "Usage: $0 [--print-blob-dir] /path/to/relay.env" >&2
  exit 2
fi

die() {
  echo "Invalid 1000-window relay production configuration: $1" >&2
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

read_value() {
  local name="$1"
  local raw
  raw="$(awk -v name="$name" '
    $0 ~ "^[[:space:]]*" name "[[:space:]]*=" {
      sub("^[[:space:]]*" name "[[:space:]]*=[[:space:]]*", "")
      value = $0
    }
    END { if (value != "") print value }
  ' "$env_file")"
  raw="$(trim "$raw")"
  if [[ ( "$raw" == \"*\" && "$raw" == *\" ) || ( "$raw" == \'*\' && "$raw" == *\' ) ]]; then
    raw="${raw:1:${#raw}-2}"
    raw="$(trim "$raw")"
  fi
  printf '%s' "$raw"
}

read_nonnegative() {
  local name="$1"
  local fallback="$2"
  local raw
  raw="$(read_value "$name")"
  if [[ -z "$raw" ]]; then
    printf '%s' "$fallback"
    return
  fi
  [[ "$raw" =~ ^[0-9]+$ ]] || die "$name must be a non-negative decimal integer"
  [[ ${#raw} -le 9 ]] || die "$name is too large"
  printf '%s' "$((10#$raw))"
}

validate_blob_dir() {
  local path="$1"
  local component
  local IFS='/'
  local -a components

  [[ "$path" != *'$'* && "$path" != *'`'* && "$path" != *\\* ]] || die 'RELAY_BLOB_DIR contains unsafe path characters'
  [[ "$path" == /* && "$path" != '/' ]] || die 'RELAY_BLOB_DIR must be a non-root absolute path'
  # Production paths are deliberately limited to plain ASCII filesystem names. This
  # rejects shell expressions such as $APPDIR/blobs without ever evaluating relay.env.
  [[ "$path" =~ ^/[A-Za-z0-9._/-]+$ ]] || die 'RELAY_BLOB_DIR contains unsafe path characters'
  [[ "$path" != *'//' ]] || die 'RELAY_BLOB_DIR must not contain empty path components'
  [[ "${path##*/}" == *[Bb][Ll][Oo][Bb]* ]] || die 'RELAY_BLOB_DIR must name a dedicated blob directory'

  read -r -a components <<< "${path#/}"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != '.' && "$component" != '..' ]] || die 'RELAY_BLOB_DIR must not contain relative path components'
  done
}

db_path="$(read_value RELAY_DB)"
blob_dir="$(read_value RELAY_BLOB_DIR)"
ark_key="$(read_value RELAY_ARK_KEY)"
[[ -n "$db_path" && "$db_path" != ':memory:' ]] || die 'RELAY_DB must be a persistent SQLite path'
[[ -n "$blob_dir" ]] || die 'RELAY_BLOB_DIR must be configured for durable queued input'
[[ -n "$ark_key" ]] || die 'RELAY_ARK_KEY must be configured for the Seedream image model'
while [[ "$blob_dir" == */ && "$blob_dir" != '/' ]]; do
  blob_dir="${blob_dir%/}"
done
validate_blob_dir "$blob_dir"

queue_max="$(read_nonnegative RELAY_QUEUE_MAX 1200)"
user_max="$(read_nonnegative RELAY_USER_MAX 10)"
image_conc="$(read_nonnegative RELAY_IMG_CONC 6)"
image_user_conc="$(read_nonnegative RELAY_IMG_USER_CONC 1)"

(( queue_max >= 1000 )) || die 'RELAY_QUEUE_MAX must be at least 1000 for the 100 x 10 small-task burst'
(( user_max >= 10 )) || die 'RELAY_USER_MAX must be at least 10 for the 100 x 10 target'
(( image_conc >= 1 )) || die 'RELAY_IMG_CONC must be at least 1'
(( image_user_conc >= 1 )) || die 'RELAY_IMG_USER_CONC must be at least 1'

if [[ "$output_mode" == 'blob-dir' ]]; then
  printf '%s\n' "$blob_dir"
  exit 0
fi

printf '1000-window relay production configuration accepted: queue=%s user=%s image_conc=%s image_user_conc=%s\n' \
  "$queue_max" "$user_max" "$image_conc" "$image_user_conc"
