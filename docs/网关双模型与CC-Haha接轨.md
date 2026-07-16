# 网关多模型与 CC-Haha 接轨(稳定边界)

> 状态:现行 · 迁移分支 `migration/cc-haha-baseline`。只记录当前稳定边界,不记录迁移过程。
> 面向 50~100 用户私测版:双服务器单入口(大陆 qfgw + 美国 relay),峰值 10~20 活跃 Agent 会话;
> 实际吞吐仍以供应商账号配额为上限,不承诺 100 人同时生成。

## 调用链

```
CC-Haha Desktop/Server
  → ConversationService
  → CC CLI 子进程(ANTHROPIC_BASE_URL = 本地 /proxy/providers/qf-gateway)
  → CC-Haha 本地 Provider Proxy(Anthropic Messages → OpenAI Chat 转换;仅 gateway 路径加 X-QF-Client-ID)
  → 产品网关 POST /v1/chat/completions(稳定 HTTPS QF_GATEWAY_URL,不出现服务器 IP)
  → Qwen3-Coder-Plus / MiMo v2.5 / DeepSeek V4 Flash(按 model 显式分流)
  → 流式文本 / reasoning_content / tool_use 转回 Anthropic 返回 Agent
```

语音另走:Renderer/视频 → sidecar → `POST /v1/audio/transcriptions` → 网关 → **Fun-ASR-Flash**。

## 装机公平调度(私测版)

- 全部安装共享一个 app token。桌面 Electron main 首启在产品数据根生成不可预测 `installationId`,
  只注入 server sidecar(`BB_INSTALLATION_ID`);本地 Proxy 仅在 gateway 路径把它作 `X-QF-Client-ID` 出网。
- 网关公平身份 = `token#client`:同一 token 的不同装机各占一份单用户额度(不再当成同一用户)。
- 装机身份只细分单用户公平与用量归属,受各上游全局并发上限约束,**不提权、不绕全局额度**;
  伪造/畸形 id 退回按 token 调度。`installationId` 从不进 CLI 子进程 / renderer / `providers.json` / 日志。
- 保留未来替换成独立用户 token 的接口边界,本阶段不做账号系统。

## 网关模型路由(`gateway/`)

- 三个独立上游 provider,各自 key/base/allowlist/并发/单用户并发/限流/重试/用量标签,**绝不静默跨供应商回退**:
  - **Qwen(默认)**:`GW_QWEN_KEY` / `GW_QWEN_BASE`(默认百炼 OpenAI 兼容端点)/ `GW_QWEN_MODEL`(默认 `qwen3-coder-plus`)/ `GW_QWEN_MODELS`。
  - **MiMo(可选)**:`GW_MIMO_KEY` / `GW_MIMO_BASE`(默认 `api.xiaomimimo.com/v1`)/ `GW_MIMO_MODEL`(默认 `mimo-v2.5`)/ `GW_MIMO_MODELS`。
  - **DeepSeek V4 Flash(可选)**:`GW_DEEPSEEK_KEY` / `GW_DEEPSEEK_BASE`(默认 `https://api.deepseek.com`)/ `GW_DEEPSEEK_MODEL`(默认 `deepseek-v4-flash`)/ `GW_DEEPSEEK_MODELS`;首版并发保守(全局 32、单装机 2、RPM 保守),不因官方并发 2500 就放开。注入受信 opaque `user_id`(`bb_<hash>`,官方字段名,不含隐私、不提权)。
- 路由:`model` 命中 DeepSeek allowlist→DeepSeek;命中 MiMo allowlist→MiMo;否则默认 Qwen(未知 model 归一为 `GW_QWEN_MODEL`,供应商内归一非跨供应商回退)。命中的上游 handler 为 null → `503`,绝不改投另一家。DeepSeek/MiMo allowlist 独立于各自 key 加载(始终含默认模型),缺 key 时仍能识别目标并 fail closed。
- `GET /v1/models`:鉴权后返回三家显式目录(`owned_by`),只列当前真正可路由的上游,供前端显式选择 + 会话级切换(复用 `set_runtime_config → CLI --model`,不改 Agent 循环)。
- **重试**:429 一律不重试直接回传;连接错误/可重试 5xx 最多额外一次(`GW_*_MAX_RETRIES` 硬夹 [0,1],与 CC CLI 重试不相乘)。
- 保留 app token 鉴权、公平队列、单用户并发、RPM、取消、超时、OpenAI Chat Completions + SSE + tool_call 逐字节透传、上游错误与 key 脱敏。
- 转录只保留 **Fun-ASR-Flash**;`GW_TRANSCRIBE_PROVIDER=whisper|upstream` fail closed;Whisper 不运行/下载/部署/回退。

