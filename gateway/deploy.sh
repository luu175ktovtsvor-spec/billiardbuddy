#!/bin/bash
# 在大陆机上部署网关阀门(零干扰现网:只占 127.0.0.1:8799 + 一个 systemd 服务)
set -e
APPDIR=/opt/qfgw
mkdir -p "$APPDIR"
mv -f /tmp/app.ts "$APPDIR/app.ts"
mv -f /tmp/gw.env "$APPDIR/gw.env"
chmod 600 "$APPDIR/gw.env"
cd "$APPDIR"

echo "=== Bun runtime ==="
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
BUN_BIN="$(command -v bun)"

echo "=== systemd 服务 ==="
cat > /etc/systemd/system/qfgw.service <<'UNIT'
[Unit]
Description=qfang AI gateway valve (Bun)
After=network.target
[Service]
EnvironmentFile=/opt/qfgw/gw.env
WorkingDirectory=/opt/qfgw
ExecStart=__BUN_BIN__ /opt/qfgw/app.ts --host 127.0.0.1 --port 8799
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
sed -i "s#__BUN_BIN__#$BUN_BIN#g" /etc/systemd/system/qfgw.service
systemctl daemon-reload
systemctl enable qfgw >/dev/null 2>&1 || true
systemctl restart qfgw
sleep 3

echo "=== 服务状态 ==="
systemctl is-active qfgw || (journalctl -u qfgw -n 20 --no-pager; exit 1)
echo "=== /healthz ==="
curl -s --max-time 8 http://127.0.0.1:8799/healthz; echo
echo "=== 内存占用 ==="
free -h | head -2
echo "DEPLOY_DONE"
