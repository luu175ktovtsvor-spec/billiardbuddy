#!/usr/bin/env bash
# Validate the non-secret MiMo lane reservation fields in a systemd EnvironmentFile.
# Never source the file: it contains credentials and may use systemd-only quoting.
set -euo pipefail

env_file="${1:-}"
if [[ -z "$env_file" || ! -f "$env_file" ]]; then
  echo "Usage: $0 /path/to/gw.env" >&2
  exit 2
fi

die() {
  echo "Invalid MiMo capacity configuration: $1" >&2
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# The app treats a missing/blank value as its fallback. Deliberately accept only
# plain positive decimal values here: a deployment should fail before restart rather
# than silently turn a malformed capacity value into a different fallback.
read_capacity() {
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
  [[ "$raw" =~ ^[0-9]+$ ]] || die "$name must be a positive decimal integer"
  # Keep shell arithmetic bounded and reject values that cannot be a safe capacity.
  [[ ${#raw} -le 9 ]] || die "$name is too large"
  local value=$((10#$raw))
  (( value >= 1 )) || die "$name must be at least 1"
  printf '%s' "$value"
}

total="$(read_capacity GW_MIMO_CONC 64)"
(( total >= 2 )) || die 'GW_MIMO_CONC must leave at least one media-reasoning and one visual-evidence slot'

implicit_vision=$((total - 1))
if (( implicit_vision > 12 )); then implicit_vision=12; fi
vision="$(read_capacity GW_VISION_CONC "$implicit_vision")"
(( vision >= 1 && vision < total )) || die 'GW_VISION_CONC must leave at least one media-reasoning slot'

media="$(read_capacity GW_MIMO_MEDIA_CONC "$((total - vision))")"
(( media >= 1 )) || die 'GW_MIMO_MEDIA_CONC must be at least 1'
(( media + vision == total )) || die 'GW_MIMO_MEDIA_CONC + GW_VISION_CONC must equal GW_MIMO_CONC'

printf 'MiMo capacity validated: total=%s media=%s vision=%s\n' "$total" "$media" "$vision"
