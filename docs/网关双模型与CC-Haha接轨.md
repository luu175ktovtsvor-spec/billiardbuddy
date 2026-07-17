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

- 三个独立上游 provider,各自 key/base/allowlist/并发/单装机并发/单 token 二级并发/限流/重试/用量标签,**绝不静默跨供应商回退**:
  - **MiMo v2.5(视觉唯一上游,非默认文本模型)**:`GW_MIMO_KEY` / `GW_MIMO_BASE`(默认 `api.xiaomimimo.com/v1`)/ `GW_MIMO_MODEL`(默认 `mimo-v2.5`)/ `GW_MIMO_MODELS`。全局 16(高水位紧急总并发闸)、单装机默认=全局(私测放开,`GW_MIMO_USER_CONC` 可收紧)、RPM 默认放开不节流(`GW_MIMO_RPM`,曾 90;靠上游 429 原样透传兜底)。
  - **Qwen3-Coder-Plus(可选)**:`GW_QWEN_KEY` / `GW_QWEN_BASE`(默认百炼 OpenAI 兼容端点)/ `GW_QWEN_MODEL` / `GW_QWEN_MODELS`。全局 16(高水位紧急总并发闸)、单装机默认=全局(私测放开)、RPM 默认放开不节流(`GW_QWEN_RPM`,曾 90)。
  - **DeepSeek V4 Flash(产品默认)**:`GW_DEEPSEEK_KEY` / `GW_DEEPSEEK_BASE`(默认 `https://api.deepseek.com`)/ `GW_DEEPSEEK_MODEL`(默认 `deepseek-v4-flash`)/ `GW_DEEPSEEK_MODELS`。全局 32(高水位紧急总并发闸)、单装机默认=全局(私测放开)、RPM 默认放开不节流(`GW_DEEPSEEK_RPM`,曾 60;不因官方并发 2500 就设无限,靠全局闸+429 兜底)。注入受信 opaque `user_id`(`bb_<hash>`,官方字段名,不含隐私、不提权)。
- 三池容量互不共享(key/RPM/并发/队列/重试/二级 token 闸独立);一池打满不阻塞另两池。每池三层闸:全局并发、单 token 二级并发(`GW_*_TOKEN_CONC`,默认=全局,防单 token 伪造多装机独占)、单装机并发。
- **文字容量私测放开**:应用级低 RPM、单装机并发、长时间公平排队默认已放开为不节流正常文字流量(避免本地令牌桶再现"高并发 p95 十几秒"),机制保留、可经各自 env 再收紧;`GW_*_CONC` 全局并发高水位闸不动,始终兜底保护上游。
- **视觉桥接容量**:默认模型 DeepSeek 带图时,网关内部另用一个有界信号量(`GW_VISION_CONC`,默认 12)调 MiMo v2.5 视觉,与 MiMo 原生聊天池(`mimoCapacity`,默认 16)相互独立、同打一个 MiMo 账号——峰值合计约 28 路,远低于 MiMo 账号 ~100 上限;视觉信号量按全局有界,满则短暂排队后 429 失败关闭(私测规模下未做单用户公平调度,`GW_VISION_CONC` 可调)。视觉结果按 `sha256(图片字节)` 有界+TTL 内存缓存,同图跨轮不重复调 MiMo,绝不落盘、绝不入日志。
- 路由:`model` 命中 DeepSeek allowlist→DeepSeek;命中 MiMo allowlist→MiMo;否则默认 Qwen(未知 model 归一为 `GW_QWEN_MODEL`,供应商内归一非跨供应商回退)。命中的上游 handler 为 null → `503`,绝不改投另一家。DeepSeek/MiMo allowlist 独立于各自 key 加载(始终含默认模型),缺 key 时仍能识别目标并 fail closed。**一次会话/Agent 工具循环模型固定**(model 随请求体透传、命中白名单不改写),不在输出开始后或 tool_use 循环中静默换。
- `GET /v1/models`:鉴权后返回三家显式目录(`owned_by`),只列当前真正可路由的上游,供前端显式选择 + 会话级切换(复用 `set_runtime_config → CLI --model`,不改 Agent 循环)。
- **重试**:429 一律不重试直接回传;连接错误/可重试 5xx 最多额外一次(`GW_*_MAX_RETRIES` 硬夹 [0,1],与 CC CLI 重试不相乘)。SSE 正常结束、上游中途断流、客户端断开三条路径都释放并发许可(active/queued 必回落)。
- 保留 app token 鉴权、公平轮转(无饿死)、单装机并发与 RPM(私测默认放开为不节流,保留 env 可再收紧)、全局并发高水位闸、取消、超时、OpenAI Chat Completions + SSE + tool_call 逐字节透传、上游错误与 key 脱敏。healthz 只对鉴权请求暴露三池 active/queued/capacity。
- 转录只保留 **Fun-ASR-Flash**;`GW_TRANSCRIBE_PROVIDER=whisper|upstream` fail closed;Whisper 不运行/下载/部署/回退。

## 厂商能力矩阵与图片/思考路由(本地 Proxy,按 model 判定;已按官方文档核实)

| 上游模型 | 图片输入(多模态) | 思考模式 / reasoning_content | 工具调用 | 官方限流 |
|---|---|---|---|---|
| **mimo-v2.5**(视觉唯一上游) | ✅ 唯一多模态(image_url,官方) | ✅ `thinking:{type:enabled\|disabled}`,有 reasoning_content;**官方提醒 thinking+工具不稳定** | ✅ | 100 RPM/账户 |
| mimo-v2.5-pro | ❌ 纯文本推理 | ✅ | ✅ | 100 RPM/账户 |
| **deepseek-v4-flash**(产品默认) | ❌ | ✅ `thinking:{type}`,多轮有 tool_call 时**必须 verbatim 回传 reasoning_content**否则 400 | ✅ | 2500 并发/账户(本产品保守放开) |
| qwen3-coder-plus | ❌ | ❌(coder,无思考) | ✅ | — |
| Fun-ASR-Flash | —(ASR 转录,非对话) | ❌ N/A | — | — |
| Whisper | 已退役,不运行/下载/回退 | — | — | — |

- **图片输入策略(item 8)**:图片只允许进入真实多模态的 **`mimo-v2.5`**(精确匹配,排除纯文本的 `mimo-v2.5-pro`)。qf-gateway 路径下选中 Qwen/DeepSeek/`mimo-v2.5-pro` 却带图片时,本地 Proxy 返回明确 `400`,**绝不静默丢图或改投别家**;MiMo 路径按 vision 透传 `image_url`。仅约束网关路径,用户自建 provider 不受此限。
- **DeepSeek 兼容**(本地 Proxy 按选中 model 判定,base URL 是网关域名故不能只看 URL):启用 `thinking` 开关透传、`reasoning_content` 流式/非流式转换、多轮**无条件 verbatim 回传** `reasoning_content`、`tool_calls` 与 `reasoning_content` 共存不丢工具调用。SSE 解析已容忍 `: keep-alive` 与 `data: [DONE]`。不改原始提示词。

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
