#!/bin/bash
# 在【美国服务器 47.77.237.250】(与 OpenAI 同区)部署 GPT 生图异步任务服务(relay/app.ts)。
# 只占 127.0.0.1:8790 + 一个 systemd 服务;真 OpenAI key 只放本机 relay.env(chmod 600,不进 git)。
#
# relay.env 需要的变量(私测版加固):
#   RELAY_TOKEN            # = 大陆网关注入的 GW_RELAY_TOKEN
#   RELAY_OPENAI_KEY       # 真 OpenAI key,只在本机
#   RELAY_OPENAI_BASE      # 默认 https://api.openai.com/v1
#   RELAY_DB=/opt/qfrelay/relay.db          # SQLite 持久化(重启恢复必须落盘,别用 :memory:)
#   RELAY_BLOB_DIR=/opt/qfrelay/blobs       # 大体积输入/结果 blob(700 目录,应用会自建)
#   RELAY_QUEUE_MAX RELAY_USER_MAX RELAY_IMG_CONC RELAY_MAX_BODY_BYTES RELAY_TASK_TTL_MS  # 队列上限,可选
#
# 部署后需在该机 nginx 暴露受保护路径,且【仅允许大陆 qfgw 出口 IP + 保留 Bearer】,客户端不得直连:
#   location /relay/imgtasks/ {
#     allow <大陆 qfgw 出口 IP>;    # 只放行大陆网关,例如 39.106.214.21
#     deny all;
#     proxy_pass http://127.0.0.1:8790/;
#     proxy_read_timeout 120s;
#   }
set -e
APPDIR=/opt/qfrelay
mkdir -p "$APPDIR"
mv -f /tmp/relay-app.ts "$APPDIR/app.ts"
mv -f /tmp/relay.env "$APPDIR/relay.env"
chmod 600 "$APPDIR/relay.env"
# blob 目录(700):应用启动也会自建,这里预建保证属主与权限正确。
mkdir -p "$APPDIR/blobs"
chmod 700 "$APPDIR/blobs"
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
