# BilliardBuddy 生产服务器

> **现网身份待复核（2026-08-02）**：本机对大陆 Gateway `39.106.214.21` 的 SSH
> 严格校验发现其 ED25519 主机指纹已与已固定记录不一致。因此，在云厂商控制台或
> 其他带外渠道确认主机身份前，禁止使用 `accept-new`、删除 known_hosts 记录或登录
> 该主机。本文件以下内容是 2026-07-27 的最后一次已验证部署状态，不得视为当前
> 运行事实；完成身份复核、只读盘点和正式部署验证后，必须整体更新本文件。

最后一次实测更新时间：2026-07-27。

## 上次已验证的拓扑

```text
桌面端
  → https://zzyppz.cn/gw/
  → 美国 Nginx :443
  → OpenSSH 本地转发 127.0.0.1:8800
  → 大陆 billiardbuddy-gateway 127.0.0.1:8799

大陆 billiardbuddy-gateway ImageGeneration
  → https://zzyppz.cn/relay/imgtasks/
  → 美国 Nginx（仅允许大陆出口 IP 与本机）
  → billiardbuddy-relay 127.0.0.1:8790
```

## 大陆 Gateway

- 主机：`39.106.214.21`
- systemd：`billiardbuddy-gateway.service`，已启用并为 `active`
- 运行目录：`/opt/billiardbuddy-gateway`
- 进程：`/root/.bun/bin/bun /opt/billiardbuddy-gateway/app.ts --host 127.0.0.1 --port 8799`
- 监听：仅 `127.0.0.1:8799`
- Nginx：公网 `:80`，只提供静态资产/ACME；`/healthz` 实测 404，不暴露 Gateway
- 权威/用量：`authority.json`、`usage.db*`，权限 `0600`
- 协议：`bb-provider-gateway/1.0`
- 当前能力泳道：
  - `TextReasoning`：DeepSeek `deepseek-v4-flash`
  - `VisualEvidence`：MiMo `mimo-v2.5`
  - `MediaReasoning`：MiMo `mimo-v2.5`
  - `SpeechTranscription`：Fun-ASR
  - `ImageGeneration`：转发美国 Relay
- MiMo 实际配置：总并发 64，MediaReasoning 48，VisualEvidence 16。
- 7 月 27 日的部署曾确认 `/opt/billiardbuddy-gateway/qwenChat.ts` 与 `/opt/billiardbuddy-gateway/webSearch.ts` 不存在；此后源码已移除 Agent 的 `/v1/messages` 路由，目标运行时只接受受管 `/v1/responses`。该变更尚未在身份待复核的服务器上验证。
- 旧 `/opt/qfgw`、`qfgw.service` 与 `qfgw-tunnel` 系统账户已在状态迁移和新服务健康检查后删除。

当前源码的 Gateway 环境变量名称（只记录名称，不记录值；不是现网已核验配置）：

```text
BB_GATEWAY_MODEL
GW_ADMIN_TOKEN
GW_AUTH_SIGNING_KEY
GW_BOOTSTRAP_RPM
GW_CHAT_INFLIGHT_BODY_BYTES
GW_DB
GW_DEEPSEEK_BASE
GW_DEEPSEEK_CONC
GW_DEEPSEEK_KEY
GW_DEEPSEEK_MAX_RETRIES
GW_DEEPSEEK_QUEUE_MAX
GW_DEEPSEEK_QUEUE_MAX_WAIT
GW_DEEPSEEK_RETRY_BASE_MS
GW_DEEPSEEK_RETRY_MAX_MS
GW_DEEPSEEK_RPM
GW_DEEPSEEK_TOKEN_CONC
GW_DEEPSEEK_USER_CONC
GW_FUNASR_KEY
GW_FUNASR_MODEL
GW_FUNASR_URL
GW_IMG_INFLIGHT_BODY_BYTES
GW_IMG_IPM
GW_IMG_QUEUE_MAX
GW_IMG_TASK_BODY_READ_TIMEOUT_MS
GW_IMG_TASK_MAX_BODY_BYTES
GW_INGRESS_BODY_READ_TIMEOUT_MS
GW_INGRESS_INFLIGHT_BODY_BYTES
GW_MIMO_BASE
GW_MIMO_CONC
GW_MIMO_INFLIGHT_PER_USER
GW_MIMO_KEY
GW_MIMO_MAX_RETRIES
GW_MIMO_MEDIA_CONC
GW_MIMO_MODEL
GW_MIMO_QUEUE_MAX
GW_MIMO_QUEUE_MAX_WAIT
GW_MIMO_RETRY_BASE_MS
GW_MIMO_RETRY_MAX_MS
GW_MIMO_RPM
GW_MIMO_TOKEN_CONC
GW_MIMO_USER_CONC
GW_QUEUE_MAX_WAIT
GW_RELAY_RESULT_MAX_BYTES
GW_RELAY_RESULT_TIMEOUT_MS
GW_RELAY_SUBMIT_TIMEOUT_MS
GW_RELAY_TASKS_BASE
GW_RELAY_TOKEN
GW_SERVER_IDLE_TIMEOUT_SECONDS
GW_TRANSCRIBE_CONC
GW_TRANSCRIBE_MAX_BYTES
GW_TRANSCRIBE_PROVIDER
GW_TRANSCRIBE_QUEUE_MAX
GW_TRANSCRIBE_RPM
GW_TRANSCRIBE_TIMEOUT_MS
GW_VISION_CACHE_MAX
GW_VISION_CACHE_TTL_MS
GW_VISION_CONC
GW_VISION_MAX_IMAGES
GW_VISION_MAX_IMAGE_BYTES
GW_VISION_MAX_INFLIGHT_PER_CLIENT
GW_VISION_MAX_TOTAL_BYTES
GW_VISION_PER_CLIENT_CONC
GW_VISION_PER_REQUEST_CONC
GW_VISION_QUEUE_MAX
GW_VISION_QUEUE_MAX_WAIT_MS
```

