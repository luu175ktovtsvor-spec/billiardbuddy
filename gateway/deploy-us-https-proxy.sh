#!/usr/bin/env bash
# Run as root on the US Nginx server after copying qfgw-us-https-proxy.conf to /tmp.
# It preserves dated backups and restores them if nginx -t rejects the change.
# A 1000-window SSE burst needs both the /gw/ location and enough Nginx event
# connections: every proxied stream consumes one client-side and one upstream
# connection. This script requires an effective worker_connections floor of 8192.
set -euo pipefail

site_file="${QF_US_NGINX_SITE:-/etc/nginx/sites-available/billiards}"
snippet_source="${QF_US_PROXY_SNIPPET_SOURCE:-/tmp/qfgw-us-https-proxy.conf}"
snippet_dir="${QF_US_PROXY_SNIPPET_DIR:-/etc/nginx/snippets}"
snippet_file="$snippet_dir/qfgw-us-https-proxy.conf"
main_config="${QF_US_NGINX_MAIN_CONFIG:-/etc/nginx/nginx.conf}"
required_connections="${QF_US_NGINX_WORKER_CONNECTIONS:-8192}"
include_line="    include $snippet_file;"

test -f "$site_file"
test -f "$snippet_source"
test -f "$main_config"
if ! [[ "$required_connections" =~ ^[0-9]+$ ]] || (( 10#$required_connections < 8192 )); then
  echo 'QF_US_NGINX_WORKER_CONNECTIONS must be a decimal integer of at least 8192' >&2
  exit 2
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
site_backup=""
snippet_backup=""
main_config_backup=""
created_snippet=0

restore_changes() {
  if test -n "$main_config_backup"; then cp -p "$main_config_backup" "$main_config"; fi
  if test -n "$site_backup"; then cp -p "$site_backup" "$site_file"; fi
  if test -n "$snippet_backup"; then
    cp -p "$snippet_backup" "$snippet_file"
  elif test "$created_snippet" -eq 1; then
    rm -f -- "$snippet_file"
  fi
}

worker_connection_lines="$(awk '/^[[:space:]]*worker_connections[[:space:]]+[0-9]+[[:space:]]*;[[:space:]]*$/ { count += 1; value = $2; sub(/;/, "", value) } END { if (count == 1) print value; else exit 42 }' "$main_config")" || {
  echo "Expected exactly one worker_connections directive in $main_config" >&2
  exit 1
}

if (( 10#$worker_connection_lines < 10#$required_connections )); then
  main_config_backup="${main_config}.qfgw-capacity-${timestamp}.bak"
  cp -p "$main_config" "$main_config_backup"
  main_candidate="$(mktemp "${main_config}.qfgw-capacity.XXXXXX")"
  if ! awk -v required="$required_connections" '
    /^[[:space:]]*worker_connections[[:space:]]+[0-9]+[[:space:]]*;[[:space:]]*$/ {
      sub(/[0-9]+[[:space:]]*;[[:space:]]*$/, required ";")
      changed += 1
    }
    { print }
    END { if (changed != 1) exit 42 }
  ' "$main_config" > "$main_candidate"; then
    rm -f -- "$main_candidate"
    echo "Could not update worker_connections in $main_config" >&2
    exit 1
  fi
  install -m 644 "$main_candidate" "$main_config"
  rm -f -- "$main_candidate"
fi

if grep -Fqx "$include_line" "$site_file"; then
  :
else
  site_backup="${site_file}.qfgw-proxy-${timestamp}.bak"
  cp -p "$site_file" "$site_backup"
  site_candidate="$(mktemp "${site_file}.qfgw-proxy.XXXXXX")"
  if ! awk -v line="$include_line" '
    !inserted && $0 ~ /^[[:space:]]*listen 443 ssl;[[:space:]]*$/ { print line; inserted = 1 }
    { print }
    END { if (!inserted) exit 42 }
  ' "$site_file" > "$site_candidate"; then
    rm -f -- "$site_candidate"
    echo "Could not find the HTTPS listen directive in $site_file" >&2
    exit 1
  fi
  install -m 644 "$site_candidate" "$site_file"
  rm -f -- "$site_candidate"
fi

install -d -m 755 "$snippet_dir"
if test -f "$snippet_file"; then
  snippet_backup="${snippet_file}.qfgw-proxy-${timestamp}.bak"
  cp -p "$snippet_file" "$snippet_backup"
else
  created_snippet=1
fi
install -m 644 "$snippet_source" "$snippet_file"

if ! nginx -t; then
  restore_changes
  nginx -t || true
  echo "qfgw HTTPS proxy/capacity settings were not applied; backups were restored." >&2
  exit 1
fi

if ! systemctl reload nginx; then
  restore_changes
  nginx -t || true
  systemctl reload nginx || true
  echo "qfgw HTTPS proxy/capacity settings were not applied because nginx reload failed; backups were restored." >&2
  exit 1
fi

echo "qfgw HTTPS proxy enabled at /gw/ with worker_connections >= $required_connections"