## DeepSeek 思考模式与 reasoning_content(本地 Proxy)

- qf-gateway 路径下 Proxy 看到的 base URL 是网关域名,故 DeepSeek 兼容**按选中的 model 判定**(不只看 base URL)。
- 选中 DeepSeek 模型即启用:`thinking` 开关透传、`reasoning_content` 流式/非流式转换、多轮**无条件 verbatim 回传** `reasoning_content`(上一轮有 tool_call 时 DeepSeek 强制要求回传,否则 400)、`tool_calls` 与 `reasoning_content` 共存不丢工具调用。现有 SSE 解析已容忍 `: keep-alive` 与 `data: [DONE]`。不改原始提示词。

## CC-Haha 托管 Provider(`ts/src/server/`)

- 合成 built-in `qf-gateway`(`apiFormat: openai_chat`,`runtimeKind: anthropic_compatible`),复用既有本地 Provider Proxy 与 Anthropic↔OpenAI 转换,不新写 Agent/模型循环。
- 启动时若 `QF_GATEWAY_URL` + `QF_GATEWAY_TOKEN` 都在且 `activeId` 为空或已是 gateway,则自动激活;绝不覆盖用户手工选择的 provider,合成 provider 从不进 `providers.json` 的保存列表。

## 凭据与身份存放边界

| 项 | 存放位置 |
|---|---|
| 上游 Qwen / MiMo / DeepSeek 真密钥(`GW_QWEN_KEY` / `GW_MIMO_KEY` / `GW_DEEPSEEK_KEY`) | **只在网关服务器** `/opt/qfgw/gw.env`(600),桌面端从不引用 |
| Fun-ASR 密钥(`GW_FUNASR_KEY`)、relay token(`GW_RELAY_TOKEN`) | 同上,只在服务器 |
| 产品网关地址 `QF_GATEWAY_URL` + 可撤销 app token `QF_GATEWAY_TOKEN` | 桌面端 `process.env`(装机版从打包 `product-secrets.json` 注入);token 仅在请求时注入代理 `apiKey`,**不落 `providers.json` / `settings.json`,不进 CLI 子进程环境,不进日志** |
| 装机身份 `BB_INSTALLATION_ID`(installationId) | 只注入 server sidecar,作 `X-QF-Client-ID` 出网;不进 CLI 子进程 / renderer / `providers.json` / 日志 |

CLI 子进程对 openai_chat provider 只拿到 `ANTHROPIC_API_KEY=proxy-managed`(假值)+ 本地代理 `ANTHROPIC_BASE_URL`;`QF_GATEWAY_*` 与 `BB_INSTALLATION_ID` 在每个 spawn 收口剥离。

## 验证与回滚

- 网关假上游测试:`bun test gateway/`(含三模型路由、`/v1/models`、429 不重试/5xx 一次、装机公平调度 100 装机/20 并发容量证据、生图 owner+幂等透传)。
- relay 假上游测试:`bun test relay/`(幂等、越权 403、队列上限、超大 413、重启恢复)。
- CC server 测试:`cd ts && bun run check:server`(含托管 Provider 自动生效、Anthropic↔OpenAI 往返、流式 tool_use、X-QF-Client-ID 出网、DeepSeek 多轮 reasoning 回传)。
- 真机:对网关 `/v1/chat/completions` 各发一次 Qwen / MiMo / DeepSeek(含思考与非思考);经本地 Provider Proxy 打一次带工具的 Anthropic 请求验证 tool_use 经网关成功;相同 Idempotency-Key 重复提交证明只一个真实图片任务。
- 回滚:部署前备份 `/opt/qfgw.bak-<ts>`(代码 + `gw.env`)与 relay(`app.ts` + `relay.env` + `relay.db` + blob);部署失败 `cp -a` 回滚并 `systemctl restart`。**部署前必须 `rm -f /tmp/gw.env`**,`gateway/deploy.sh` 只在 `/tmp/gw.env` 存在时才覆盖现网 gw.env。
- **注意**:本迁移分支 `gateway/transcription.ts` 已定向同步为 Fun-ASR-only;不得用早于 Fun-ASR 基线的 gateway 覆盖服务器,否则会把线上转录退回 Whisper。
