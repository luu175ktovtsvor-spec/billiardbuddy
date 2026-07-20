#!/usr/bin/env bash
# Validate only non-secret 1000-window qfgw capacity fields in a systemd EnvironmentFile.
# Never source the file: it also contains app tokens and provider credentials.
set -euo pipefail

env_file="${1:-}"
if [[ -z "$env_file" || ! -f "$env_file" ]]; then
  echo "Usage: $0 /path/to/gw.env" >&2
  exit 2
fi

die() {
  echo "Invalid 1000-window gateway capacity configuration: $1" >&2
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Missing values deliberately resolve to app.ts production defaults. An explicit
# malformed/legacy value must fail deployment rather than silently leave the host
# at an 800-window profile while source code claims a 1000-window target.
read_decimal() {
  local name="$1"
  local fallback="$2"
  local raw
  raw="$(awk -v name="$name" '
    $0 ~ "^[[:space:]]*" name "[[:space:]]*=" {
      sub("^[[:space:]]*" name "[[:space:]]*=[[:space:]]*", "")
      value = $0
    }
    END { if (value != "") print value }
  ' "$env_file")"
  raw="$(trim "$raw")"
  if [[ -z "$raw" ]]; then
    printf '%s' "$fallback"
    return
  fi
  if [[ ( "$raw" == \"*\" && "$raw" == *\" ) || ( "$raw" == \'*\' && "$raw" == *\' ) ]]; then
    raw="${raw:1:${#raw}-2}"
    raw="$(trim "$raw")"
  fi
  [[ "$raw" =~ ^[0-9]+$ ]] || die "$name must be a non-negative decimal integer"
  [[ ${#raw} -le 9 ]] || die "$name is too large"
  local value=$((10#$raw))
  printf '%s' "$value"
}

deepseek_total="$(read_decimal GW_DEEPSEEK_CONC 1000)"
deepseek_user="$(read_decimal GW_DEEPSEEK_USER_CONC 10)"
deepseek_token="$(read_decimal GW_DEEPSEEK_TOKEN_CONC 1000)"
image_ipm="$(read_decimal GW_IMG_IPM 1200)"
image_waiters="$(read_decimal GW_IMG_QUEUE_MAX 200)"
idle_timeout="$(read_decimal GW_SERVER_IDLE_TIMEOUT_SECONDS 255)"
relay_result_timeout="$(read_decimal GW_RELAY_RESULT_TIMEOUT_MS 300000)"

(( deepseek_total >= 1000 )) || die 'GW_DEEPSEEK_CONC must be at least 1000 for the 100 x 10 target'
(( deepseek_user >= 10 )) || die 'GW_DEEPSEEK_USER_CONC must be at least 10 for the 100 x 10 target'
(( deepseek_token >= 1000 )) || die 'GW_DEEPSEEK_TOKEN_CONC must be at least 1000 for the 100 x 10 target'
(( image_ipm >= 1000 )) || die 'GW_IMG_IPM must be at least 1000 to admit the small-image burst'
(( image_waiters >= 0 )) || die 'GW_IMG_QUEUE_MAX must be non-negative'
(( idle_timeout >= 30 && idle_timeout <= 255 )) || die 'GW_SERVER_IDLE_TIMEOUT_SECONDS must be between 30 and 255'
(( relay_result_timeout >= 300000 )) || die 'GW_RELAY_RESULT_TIMEOUT_MS must be at least 300000 (5 minutes)'

printf '1000-window gateway capacity configuration accepted: deepseek=%s user=%s token=%s image_ipm=%s image_waiters=%s idle_timeout=%s relay_result_timeout=%s\n' \
  "$deepseek_total" "$deepseek_user" "$deepseek_token" "$image_ipm" "$image_waiters" "$idle_timeout" "$relay_result_timeout"
