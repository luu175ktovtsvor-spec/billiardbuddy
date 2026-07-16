# 网关双模型与 CC-Haha 接轨(稳定边界)

> 状态:现行 · 迁移分支 `migration/cc-haha-baseline`。只记录当前稳定边界,不记录迁移过程。

## 调用链

```
CC-Haha Desktop/Server
  → ConversationService
  → CC CLI 子进程(ANTHROPIC_BASE_URL = 本地 /proxy/providers/qf-gateway)
  → CC-Haha 本地 Provider Proxy(Anthropic Messages → OpenAI Chat 转换)
  → 产品网关 POST /v1/chat/completions
  → Qwen3-Coder-Plus 或 MiMo
  → 流式文本 / tool_use 转回 Anthropic 返回 Agent
```

语音另走:Renderer/视频 → sidecar → `POST /v1/audio/transcriptions` → 网关 → **Fun-ASR-Flash**。

## 网关模型路由(`gateway/`)

- 两个独立上游 provider,各自 key/base/allowlist/并发/限流/重试,**绝不静默回退**:
  - **Qwen(默认)**:`GW_QWEN_KEY` / `GW_QWEN_BASE`(默认百炼 OpenAI 兼容端点)/ `GW_QWEN_MODEL`(默认 `qwen3-coder-plus`)/ `GW_QWEN_MODELS`。
  - **MiMo(第二可选)**:`GW_MIMO_KEY` / `GW_MIMO_BASE`(默认 `api.xiaomimimo.com/v1`)/ `GW_MIMO_MODEL`(默认 `mimo-v2.5`)/ `GW_MIMO_MODELS`。
- 路由规则:请求 `model` 命中 MiMo allowlist 且 MiMo 已配置 → MiMo;否则 → Qwen(默认,未知 model 强制改写为 `GW_QWEN_MODEL`,客户端不能绕过白名单)。命中的 handler 为 null → `503`,不改投另一家。
- 保留 app token 鉴权、公平队列、单用户并发、RPM、取消、超时、重试、OpenAI Chat Completions + SSE + tool_call 逐字节透传、上游错误与 key 脱敏。
- 转录只保留 **Fun-ASR-Flash**;`GW_TRANSCRIBE_PROVIDER=whisper|upstream` fail closed;Whisper 不运行/下载/部署/回退。

## CC-Haha 托管 Provider(`ts/src/server/`)

- 合成 built-in `qf-gateway`(`apiFormat: openai_chat`,`runtimeKind: anthropic_compatible`),复用既有本地 Provider Proxy 与 Anthropic↔OpenAI 转换,不新写 Agent/模型循环。
- 启动时若 `QF_GATEWAY_URL` 存在且 `activeId` 为空或已是 gateway,则自动激活;绝不覆盖用户手工选择的 provider,合成 provider 从不进 `providers.json` 的保存列表。
- `QF_GATEWAY_MODEL` 选择默认 Qwen 或 MiMo;本阶段不新增模型选择前端,技术模型名不进球房用户界面。

## 凭据存放边界

| 密钥 | 存放位置 |
|---|---|
| 上游 Qwen / MiMo 真密钥(`GW_QWEN_KEY` / `GW_MIMO_KEY`) | **只在网关服务器** `/opt/qfgw/gw.env`(600),桌面端从不引用 |
| Fun-ASR 密钥(`GW_FUNASR_KEY`) | 同上,只在网关 |
| 产品网关地址 `QF_GATEWAY_URL` + 可撤销 app token `QF_GATEWAY_TOKEN` | 桌面端 `process.env`;token 仅在请求时注入代理 `apiKey`,**不落 `providers.json` / `settings.json`,不进 CLI 子进程环境,不进日志** |

CLI 子进程对 openai_chat provider 只拿到 `ANTHROPIC_API_KEY=proxy-managed`(假值)+ 本地代理 `ANTHROPIC_BASE_URL`。

## 验证与回滚

- 网关假上游测试:`bun test gateway/`。
- CC server 测试:`cd ts && bun run check:server`(含托管 Provider 自动生效、Anthropic↔OpenAI 往返、流式 tool_use)。
- 真机:对网关 `/v1/chat/completions` 各发一次 Qwen 与 MiMo;经本地 Provider Proxy 打一次带工具的 Anthropic 请求验证 tool_use 经网关到 Qwen 成功。
- 回滚:部署前备份 `/opt/qfgw.bak-<ts>`(代码 + `gw.env`);部署失败 `cp -a` 回滚 `.ts` 并 `systemctl restart qfgw`,可恢复到 Qwen + Fun-ASR 健康态。**部署前必须 `rm -f /tmp/gw.env`,`deploy.sh` 只在 `/tmp/gw.env` 存在时才覆盖现网 gw.env。**
- **注意**:本迁移分支 `gateway/transcription.ts` 已定向同步为 Fun-ASR-only;不得用早于 Fun-ASR 基线的 gateway 覆盖服务器,否则会把线上转录退回 Whisper。
