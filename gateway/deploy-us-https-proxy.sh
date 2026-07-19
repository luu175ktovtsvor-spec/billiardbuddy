#!/usr/bin/env bash
# Run as root on the US Nginx server after copying qfgw-us-https-proxy.conf to /tmp.
# It preserves dated backups and restores them if nginx -t rejects the change.
set -euo pipefail

site_file="${QF_US_NGINX_SITE:-/etc/nginx/sites-available/billiards}"
snippet_source="${QF_US_PROXY_SNIPPET_SOURCE:-/tmp/qfgw-us-https-proxy.conf}"
snippet_dir="${QF_US_PROXY_SNIPPET_DIR:-/etc/nginx/snippets}"
snippet_file="$snippet_dir/qfgw-us-https-proxy.conf"
include_line="    include $snippet_file;"

test -f "$site_file"
test -f "$snippet_source"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
site_backup=""
snippet_backup=""
created_snippet=0

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
  if test -n "$site_backup"; then cp -p "$site_backup" "$site_file"; fi
  if test -n "$snippet_backup"; then
    cp -p "$snippet_backup" "$snippet_file"
  elif test "$created_snippet" -eq 1; then
    rm -f -- "$snippet_file"
  fi
  nginx -t || true
  echo "qfgw HTTPS proxy was not applied; backups were restored." >&2
  exit 1
fi

systemctl reload nginx
echo "qfgw HTTPS proxy enabled at /gw/"
