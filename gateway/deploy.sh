#!/bin/bash
# 在大陆机 39.106.214.21 上部署网关阀门(零干扰现网:只占 127.0.0.1:8799 + 一个 systemd 服务)。
#
# gw.env(600)除现有 Qwen/MiMo/Fun-ASR/Relay 变量外,DeepSeek V4 Flash 需要:
#   GW_DEEPSEEK_KEY   (真 key,只在本机 gw.env) / GW_DEEPSEEK_BASE(默认 https://api.deepseek.com)
#   GW_DEEPSEEK_MODEL(默认 deepseek-v4-flash) / 可选 GW_DEEPSEEK_MODELS /
#   GW_DEEPSEEK_CONC / GW_DEEPSEEK_USER_CONC / GW_DEEPSEEK_TOKEN_CONC /
#   GW_DEEPSEEK_QUEUE_MAX / GW_DEEPSEEK_QUEUE_MAX_WAIT / GW_DEEPSEEK_RPM
#   GW_IMG_IPM / GW_IMG_QUEUE_MAX / GW_RELAY_SUBMIT_TIMEOUT_MS
#
# 产品默认模型翻转为 deepseek-v4-flash 后(Phase 2C):
#   - 真实短请求爬坡已观察到 DeepSeek 100 人 × 8 窗口的 800 个实际流直入且无网关排队，但尾延迟
#     已明显上升。因此 GW_DEEPSEEK_CONC=800 / GW_DEEPSEEK_USER_CONC=8 /
#     GW_DEEPSEEK_TOKEN_CONC=800 是安全上限而非体验承诺；只留 GW_DEEPSEEK_QUEUE_MAX=200、
#     GW_DEEPSEEK_QUEUE_MAX_WAIT=15 吸收短暂抖动，不把持续超载变成分钟级隐藏等待。2500 是上游
#     账号额度，不等于单机 Bun 网关应直接开到 2500；/healthz(带 app token)会返回
#     active/queued/queueMax/oldestQueueMs 供观察。
#   - 在把线上阈值调高、或将 800 当成长期生产承诺前，必须以真 DeepSeek 账号逐级压测，并同时观察
#     长 SSE/长上下文下的 qfgw CPU、内存、文件描述符、上游 429/5xx 和 p95 首 token 时间。若尾延迟不可接受，应先调低
#     GW_DEEPSEEK_CONC/GW_DEEPSEEK_TOKEN_CONC，而不是放大队列或直接追随 2500 账户额度。
#   - Qwen 仍保守使用 16 实际流。MiMo 的真实短请求爬坡达到 64 槽但高尾延迟明显，不能承诺
#     100 人多窗口无等待。因此固定 GW_MIMO_CONC=64 / GW_MIMO_USER_CONC=1 /
#     GW_MIMO_INFLIGHT_PER_USER=1 / GW_MIMO_TOKEN_CONC=64，只留 GW_MIMO_QUEUE_MAX=64、GW_MIMO_QUEUE_MAX_WAIT=5 的短突发
#     吸收，不把 100 人多窗口变成多分钟的隐藏等待。MiMo 原生文本和图片桥接共用这一个 64 槽总闸；图片桥接只可占其中至多
#     GW_VISION_CONC(12) 个槽并另有 GW_VISION_QUEUE_MAX(24) 的三秒短队列，不能据此宣称能承接 500 张图。
#   - 生图提交默认 GW_IMG_IPM=600，目的是让 100 人 × 5 次的短提交进入 relay 的幂等任务队列；
#     它不是 OpenAI/GPT 生图并发，实际生成并发仍由 relay 控制。首个 burst 后最多只保留
#     GW_IMG_QUEUE_MAX=100 个令牌桶等待者，且单次 relay 提交最多等 GW_RELAY_SUBMIT_TIMEOUT_MS=15000；
#     这样异常跨境连接不会无界占住 socket 或 body。聊天、原生 Messages 与生图提交共用
#     GW_INGRESS_INFLIGHT_BODY_BYTES(256MB，按读入/合并/解码/解析六倍预留)的大陆网关内存闸；
#     GW_IMG_INFLIGHT_BODY_BYTES/GW_CHAT_INFLIGHT_BODY_BYTES 只保留为旧配置兼容别名。生产若调整图片
#     输入大小或机器内存，应一起调整该全局闸，而不是只放大 IPM。
#   - 视觉桥接:带图请求经网关 MiMo 视觉桥接读成文本后再交默认模型 DeepSeek;可选 env(默认见 app.ts loadConfig):
#     GW_VISION_MAX_IMAGES(8) / GW_VISION_MAX_IMAGE_BYTES(8MB) / GW_VISION_MAX_TOTAL_BYTES(24MB,兼作聊天请求体大小闸) /
#     GW_VISION_TIMEOUT_MS(45000) / GW_VISION_CONC(12,视觉在途上限) / GW_VISION_QUEUE_MAX(24,排队硬上限,满则立即 429) /
#     GW_VISION_QUEUE_MAX_WAIT_MS(3000,短等待) / GW_VISION_PER_CLIENT_CONC(1,默认每安装只占 1 个视觉槽，
#     让突发时最多 12 个不同安装公平进入) / GW_VISION_MAX_INFLIGHT_PER_CLIENT(1,含排队也只留一席) /
#     GW_VISION_PER_REQUEST_CONC(2,但会自动夹到前述视觉和 MiMo 的单安装额度；默认实际为 1，避免
#     同一多图请求把自己的后续图片挤成 429) / GW_VISION_CACHE_MAX(512) / GW_VISION_CACHE_TTL_MS(600000)。
#     视觉桥接复用 GW_MIMO_KEY/GW_MIMO_BASE(唯一视觉上游,绝不用 ARK);缺 GW_MIMO_KEY 时带图请求失败关闭 503。
#   - 长聊天/relay 请求在 Bun 层关闭 10 秒空闲超时，但公共请求体仍受
#     GW_INGRESS_BODY_READ_TIMEOUT_MS(30000) 限制，防慢上传长期占住连接和内存。
# 回滚(本脚本不做备份/回滚,需运维在部署前手工执行):
#   部署前备份代码 `cp -a /opt/qfgw /opt/qfgw.bak-<ts>`、gw.env 单独备份 `cp -a /opt/qfgw/gw.env /root/gw.env.bak-<ts>`。
#   部署失败回滚**不能** `cp -a /opt/qfgw.bak-<ts> /opt/qfgw`(/opt/qfgw 已存在,cp -a 会把备份复制成子目录、不覆盖、回滚不生效),
#   正确做法: `rsync -a --delete /opt/qfgw.bak-<ts>/ /opt/qfgw/ && systemctl restart qfgw`(源路径带结尾 `/`)。
#   gw.env 是单文件,`cp -a /root/gw.env.bak-<ts> /opt/qfgw/gw.env` 单文件覆盖安全、不会嵌套。
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
# 一条代理 SSE 通常会同时占用入站和上游出站连接。100 人 × 8 窗口时最多约 800 个
# 入站连接、800 个 DeepSeek 上游流；65536 为日志、健康检查、文件、重试和后续压测预留余量，避免
# 系统默认 soft nofile 在突发时把健康网关误判为上游故障。
LimitNOFILE=65536
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
