#!/bin/bash
# 在大陆机上部署网关阀门(零干扰现网:只占 127.0.0.1:8799 + 一个 systemd 服务)
set -e
APPDIR=/opt/qfgw
mkdir -p "$APPDIR"
mv -f /tmp/app.py "$APPDIR/app.py"
mv -f /tmp/gw.env "$APPDIR/gw.env"
chmod 600 "$APPDIR/gw.env"
cd "$APPDIR"

echo "=== venv + 依赖(精简:fastapi/uvicorn/httpx) ==="
[ -d venv ] || python3 -m venv venv
venv/bin/pip install -q --upgrade pip 2>&1 | tail -1 || true
venv/bin/pip install -q fastapi uvicorn httpx 2>&1 | tail -2

echo "=== systemd 服务 ==="
cat > /etc/systemd/system/qfgw.service <<'UNIT'
[Unit]
Description=qfang AI gateway valve (lean)
After=network.target
[Service]
EnvironmentFile=/opt/qfgw/gw.env
WorkingDirectory=/opt/qfgw
ExecStart=/opt/qfgw/venv/bin/uvicorn app:app --host 127.0.0.1 --port 8799
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
UNIT
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
