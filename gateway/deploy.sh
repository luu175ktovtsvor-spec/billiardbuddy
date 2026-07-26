#!/bin/bash
# 在大陆机 39.106.214.21 上部署唯一的 BilliardBuddy Gateway。
#
# gw.env(600)保存启动授权、MiMo、DeepSeek、Fun-ASR 与 Relay 配置。DeepSeek V4 Flash 需要:
#   GW_DEEPSEEK_KEY   (真 key,只在本机 gw.env) / GW_DEEPSEEK_BASE(默认 https://api.deepseek.com)
#   GW_DEEPSEEK_CONC / GW_DEEPSEEK_USER_CONC / GW_DEEPSEEK_TOKEN_CONC /
#   GW_DEEPSEEK_QUEUE_MAX / GW_DEEPSEEK_QUEUE_MAX_WAIT / GW_DEEPSEEK_RPM
#   GW_IMG_IPM / GW_IMG_QUEUE_MAX / GW_RELAY_SUBMIT_TIMEOUT_MS / GW_RELAY_RESULT_TIMEOUT_MS=300000 / GW_SERVER_IDLE_TIMEOUT_SECONDS
#   GW_TRANSCRIBE_RPM / GW_TRANSCRIBE_CONC / GW_TRANSCRIBE_QUEUE_MAX
#
# 产品默认模型翻转为 deepseek-v4-flash 后(Phase 2C):
#   - 受控假上游压测已验证网关能公平调度 DeepSeek 100 人 × 10 窗口的 1,000 个请求而不在网关排队；
#     这不是 1,000 路真实上游流的性能证明。因此 GW_DEEPSEEK_CONC=1000 / GW_DEEPSEEK_USER_CONC=10 /
#     GW_DEEPSEEK_TOKEN_CONC=1000 只是待逐级线上验证的安全上限，不是体验承诺；只留
#     GW_DEEPSEEK_QUEUE_MAX=200、GW_DEEPSEEK_QUEUE_MAX_WAIT=15 吸收短暂抖动，不把持续超载变成
#     分钟级隐藏等待。2500 是上游账号额度，不等于单机 Bun 网关应直接开到 2500；/healthz
#     会返回 active/queued/queueMax/oldestQueueMs 供观察。
#   - 在把线上阈值调高、或将 1,000 当成长期生产承诺前，必须以真 DeepSeek 账号逐级压测，并同时观察
#     长 SSE/长上下文下的 billiardbuddy-gateway CPU、内存、文件描述符、上游 429/5xx 和 p95 首 token 时间。若尾延迟不可接受，应先调低
#     GW_DEEPSEEK_CONC/GW_DEEPSEEK_TOKEN_CONC，而不是放大队列或直接追随 2500 账户额度。
#   - MiMo 尚无可复现的高并发真实上游验收，不能承诺 100 人多窗口无等待。因此先固定
#     GW_MIMO_CONC=64（当前账号级物理总上限）/
#     GW_MIMO_MEDIA_CONC=48（图片/视频工作台 MediaReasoning 槽）/
#     GW_VISION_CONC=16（DeepSeek→MiMo 图片桥接槽）的视觉优先硬预留，48 + 16 = 64。原生路径不能借用
#     视觉的 16 槽，视觉也不会在 64 条原生请求之后排队；任一数值调整时必须同时校验三者之和等于
#     GW_MIMO_CONC。另固定 GW_MIMO_USER_CONC=1 / GW_MIMO_INFLIGHT_PER_USER=1 /
#     GW_MIMO_TOKEN_CONC=64，只留 GW_MIMO_QUEUE_MAX=64、GW_MIMO_QUEUE_MAX_WAIT=5 的短突发吸收，
#     不把 100 人多窗口变成多分钟的隐藏等待。视觉侧另有 GW_VISION_QUEUE_MAX=48 的三秒短队列，
#     不能据此宣称能承接 500 张图。
#   - 生图提交默认 GW_IMG_IPM=1200，目的是让 100 人 × 10 次的小请求进入 relay 的幂等任务队列；
#     它不是 OpenAI/GPT 生图并发，实际生成并发仍由 relay 控制。首个 burst 后最多只保留
#     GW_IMG_QUEUE_MAX=200 个令牌桶等待者，且单次 relay 提交最多等 GW_RELAY_SUBMIT_TIMEOUT_MS=15000；
#     这样异常跨境连接不会无界占住 socket 或 body。聊天、原生 Messages 与生图提交共用
#     GW_INGRESS_INFLIGHT_BODY_BYTES(256MB，按读入/合并/解码/解析六倍预留)的大陆网关内存闸；
#     GW_IMG_INFLIGHT_BODY_BYTES/GW_CHAT_INFLIGHT_BODY_BYTES 只保留为旧配置兼容别名。生产若调整图片
#     输入大小或机器内存，应一起调整该全局闸，而不是只放大 IPM。
#   - 生图最终状态可能携带完整 Base64 图片；GW_RELAY_RESULT_TIMEOUT_MS 默认且生产最低为 300000，
#     覆盖大陆网关从美国 relay 接收响应头和完整正文的全过程。图片一旦可用会立即返回，不会固定等待五分钟。
#   - 视觉桥接:带图请求经网关 MiMo 视觉桥接读成文本后再交默认模型 DeepSeek;可选 env(默认见 app.ts loadConfig):
#     GW_VISION_MAX_IMAGES(8) / GW_VISION_MAX_IMAGE_BYTES(8MB) / GW_VISION_MAX_TOTAL_BYTES(24MB,兼作聊天请求体大小闸) /
#     GW_VISION_TIMEOUT_MS(45000) / GW_VISION_CONC(16,视觉在途上限) / GW_VISION_QUEUE_MAX(48,排队硬上限,满则立即 429) /
#     GW_VISION_QUEUE_MAX_WAIT_MS(3000,短等待) / GW_VISION_PER_CLIENT_CONC(1,默认每安装只占 1 个视觉槽，
#     让突发时最多 16 个不同安装公平进入) / GW_VISION_MAX_INFLIGHT_PER_CLIENT(1,含排队也只留一席) /
#     GW_VISION_PER_REQUEST_CONC(2,但会自动夹到前述视觉和 MiMo 的单安装额度；默认实际为 1，避免
#     同一多图请求把自己的后续图片挤成 429) / GW_VISION_CACHE_MAX(512) / GW_VISION_CACHE_TTL_MS(600000)。
#     视觉桥接复用 GW_MIMO_KEY/GW_MIMO_BASE(唯一视觉上游,绝不用 ARK);缺 GW_MIMO_KEY 时带图请求失败关闭 503。
#   - 长聊天/relay 请求在 Bun 层关闭 10 秒空闲超时，但公共请求体仍受
#     普通 JSON 请求仍由 GW_INGRESS_BODY_READ_TIMEOUT_MS(30000) 限制；带完整底图的已鉴权改图上传
#     使用独立 GW_IMG_TASK_BODY_READ_TIMEOUT_MS(默认 180000)，同时继续受 32MB 单请求与 256MB 全局
#     在途内存预算约束，避免把普通聊天的短慢上传窗口错误套到大图提交。
#   - Bun 服务级 idleTimeout 默认显式设为 255 秒（可用 GW_SERVER_IDLE_TIMEOUT_SECONDS 调整，范围
#     30–255；Bun 的硬上限为 255）。长流 handler 仍会对具体请求调用 timeout(..., 0)，因此 US /gw
#     代理的 300 秒窗口可以保留为外层连接窗口。
# 回滚(本脚本不做备份/回滚,需运维在部署前手工执行):
#   部署前备份代码 `cp -a /opt/billiardbuddy-gateway /opt/billiardbuddy-gateway.bak-<ts>`、gw.env 单独备份 `cp -a /opt/billiardbuddy-gateway/gw.env /root/gw.env.bak-<ts>`。
#   部署失败回滚**不能** `cp -a /opt/billiardbuddy-gateway.bak-<ts> /opt/billiardbuddy-gateway`(/opt/billiardbuddy-gateway 已存在,cp -a 会把备份复制成子目录、不覆盖、回滚不生效),
#   正确做法: `rsync -a --delete /opt/billiardbuddy-gateway.bak-<ts>/ /opt/billiardbuddy-gateway/ && systemctl restart billiardbuddy-gateway`(源路径带结尾 `/`)。
#   gw.env 是单文件,`cp -a /root/gw.env.bak-<ts> /opt/billiardbuddy-gateway/gw.env` 单文件覆盖安全、不会嵌套。
set -euo pipefail
APPDIR=/opt/billiardbuddy-gateway
for source in app.ts authority.ts mimoChat.ts deepseekChat.ts modelCapacity.ts visionBridge.ts transcription.ts usageBudget.ts providerRegistry.ts validate-auth-env.ts validate-mimo-capacity-env.sh validate-production-capacity-env.sh; do
  [ -f "/tmp/$source" ] || { echo "缺少 /tmp/$source" >&2; exit 1; }
