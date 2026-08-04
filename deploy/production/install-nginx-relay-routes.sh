#!/usr/bin/env bash
set -euo pipefail

# This script is deliberately conservative. It never discovers a vhost by
# hostname and never writes a generic /etc/nginx/conf.d fragment: `location`
# directives must belong to the exact TLS server selected during a read-only
# production inventory.

if [ "$(id -u)" -ne 0 ]; then
  echo 'Nginx route installation must run as root' >&2
  exit 1
fi

bb_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bb_source="$bb_script_dir/nginx/billiardbuddy-relay-routes.conf"
bb_fragment=/etc/nginx/snippets/billiardbuddy-video-media.conf
bb_include="include $bb_fragment;"
bb_marker_begin='# BILLIARDBUDDY_RELAY_ROUTES_BEGIN'
bb_marker_end='# BILLIARDBUDDY_RELAY_ROUTES_END'

usage() {
  echo 'usage: install-nginx-relay-routes.sh [--install-include|--verify|--verify-vhost] /etc/nginx/.../root-domain-vhost.conf' >&2
  exit 64
}

bb_mode=apply
case "${1:-}" in
  --install-include) bb_mode=install-include; shift ;;
  --verify) bb_mode=verify; shift ;;
  --verify-vhost) bb_mode=verify-vhost; shift ;;
esac
[ "$#" -eq 1 ] || usage
bb_vhost="$1"

case "$bb_vhost" in
  /etc/nginx/*) ;;
  *) echo 'root-domain vhost must be an absolute path below /etc/nginx' >&2; exit 1 ;;
esac
[ -f "$bb_vhost" ] || { echo "missing selected root-domain vhost: $bb_vhost" >&2; exit 1; }
[ -r "$bb_vhost" ] || { echo "selected root-domain vhost is unreadable: $bb_vhost" >&2; exit 1; }
[ -f "$bb_source" ] || { echo "missing route source: $bb_source" >&2; exit 1; }

# A selected file must explicitly name the root domain. A wildcard, default
# server or sibling billiardbuddy.zzyppz.cn site is insufficient evidence.
if ! awk '
  $1 == "server_name" {
    for (i = 2; i <= NF; i++) {
      value = $i
      sub(/;$/, "", value)
      if (value == "zzyppz.cn") found = 1
    }
  }
  END { exit found ? 0 : 1 }
' "$bb_vhost"; then
  echo "selected vhost does not explicitly contain server_name zzyppz.cn: $bb_vhost" >&2
  exit 1
fi

has_include() {
  awk -v expected="$bb_include" '
    { line = $0; sub(/^[[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line); if (line == expected) found = 1 }
    END { exit found ? 0 : 1 }
  ' "$bb_vhost"
}

if [ "$bb_mode" = verify-vhost ]; then
  has_include || { echo "selected vhost lacks the explicit BilliardBuddy Relay include: $bb_include" >&2; exit 1; }
  exit 0
fi

if [ "$bb_mode" = verify ]; then
  has_include || { echo "selected vhost lacks the explicit BilliardBuddy Relay include: $bb_include" >&2; exit 1; }
  [ -f "$bb_fragment" ] || { echo "missing installed Relay route fragment: $bb_fragment" >&2; exit 1; }
  cmp -s "$bb_source" "$bb_fragment" || { echo 'installed Relay route fragment does not match this release' >&2; exit 1; }
  nginx -t
  exit 0
fi

bb_temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/billiardbuddy-nginx.XXXXXX")"
bb_vhost_backup="$bb_temp_dir/vhost.original"
bb_fragment_backup="$bb_temp_dir/fragment.original"
bb_vhost_changed=0
bb_fragment_existed=0
cleanup() { rm -rf "$bb_temp_dir"; }
trap cleanup EXIT

rollback() {
  local failed=0
  if [ "$bb_vhost_changed" -eq 1 ] && ! cp -p "$bb_vhost_backup" "$bb_vhost"; then failed=1; fi
  if [ "$bb_fragment_existed" -eq 1 ]; then
    if ! cp -p "$bb_fragment_backup" "$bb_fragment"; then failed=1; fi
  else
    if ! rm -f "$bb_fragment"; then failed=1; fi
  fi
  return "$failed"
}

if [ "$bb_mode" = install-include ]; then
  # Automatic insertion is intentionally limited to a selected, dedicated
  # one-server vhost. More complex configurations require a human to add the
  # exact include after inventory; deployment then uses the normal apply mode.
  bb_server_count="$(awk '/^[[:space:]]*server[[:space:]]*\{/ { count++ } END { print count + 0 }' "$bb_vhost")"
  if [ "$bb_server_count" -ne 1 ]; then
    echo 'refusing automatic include insertion: selected vhost must contain exactly one server block' >&2
    exit 1
  fi
  cp -p "$bb_vhost" "$bb_vhost_backup"
  bb_vhost_next="$bb_temp_dir/vhost.next"
  awk -v begin="$bb_marker_begin" -v end="$bb_marker_end" -v include="$bb_include" '
    $0 == begin { dropping = 1; next }
    dropping && $0 == end { dropping = 0; next }
    dropping { next }
    { lines[++count] = $0 }
    END {
      depth = 0
      inserted = 0
      for (index = 1; index <= count; index++) {
        line = lines[index]
        open_line = line; opened = gsub(/\{/, "", open_line)
        close_line = line; closed = gsub(/\}/, "", close_line)
        if (!inserted && depth > 0 && depth + opened - closed == 0) {
          print begin
          print "    " include
          print end
          inserted = 1
        }
        print line
        depth += opened - closed
      }
      if (!inserted || depth != 0 || dropping) exit 2
    }
  ' "$bb_vhost" > "$bb_vhost_next" || { echo 'cannot produce an unambiguous selected vhost update' >&2; exit 1; }
  cp -p "$bb_vhost_next" "$bb_vhost"
  bb_vhost_changed=1
fi

has_include || { rollback; echo "selected vhost lacks the explicit BilliardBuddy Relay include: $bb_include" >&2; exit 1; }
install -d -m 0755 /etc/nginx/snippets
if [ -e "$bb_fragment" ]; then
  [ -f "$bb_fragment" ] || { rollback; echo "installed Relay fragment is not a regular file: $bb_fragment" >&2; exit 1; }
  cp -p "$bb_fragment" "$bb_fragment_backup"
  bb_fragment_existed=1
fi
bb_fragment_next="$bb_temp_dir/relay-routes.next"
install -m 0644 "$bb_source" "$bb_fragment_next"
mv -f "$bb_fragment_next" "$bb_fragment"

if ! nginx -t; then
  rollback || { echo 'Nginx configuration rejected the Relay route update and prior selected files could not be restored' >&2; exit 1; }
  nginx -t >/dev/null || true
  echo 'Nginx configuration rejected the Relay route update; restored the prior selected files' >&2
  exit 1
fi
if ! systemctl reload nginx; then
  if ! rollback; then
    echo 'Nginx reload failed and prior selected files could not be restored: running Nginx state is unknown' >&2
    exit 1
  fi
  if ! nginx -t; then
    echo 'Nginx reload failed; restored prior files, but restored configuration does not validate: running Nginx state is unknown' >&2
    exit 1
  fi
  if ! systemctl reload nginx; then
    echo 'Nginx reload failed; restored prior files, but reload of restored configuration also failed: running Nginx state is unknown' >&2
    exit 1
  fi
  echo 'Nginx reload failed; restored the prior selected files and explicitly reloaded the restored configuration' >&2
  exit 1
fi

printf 'INSTALLED_NGINX_RELAY_ROUTES=%s\n' "$bb_fragment"
