# BilliardBuddy 生产服务器

更新时间：2026-07-26。本文件只记录本次部署后实测状态；不得把历史快照当成当前事实。

## 拓扑

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
- 已确认 `/opt/billiardbuddy-gateway/qwenChat.ts` 与 `/opt/billiardbuddy-gateway/webSearch.ts` 不存在；DeepSeek 原生搜索由独立 `/v1/messages` 窄路由提供。

Gateway 环境变量名称（只记录名称，不记录值）：

```text
GW_ADMIN_TOKEN
GW_APP_CREDENTIALS
GW_AUTHORITY_FILE
GW_AUTH_SIGNING_KEY
GW_DB
GW_DEEPSEEK_CONC
GW_DEEPSEEK_KEY
GW_DEEPSEEK_MAX_RETRIES
GW_DEEPSEEK_QUEUE_MAX
GW_DEEPSEEK_QUEUE_MAX_WAIT
GW_DEEPSEEK_TOKEN_CONC
GW_DEEPSEEK_USER_CONC
GW_FUNASR_KEY
GW_IMG_IPM
GW_IMG_QUEUE_MAX
GW_INGRESS_INFLIGHT_BODY_BYTES
GW_LICENSE_PROVISIONING
GW_MIMO_BASE
GW_MIMO_CONC
GW_MIMO_INFLIGHT_PER_USER
GW_MIMO_KEY
GW_MIMO_MAX_RETRIES
GW_MIMO_MEDIA_CONC
GW_MIMO_QUEUE_MAX
GW_MIMO_QUEUE_MAX_WAIT
GW_MIMO_RETRY_BASE_MS
GW_MIMO_RETRY_MAX_MS
GW_MIMO_TOKEN_CONC
GW_MIMO_USER_CONC
GW_RELAY_RESULT_TIMEOUT_MS
GW_RELAY_SUBMIT_TIMEOUT_MS
GW_RELAY_TASKS_BASE
GW_RELAY_TOKEN
GW_SERVER_IDLE_TIMEOUT_SECONDS
GW_TRANSCRIBE_CONC
GW_TRANSCRIBE_MAX_BYTES
GW_TRANSCRIBE_RPM
GW_TRANSCRIBE_TIMEOUT_MS
GW_VISION_CONC
GW_VISION_MAX_INFLIGHT_PER_CLIENT
GW_VISION_PER_CLIENT_CONC
GW_VISION_PER_REQUEST_CONC
GW_VISION_QUEUE_MAX
GW_VISION_QUEUE_MAX_WAIT_MS
```

现网已显式设置 `GW_MIMO_MEDIA_CONC=48`；旧名称 `GW_MIMO_NATIVE_CONC` 已删除。

## 美国 Relay 与 TLS 入口

- 主机：`47.77.237.250`
- systemd：`billiardbuddy-relay.service`、`billiardbuddy-gateway-tunnel.service`、`nginx.service`，均为 `active`
- Relay 运行目录：`/opt/billiardbuddy-relay`
- Relay 进程：`/root/.bun/bin/bun /opt/billiardbuddy-relay/app.ts`
- Relay 监听：仅 `127.0.0.1:8790`
- Gateway 隧道监听：`127.0.0.1:8800` → 大陆 `127.0.0.1:8799`
- Nginx：公网 `:80/:443`
- Gateway 公网入口：`https://zzyppz.cn/gw/`
- Relay 内部入口：`https://zzyppz.cn/relay/imgtasks/`
- Relay ACL：仅允许 `39.106.214.21` 与 `127.0.0.1`，外部实测 403
- 持久状态：`relay.db*` 权限 `0600`，`blobs/` 权限 `0700`
- 当前健康值：queue 2000、单 owner 20、GPT Image 并发 16/单 owner 2、Seedream 已配置且并发 6/单 owner 1、输入预算 512 MiB。

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
- Gateway：上传 `gateway/app.ts` 及其正式依赖、`ts/shared/product/authEntitlement.ts`（目标名 `authority.ts`）、校验脚本与 `gateway/deploy.sh` 后执行部署脚本。
- 两个部署脚本都保留已有凭据文件，校验非敏感容量配置，重启 systemd，并验证本机 `/healthz` 的协议清单。

本次实测：

- `https://zzyppz.cn/gw/healthz`：200，Gateway/Relay 协议均为 `bb-provider-gateway/1.0`
- 外部访问 `https://zzyppz.cn/relay/imgtasks/healthz`：403
- 美国本机经 Nginx 访问 Relay health：200
- 大陆公网 `http://39.106.214.21/healthz`：404
- 两台服务器相关 systemd 服务均为 `active`
- Gateway 运行闭包在部署前通过授权、`64 = 48 + 16` MiMo 硬分区和 1000-window 配置预检；部署后 `/opt/billiardbuddy-gateway/app.ts` 与仓库 SHA-256 同为 `05746da18dc167f5767590f0d7bf7bc36a3ab28521bbcf761b102a8760a1c940`。
- Relay 未发生源码漂移；`/opt/billiardbuddy-relay/app.ts` 与仓库 SHA-256 同为 `0250443599bfd3d46daf11655f1ab1c1afaf1f79e7eb0f19f8670630e7cebac7`。
- 使用现有生产授权创建并注销一个固定验收安装会话，实际通过 Gateway 调用 DeepSeek `TextReasoning`、MiMo `MediaReasoning`（真实 PNG、4000 token 正式参数）、MiMo → DeepSeek `VisualEvidence`、DeepSeek 原生 Web Search 和 Fun-ASR；五条能力均返回可消费的非空结果，原生搜索流包含 server tool use、tool result 与终止事件。
- 使用同一安装身份提交一个 Seedream 持久图片任务，Relay 成功落盘并通过 owner-bound 结果授权返回 703905 字节图片；随后 ack 成功，临时验收上传物和会话均已清理。

这些检查证明当前运行闭包、路由和五条真实上游能力可用；它们仍不是 1000 窗口真实上游吞吐证明，也不替代最后从 macOS/Windows 安装包执行的用户旅程。
