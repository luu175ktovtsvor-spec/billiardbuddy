#!/bin/bash
# 在大陆机上部署网关阀门(零干扰现网:只占 127.0.0.1:8799 + 一个 systemd 服务)
set -euo pipefail
APPDIR=/opt/qfgw
for source in app.ts qwenChat.ts mimoChat.ts modelCapacity.ts transcription.ts webSearch.ts; do
  [ -f "/tmp/$source" ] || { echo "缺少 /tmp/$source" >&2; exit 1; }
done
mkdir -p "$APPDIR"
install -m 644 /tmp/app.ts "$APPDIR/app.ts"
install -m 644 /tmp/qwenChat.ts "$APPDIR/qwenChat.ts"
install -m 644 /tmp/mimoChat.ts "$APPDIR/mimoChat.ts"  # 双模型路由:MiMo 作为可显式路由的第二上游
install -m 644 /tmp/modelCapacity.ts "$APPDIR/modelCapacity.ts"
install -m 644 /tmp/transcription.ts "$APPDIR/transcription.ts"
install -m 644 /tmp/webSearch.ts "$APPDIR/webSearch.ts"
if [ -f /tmp/gw.env ]; then
  install -m 600 /tmp/gw.env "$APPDIR/gw.env.new"
  mv -f "$APPDIR/gw.env.new" "$APPDIR/gw.env"
elif [ ! -f "$APPDIR/gw.env" ]; then
  echo "缺少 /tmp/gw.env，且现网不存在 $APPDIR/gw.env" >&2
  exit 1
fi
chmod 600 "$APPDIR/gw.env"
cd "$APPDIR"

echo "=== Bun runtime ==="
if command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_BIN="$HOME/.bun/bin/bun"
else
  curl -fsSL https://bun.sh/install | bash
  BUN_BIN="$HOME/.bun/bin/bun"
fi
[ -x "$BUN_BIN" ] || { echo "Bun 安装失败" >&2; exit 1; }

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
UMask=0077
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
curl -fsS --max-time 8 http://127.0.0.1:8799/healthz; echo
chmod 600 "$APPDIR"/usage.db* 2>/dev/null || true
echo "=== 内存占用 ==="
free -h | head -2
echo "DEPLOY_DONE"