done
mkdir -p "$APPDIR"
chmod 700 "$APPDIR"
install -m 644 /tmp/app.ts "$APPDIR/app.ts"
mkdir -p "$APPDIR/auth"
# authority.ts is uploaded from ts/shared/product/authEntitlement.ts so the
# deployed gateway has no repository-relative runtime dependency.
install -m 644 /tmp/authority.ts "$APPDIR/auth/authority.ts"
install -m 644 /tmp/mimoChat.ts "$APPDIR/mimoChat.ts"  # 显式可路由的 MiMo 上游
install -m 644 /tmp/deepseekChat.ts "$APPDIR/deepseekChat.ts"  # 显式可路由的 DeepSeek V4 Flash 上游
install -m 644 /tmp/modelCapacity.ts "$APPDIR/modelCapacity.ts"
install -m 644 /tmp/visionBridge.ts "$APPDIR/visionBridge.ts"  # DeepSeek 带图时的 MiMo 视觉桥接
install -m 644 /tmp/transcription.ts "$APPDIR/transcription.ts"
install -m 644 /tmp/usageBudget.ts "$APPDIR/usageBudget.ts"
install -m 644 /tmp/providerRegistry.ts "$APPDIR/providerRegistry.ts"
install -m 644 /tmp/validate-auth-env.ts "$APPDIR/validate-auth-env.ts"
# Retired provider/search modules are not part of the deployed runtime closure.
rm -f "$APPDIR/qwenChat.ts" "$APPDIR/webSearch.ts"
install -m 755 /tmp/validate-mimo-capacity-env.sh "$APPDIR/validate-mimo-capacity-env.sh"
install -m 755 /tmp/validate-production-capacity-env.sh "$APPDIR/validate-production-capacity-env.sh"
# Upload the controlled load-test closure as one unit. Every simulated
# installation must use its own signed token, loaded by loadtestCredentials.ts;
# installing only part of this closure would leave an operator tool that cannot run.
loadtest_sources=(loadtestCredentials.ts real-loadtest.ts vision-real-loadtest.ts image-real-loadtest.ts mimo-mixed-real-loadtest.ts)
loadtest_upload=0
for runner in "${loadtest_sources[@]}"; do
  [ ! -f "/tmp/$runner" ] || loadtest_upload=1
