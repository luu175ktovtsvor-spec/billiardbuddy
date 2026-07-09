#!/bin/bash
# 在【美国服务器】(zzyppz.cn,与 OpenAI 同区)部署 GPT 生图异步任务服务(relay/app.ts)。
# 只占 127.0.0.1:8790 + 一个 systemd 服务;真 OpenAI key 只放本机 relay.env(chmod 600,不进 git)。
# 部署后需在该机 nginx 加一段(见 relay/README.md「nginx」):
#   location /relay/imgtasks/ { proxy_pass http://127.0.0.1:8790/; proxy_read_timeout 120s; }
set -e
APPDIR=/opt/qfrelay
mkdir -p "$APPDIR"
mv -f /tmp/relay-app.ts "$APPDIR/app.ts"
mv -f /tmp/relay.env "$APPDIR/relay.env"
chmod 600 "$APPDIR/relay.env"
cd "$APPDIR"

echo "=== Bun runtime ==="
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
BUN_BIN="$(command -v bun)"

echo "=== systemd 服务 ==="
cat > /etc/systemd/system/qfrelay.service <<'UNIT'
[Unit]
Description=qfang GPT image async task relay (Bun)
After=network.target
[Service]
EnvironmentFile=/opt/qfrelay/relay.env
WorkingDirectory=/opt/qfrelay
ExecStart=__BUN_BIN__ /opt/qfrelay/app.ts
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
sed -i "s#__BUN_BIN__#$BUN_BIN#g" /etc/systemd/system/qfrelay.service
systemctl daemon-reload
systemctl enable qfrelay >/dev/null 2>&1 || true
systemctl restart qfrelay
sleep 3

echo "=== 服务状态 ==="
systemctl is-active qfrelay || (journalctl -u qfrelay -n 20 --no-pager; exit 1)
echo "=== /healthz ==="
curl -s --max-time 8 http://127.0.0.1:8790/healthz; echo
echo "DEPLOY_DONE"
