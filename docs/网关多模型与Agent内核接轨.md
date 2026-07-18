# 网关多模型与 Agent 内核接轨(稳定边界)

> 状态:现行 · 开发分支 `dev`。只记录当前稳定边界,不记录迁移过程。
> 面向 50~100 用户私测版:双服务器单入口(大陆 qfgw + 美国 relay),峰值 10~20 活跃 Agent 会话;
> 实际吞吐仍以供应商账号配额为上限,不承诺 100 人同时生成。

## 调用链

```
BilliardBuddy Desktop/Server
  → ConversationService
  → Agent CLI 子进程(ANTHROPIC_BASE_URL = 本地 /proxy/providers/qf-gateway)
  → 本地 Provider Proxy(Anthropic Messages → OpenAI Chat 转换;仅 gateway 路径加 X-QF-Client-ID)
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
- **普通图片视觉桥接容量**:默认模型 DeepSeek 带图时,网关内部另用一个有界信号量(`GW_VISION_CONC`,默认 12)调 MiMo v2.5 视觉,与 MiMo 原生聊天池(`mimoCapacity`,默认 16)相互独立、同打一个 MiMo 账号——峰值合计约 28 路,远低于 MiMo 账号 ~100 上限;视觉信号量按全局有界(`GW_VISION_CONC`,默认 12);排队队列有硬上限(`GW_VISION_QUEUE_MAX`,默认 64——满则立即 429、不再入队,防等待队伍无界占内存),单个请求最多同时占 `GW_VISION_PER_REQUEST_CONC`(默认 2)个全局槽(防单个多图请求独占视觉资源),排队者响应客户端取消立即出队;私测规模下未做单用户公平调度,以上 env 均可调。视觉结果按 `sha256(图片字节)` 有界+TTL 内存缓存,同图跨轮不重复调 MiMo,绝不落盘、绝不入日志。
- **Computer Use 视觉路由**:仅当请求同时带图并启用真实 Computer Use 工具集(截图工具加输入动作工具)时,网关把原始截图、工具定义和本轮上下文直接交给 `mimo-v2.5` 原生多模态处理,以保留像素和坐标语义。这是显式能力路由,占 MiMo 原生聊天池,不是失败回退;普通图片仍按上条先转结构化文本再交给原目标文本模型。
- 路由:`model` 命中 DeepSeek allowlist→DeepSeek;命中 MiMo allowlist→MiMo;否则默认 Qwen(未知 model 归一为 `GW_QWEN_MODEL`,供应商内归一非跨供应商回退)。命中的上游 handler 为 null → `503`,绝不改投另一家。DeepSeek/MiMo allowlist 独立于各自 key 加载(始终含默认模型),缺 key 时仍能识别目标并 fail closed。**一次会话/Agent 工具循环模型固定**(model 随请求体透传、命中白名单不改写),不在输出开始后或 tool_use 循环中静默换。
- `GET /v1/models`:鉴权后返回三家显式目录(`owned_by`),只列当前真正可路由的上游,供内部运维和协议兼容使用；普通桌面界面不展示模型名或切换入口。
- **重试**:429 一律不重试直接回传;连接错误/可重试 5xx 最多额外一次(`GW_*_MAX_RETRIES` 硬夹 [0,1],与 CC CLI 重试不相乘)。SSE 正常结束、上游中途断流、客户端断开三条路径都释放并发许可(active/queued 必回落)。
- 保留 app token 鉴权、公平轮转(无饿死)、单装机并发与 RPM(私测默认放开为不节流,保留 env 可再收紧)、全局并发高水位闸、取消、超时、OpenAI Chat Completions + SSE + tool_call 逐字节透传、上游错误与 key 脱敏。healthz 只对鉴权请求暴露三池 active/queued/capacity。
- 转录只保留 **Fun-ASR-Flash**;`GW_TRANSCRIBE_PROVIDER=whisper|upstream` fail closed;Whisper 不运行/下载/部署/回退。
- 图片生成与编辑只通过异步 `POST /v1/images/tasks` 提交、`GET /v1/images/tasks/:id` 轮询。同步 `/v1/images/generations` 与 `/v1/images/edits` 已退役,避免绕开 relay 的幂等、归属和未知结果保护。

## 厂商能力矩阵与图片/思考路由(本地 Proxy,按 model 判定;已按官方文档核实)

| 上游模型 | 图片输入(多模态) | 思考模式 / reasoning_content | 工具调用 | 官方限流 |
|---|---|---|---|---|
| **mimo-v2.5**(视觉唯一上游) | ✅ 唯一多模态(image_url,官方) | ✅ `thinking:{type:enabled\|disabled}`,有 reasoning_content;**官方提醒 thinking+工具不稳定** | ✅ | 100 RPM/账户 |
| mimo-v2.5-pro | ❌ 纯文本推理 | ✅ | ✅ | 100 RPM/账户 |
| **deepseek-v4-flash**(产品默认) | ❌ | ✅ `thinking:{type}`,多轮有 tool_call 时**必须 verbatim 回传 reasoning_content**否则 400 | ✅ | 2500 并发/账户(本产品保守放开) |
| qwen3-coder-plus | ❌ | ❌(coder,无思考) | ✅ | — |
| Fun-ASR-Flash | —(ASR 转录,非对话) | ❌ N/A | — | — |
| Whisper | 已退役,不运行/下载/回退 | — | — | — |

- **图片输入策略**:本地 Proxy 对 qf-gateway 路径的图片输入一律放行 `image_url` 到网关,**不再本地 400、不静默丢图、不改投**。网关侧按目标 `model` 判定:精确匹配的 **`mimo-v2.5`**(真实多模态)原生直传 `image_url`;路由到其余模型(DeepSeek/Qwen/`mimo-v2.5-pro` 等非原生多模态)时,普通图片先由 MiMo 视觉桥接转成结构化文本、替换掉 `image_url`,再把去图后的请求体交给按 `model` 路由到的文本模型。Computer Use 截图回合是例外:检测到真实 Computer Use 工具集时整轮原样路由到 `mimo-v2.5`,不经过结构化桥接。仅约束网关路径;用户自建直连 provider 按其真实能力处理,纯文本模型仍 `text_only`,不做视觉桥接。
- **DeepSeek 兼容**(本地 Proxy 按选中 model 判定,base URL 是网关域名故不能只看 URL):启用 `thinking` 开关透传、`reasoning_content` 流式/非流式转换、多轮**无条件 verbatim 回传** `reasoning_content`、`tool_calls` 与 `reasoning_content` 共存不丢工具调用。SSE 解析已容忍 `: keep-alive` 与 `data: [DONE]`。不改原始提示词。

## 托管 Provider(`ts/src/server/`)

- 合成 built-in `qf-gateway`(`apiFormat: openai_chat`,`runtimeKind: anthropic_compatible`),复用既有本地 Provider Proxy 与 Anthropic↔OpenAI 转换,不新写 Agent/模型循环。
- 启动时若 `QF_GATEWAY_URL` + `QF_GATEWAY_TOKEN` 都存在,则产品网关是权威运行入口:自动激活合成 gateway provider,覆盖旧安装遗留的手工/官方 activeId,避免用户被卡在前端已隐藏且无法切换的运行时。已保存的通用 provider 定义不删除,合成 provider 也从不进 `providers.json` 的保存列表。

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
- Agent server 测试:`cd ts && bun run check:server`(含托管 Provider 自动生效、Anthropic↔OpenAI 往返、流式 tool_use、X-QF-Client-ID 出网、DeepSeek 多轮 reasoning 回传)。
- 真机:对网关 `/v1/chat/completions` 各发一次 Qwen / MiMo / DeepSeek(含思考与非思考);经本地 Provider Proxy 打一次带工具的 Anthropic 请求验证 tool_use 经网关成功;相同 Idempotency-Key 重复提交证明只一个真实图片任务。
- 回滚:部署前备份代码 `/opt/qfgw.bak-<ts>`、`gw.env` 单独备份 `/root/gw.env.bak-<ts>`,relay 同理备份(`app.ts` + `relay.env` + `relay.db` + blob)。部署失败时**不能直接 `cp -a /opt/qfgw.bak-<ts> /opt/qfgw`**——`/opt/qfgw` 目录本身已存在,`cp -a` 会把备份复制成 `/opt/qfgw` 下的子目录 `qfgw.bak-<ts>`,不覆盖现文件、回滚不生效(已在 `/tmp` 模拟验证)。正确做法:
  ```
  rsync -a --delete /opt/qfgw.bak-<ts>/ /opt/qfgw/ && systemctl restart qfgw
  ```
  (源路径结尾带 `/`,使 `/opt/qfgw` 精确等于备份、不嵌套;relay 回滚同理用 `rsync -a --delete`)。备选写法(保留失败版备查):`mv /opt/qfgw /opt/qfgw.failed-<ts> && cp -a /opt/qfgw.bak-<ts> /opt/qfgw && systemctl restart qfgw`。`gw.env` 是单文件,`cp -a /root/gw.env.bak-<ts> /opt/qfgw/gw.env` 单文件覆盖不会嵌套,仍安全可用。**部署前必须 `rm -f /tmp/gw.env`**,`gateway/deploy.sh` 只在 `/tmp/gw.env` 存在时才覆盖现网 gw.env。
- **注意**:`gateway/transcription.ts` 只支持 Fun-ASR;部署时不得用旧版 gateway 覆盖服务器,否则会把线上转录退回已废弃实现。
