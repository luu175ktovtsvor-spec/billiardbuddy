#!/bin/bash
# 在大陆机 39.106.214.21 上部署网关阀门(零干扰现网:只占 127.0.0.1:8799 + 一个 systemd 服务)。
#
# gw.env(600)除现有 Qwen/MiMo/Fun-ASR/Relay 变量外,DeepSeek V4 Flash 需要:
#   GW_DEEPSEEK_KEY   (真 key,只在本机 gw.env) / GW_DEEPSEEK_BASE(默认 https://api.deepseek.com)
#   GW_DEEPSEEK_MODEL(默认 deepseek-v4-flash) / 可选 GW_DEEPSEEK_MODELS / GW_DEEPSEEK_CONC / GW_DEEPSEEK_USER_CONC / GW_DEEPSEEK_RPM
#
# 产品默认模型翻转为 deepseek-v4-flash 后(Phase 2C):
#   - 文字容量放开:GW_*_RPM / GW_*_USER_CONC(Qwen/MiMo/DeepSeek 各自)默认已放开为不节流正常文字流量,
#     仍可在 gw.env 按需收紧,不是硬编码上限。
#   - 视觉桥接:带图请求经网关 MiMo 视觉桥接读成文本后再交默认模型 DeepSeek;可选 env(默认见 app.ts loadConfig):
#     GW_VISION_MAX_IMAGES(8) / GW_VISION_MAX_IMAGE_BYTES(8MB) / GW_VISION_MAX_TOTAL_BYTES(24MB,兼作聊天请求体大小闸) /
#     GW_VISION_TIMEOUT_MS(45000) / GW_VISION_CONC(12,全局在途上限) / GW_VISION_QUEUE_MAX(64,排队硬上限,满则立即 429) /
#     GW_VISION_PER_REQUEST_CONC(2,单请求最多占几个全局槽,防多图请求独占) / GW_VISION_CACHE_MAX(512) / GW_VISION_CACHE_TTL_MS(600000)。
#     视觉桥接复用 GW_MIMO_KEY/GW_MIMO_BASE(唯一视觉上游,绝不用 ARK);缺 GW_MIMO_KEY 时带图请求失败关闭 503。
#
# 回滚(本脚本不做备份/回滚,需运维在部署前手工执行):
#   部署前备份代码 `cp -a /opt/qfgw /opt/qfgw.bak-<ts>`、gw.env 单独备份 `cp -a /opt/qfgw/gw.env /root/gw.env.bak-<ts>`。
#   部署失败回滚**不能** `cp -a /opt/qfgw.bak-<ts> /opt/qfgw`(/opt/qfgw 已存在,cp -a 会把备份复制成子目录、不覆盖、回滚不生效),
#   正确做法: `rsync -a --delete /opt/qfgw.bak-<ts>/ /opt/qfgw/ && systemctl restart qfgw`(源路径带结尾 `/`)。
#   gw.env 是单文件,`cp -a /root/gw.env.bak-<ts> /opt/qfgw/gw.env` 单文件覆盖安全、不会嵌套。详见 docs/网关多模型与Agent内核接轨.md。
set -euo pipefail
APPDIR=/opt/qfgw
for source in app.ts qwenChat.ts mimoChat.ts deepseekChat.ts modelCapacity.ts visionBridge.ts transcription.ts; do
  [ -f "/tmp/$source" ] || { echo "缺少 /tmp/$source" >&2; exit 1; }
done
mkdir -p "$APPDIR"
install -m 644 /tmp/app.ts "$APPDIR/app.ts"
install -m 644 /tmp/qwenChat.ts "$APPDIR/qwenChat.ts"
install -m 644 /tmp/mimoChat.ts "$APPDIR/mimoChat.ts"  # 显式可路由的 MiMo 上游
install -m 644 /tmp/deepseekChat.ts "$APPDIR/deepseekChat.ts"  # 显式可路由的 DeepSeek V4 Flash 上游
install -m 644 /tmp/modelCapacity.ts "$APPDIR/modelCapacity.ts"
install -m 644 /tmp/visionBridge.ts "$APPDIR/visionBridge.ts"  # DeepSeek 带图时的 MiMo 视觉桥接
install -m 644 /tmp/transcription.ts "$APPDIR/transcription.ts"
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
