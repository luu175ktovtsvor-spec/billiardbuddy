#!/bin/bash
# 在【美国服务器 47.77.237.250】(与 OpenAI 同区)部署 GPT 生图异步任务服务(relay/app.ts)。
# 只占 127.0.0.1:8790 + 一个 systemd 服务;真 OpenAI key 只放本机 relay.env(chmod 600,不进 git)。
#
# relay.env 需要的变量(私测版加固):
#   RELAY_TOKEN            # = 大陆网关注入的 GW_RELAY_TOKEN
#   RELAY_OPENAI_KEY       # 真 OpenAI key,只在本机
#   RELAY_OPENAI_BASE      # 默认 https://api.openai.com/v1
#   RELAY_DB=/opt/qfrelay/relay.db          # 100 用户生产部署必须配置；SQLite 持久化(重启恢复不能用 :memory:)
#   RELAY_BLOB_DIR=/opt/qfrelay/blobs       # 100 用户生产部署必须配置；大体积输入/结果 blob(700 目录,应用会自建)
#   RELAY_QUEUE_MAX=1200 RELAY_USER_MAX=10 RELAY_IMG_CONC=6 RELAY_IMG_USER_CONC=1 RELAY_RETRY_AFTER_SECONDS=30  # 100×10 小任务可入队；一个 owner 不占满六个真实生图槽
#   RELAY_ACTIVE_INPUT_BYTES_MAX=536870912 RELAY_PENDING_INPUT_BYTES_MAX=67108864  # 落盘队列总输入预算 + 上传阶段 JS 堆预算
#   RELAY_MAX_BODY_BYTES RELAY_TASK_TTL_MS  # 单请求大小与结果留存,可选；结果默认留 7 天，磁盘需按实际图片体积监控
#
# 部署后需在该机 nginx 暴露受保护路径,且【仅允许大陆 qfgw 出口 IP + 保留 Bearer】,客户端不得直连:
#   location /relay/imgtasks/ {
#     allow <大陆 qfgw 出口 IP>;    # 只放行大陆网关,例如 39.106.214.21
#     deny all;
#     client_max_body_size 32m;    # 与 RELAY_MAX_BODY_BYTES 对齐，避免 nginx 默认 1m 先行拒绝改图
#     proxy_request_buffering off; # 流式交给 relay 的活跃输入预算，不让 nginx 先攒满大请求
#     proxy_pass http://127.0.0.1:8790/;
#     proxy_read_timeout 120s;
#   }
set -e
APPDIR=/opt/qfrelay
[ -f /tmp/relay-app.ts ] || { echo "缺少 /tmp/relay-app.ts" >&2; exit 1; }
mkdir -p "$APPDIR"
install -m 644 /tmp/relay-app.ts "$APPDIR/app.ts" && rm -f /tmp/relay-app.ts
# 只在显式提供 /tmp/relay.env 时才覆盖现网 relay.env;否则保留现网凭据(真 OpenAI key 不被清空)。
# 更新代码时必须先 `rm -f /tmp/relay.env`,与 gateway/deploy.sh 对 gw.env 的处理一致。
if [ -f /tmp/relay.env ]; then
  install -m 600 /tmp/relay.env "$APPDIR/relay.env.new"
  mv -f "$APPDIR/relay.env.new" "$APPDIR/relay.env"
  rm -f /tmp/relay.env
elif [ ! -f "$APPDIR/relay.env" ]; then
  echo "缺少 /tmp/relay.env,且现网不存在 $APPDIR/relay.env" >&2
  exit 1
fi
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
LimitNOFILE=65536
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