上次部署曾显式设置 `GW_MIMO_MEDIA_CONC=48`；旧名称 `GW_MIMO_NATIVE_CONC` 已删除。重新部署前，`validate-deployment-env.js` 会先验证鉴权、数据库、上游端点及各能力密钥均存在；容量分区再由两个 shell 校验器检查。

## 美国 Relay 与 TLS 入口

- 主机：`47.77.237.250`
- systemd：`billiardbuddy-relay.service`、`billiardbuddy-gateway-tunnel.service`、`nginx.service`，均为 `active`
- Relay 运行目录：`/opt/billiardbuddy-relay`
- Relay 进程：`/root/.bun/bin/bun /opt/billiardbuddy-relay/app.ts`
- Relay 监听：仅 `127.0.0.1:8790`
- Gateway 隧道监听：`127.0.0.1:8800` → 大陆 `127.0.0.1:8799`
- Gateway 隧道账户与凭据目录：大陆 `billiardbuddy-gateway-tunnel`、美国 `/etc/billiardbuddy-gateway-tunnel`。
- Nginx：公网 `:80/:443`
- Gateway 公网入口：`https://zzyppz.cn/gw/`
- Relay 内部入口：`https://zzyppz.cn/relay/imgtasks/`
- Relay ACL：仅允许 `39.106.214.21` 与 `127.0.0.1`，外部实测 403
- 持久状态：`relay.db*` 权限 `0600`，`blobs/` 权限 `0700`
- 当前健康值：queue 2000、单 owner 20、GPT Image 并发 16/单 owner 2、Seedream 已配置且并发 6/单 owner 1、输入预算 512 MiB。
- 旧 `/opt/qfrelay`、`qfrelay.service`、`qfgw-tunnel.service` 与 `qfgw-us-https-proxy.conf` 已删除；站点只加载当前 `billiardbuddy-gateway-us-https-proxy.conf`。

Relay 环境变量名称：

```text
RELAY_ARK_KEY
RELAY_BLOB_DIR
RELAY_DB
RELAY_IMG_CONC
RELAY_IMG_USER_CONC
RELAY_OPENAI_BASE
RELAY_OPENAI_KEY
RELAY_PORT
RELAY_QUEUE_MAX
RELAY_TASK_TTL_MS
RELAY_TOKEN
RELAY_UPSTREAM_TIMEOUT_MS
RELAY_USER_MAX
```

## 部署与验证

- Relay：上传 `relay/app.ts`、`relay/validate-production-env.sh`、`relay/deploy.sh` 后执行部署脚本。
- Gateway：在受控构建机执行 `gateway/package-deployment.sh <空目录>`；只上传生成的 `app.js`、`validate-deployment-env.js`、两个容量校验脚本和 `deploy.sh`，再执行部署脚本。`app.js` 是完整运行闭包，服务器不得依赖遗留 TypeScript 模块或仓库相对路径。
- 两个部署脚本都迁移已有凭据与持久状态，改写本机旧状态路径，校验非敏感容量配置，切换到唯一的当前 systemd 服务，并在新 `/healthz` 通过后删除旧目录与 unit。

本次实测：

- `https://zzyppz.cn/gw/healthz`：200，Gateway/Relay 协议均为 `bb-provider-gateway/1.0`
- 外部访问 `https://zzyppz.cn/relay/imgtasks/healthz`：403
- 美国本机经 Nginx 访问 Relay health：200
- 大陆公网 `http://39.106.214.21/healthz`：404
- 两台服务器相关 systemd 服务均为 `active`
- Gateway 运行闭包在部署前通过授权、`64 = 48 + 16` MiMo 硬分区和 1000-window 配置预检；部署后 `/opt/billiardbuddy-gateway/app.ts` 与仓库 SHA-256 同为 `6b732cf147b82758c3cc2c58a559a30e0744d47ef02f863b22824d14b48cb051`。
- Relay 未发生源码漂移；`/opt/billiardbuddy-relay/app.ts` 与仓库 SHA-256 同为 `9593d9da9d29e9a98d7e99f1bce23d81275cc1cb4e6879410a6540c0e2288a6d`。
- 使用现有生产授权创建并注销一个固定验收安装会话，实际通过 Gateway 调用 DeepSeek `TextReasoning`、MiMo `MediaReasoning`（真实 PNG、4000 token 正式参数）、MiMo → DeepSeek `VisualEvidence`、DeepSeek 原生 Web Search 和 Fun-ASR；五条能力均返回可消费的非空结果，原生搜索流包含 server tool use、tool result 与终止事件。
- 使用同一安装身份提交一个 Seedream 持久图片任务，Relay 成功落盘并通过 owner-bound 结果授权返回 703905 字节图片；随后 ack 成功，临时验收上传物和会话均已清理。
- 已鉴权图片任务的请求体读取使用独立 180 秒总窗口；普通聊天/媒体理解仍保持 30 秒入口读取窗口。两者继续共享 256 MiB 在途请求体预算，图片单请求仍不超过 32 MiB。
- 使用正式产品会话和生产 Gateway 提交 2,955,288 字节本地图片作为真实改图基线，改图任务成功完成并落下本地版本、视觉质检与 1,220,724 字节导出；导出哈希、父版本血缘、服务重启恢复、版本回退与前进均通过。

这些检查证明当前运行闭包、路由和五条真实上游能力可用；它们仍不是 1000 窗口真实上游吞吐证明，也不替代最后从 macOS/Windows 安装包执行的用户旅程。