done
if [ "$loadtest_upload" -eq 1 ]; then
  for runner in "${loadtest_sources[@]}"; do
    [ -f "/tmp/$runner" ] || { echo "受控压测工具必须整组上传，缺少 /tmp/$runner" >&2; exit 1; }
    install -m 644 "/tmp/$runner" "$APPDIR/$runner"
  done
else
  echo "此次未上传受控压测工具；保留现有工具版本" >&2
fi
if [ -f /tmp/gw.env ]; then
  install -m 600 /tmp/gw.env "$APPDIR/gw.env.new"
  mv -f "$APPDIR/gw.env.new" "$APPDIR/gw.env"
elif [ ! -f "$APPDIR/gw.env" ] && [ -f /opt/qfgw/gw.env ]; then
  # One-time product-name migration. Copy as data without sourcing or printing
  # credentials; the complete authorization validator runs before either service changes.
  install -m 600 /opt/qfgw/gw.env "$APPDIR/gw.env"
elif [ ! -f "$APPDIR/gw.env" ]; then
  echo "缺少 /tmp/gw.env，且现网不存在 $APPDIR/gw.env" >&2
  exit 1
fi

# qfgw 是已经退役的产品名。只改写明确的本机状态字段，不触碰凭据或远端 URL。
gateway_env_migration="$(mktemp "$APPDIR/gw.env.migration.XXXXXX")"
awk '
  /^[[:space:]]*(GW_DB|GW_AUTHORITY_FILE)[[:space:]]*=/ {
    sub("/opt/qfgw", "/opt/billiardbuddy-gateway")
  }
  { print }
' "$APPDIR/gw.env" > "$gateway_env_migration"
install -m 600 "$gateway_env_migration" "$APPDIR/gw.env"
rm -f -- "$gateway_env_migration"

# 只在三项均缺失的新环境补入非敏感默认值。不能对旧的低容量 gw.env 单独塞入 48/16，
# 否则会让原本有效的 GW_MIMO_CONC=16 变成不一致配置。已有总量由 app.ts 兼容推导；
# 新的显式配置必须满足总 64 = 原生 48 + 视觉 16（或三项严格相等的其他分区）。
if ! grep -Eq '^[[:space:]]*GW_MIMO_CONC=' "$APPDIR/gw.env" \
  && ! grep -Eq '^[[:space:]]*GW_MIMO_MEDIA_CONC=' "$APPDIR/gw.env" \
  && ! grep -Eq '^[[:space:]]*GW_VISION_CONC=' "$APPDIR/gw.env"; then
  printf '\nGW_MIMO_CONC=64\nGW_MIMO_MEDIA_CONC=48\nGW_VISION_CONC=16\n' >> "$APPDIR/gw.env"
fi

# Fail before touching systemd if an operator supplied a partial or inconsistent
# reservation. This script reads only the three non-secret capacity settings and never
# sources gw.env, so bootstrap credentials and provider credentials cannot be executed or printed.
"$APPDIR/validate-mimo-capacity-env.sh" "$APPDIR/gw.env"
"$APPDIR/validate-production-capacity-env.sh" "$APPDIR/gw.env"

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

# Validate the complete authorization input before replacing a healthy process.
# The validator reads the EnvironmentFile as data and never prints credentials.
"$BUN_BIN" "$APPDIR/validate-auth-env.ts" "$APPDIR/gw.env"

echo "=== systemd 服务 ==="
if systemctl is-active --quiet qfgw 2>/dev/null; then
  systemctl stop qfgw
fi
for state_file in authority.json usage.db usage.db-shm usage.db-wal; do
  if [ -f "/opt/qfgw/$state_file" ] && [ ! -e "$APPDIR/$state_file" ]; then
    cp -a "/opt/qfgw/$state_file" "$APPDIR/$state_file"
  fi
done
cat > /etc/systemd/system/billiardbuddy-gateway.service <<'UNIT'
[Unit]
Description=BilliardBuddy AI gateway valve (Bun)
After=network.target
[Service]
EnvironmentFile=/opt/billiardbuddy-gateway/gw.env
WorkingDirectory=/opt/billiardbuddy-gateway
ExecStart=__BUN_BIN__ /opt/billiardbuddy-gateway/app.ts --host 127.0.0.1 --port 8799
Restart=always
RestartSec=2
# 一条代理 SSE 通常会同时占用入站和上游出站连接。100 人 × 10 窗口时最多约 1,000 个
# 入站连接、1,000 个 DeepSeek 上游流；65536 为日志、健康检查、文件、重试和后续压测预留余量，避免
# 系统默认 soft nofile 在突发时把健康网关误判为上游故障。
LimitNOFILE=65536
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
sed -i "s#__BUN_BIN__#$BUN_BIN#g" /etc/systemd/system/billiardbuddy-gateway.service
systemctl daemon-reload
systemctl enable billiardbuddy-gateway >/dev/null 2>&1 || true
systemctl restart billiardbuddy-gateway
sleep 3

echo "=== 服务状态 ==="
systemctl is-active billiardbuddy-gateway || (journalctl -u billiardbuddy-gateway -n 20 --no-pager; exit 1)
echo "=== /healthz ==="
health_json="$(curl -fsS --max-time 8 http://127.0.0.1:8799/healthz)"
HEALTH_JSON="$health_json" "$BUN_BIN" -e 'const value=JSON.parse(process.env.HEALTH_JSON??"{}");if(value.component_manifest?.component!=="billiardbuddy-gateway"||value.component_manifest?.protocol!=="bb-provider-gateway/1.0"||value.component_manifest?.relay_protocol!=="bb-provider-gateway/1.0")throw new Error("billiardbuddy-gateway component manifest incompatible")'
echo "$health_json"
chmod 600 "$APPDIR"/usage.db* 2>/dev/null || true
systemctl disable qfgw >/dev/null 2>&1 || true
rm -f /etc/systemd/system/qfgw.service
systemctl daemon-reload
if [ -d /opt/qfgw ]; then
  rm -rf /opt/qfgw
fi
echo "=== 内存占用 ==="
free -h | head -2
echo "DEPLOY_DONE"
