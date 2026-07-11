# IM 多渠道桥接 + H5 手机远程配对 —— 方案设计（只读调研，不改代码）

> 状态：🚧 方案稿（已拍板 5 决策）· 依据：`~/Desktop/cc-haha-ref` 真实源码逐行核实 + 本仓库 `ts/src` 现状核实。

## ★ owner 决策(2026-07-10)——落地按这个来
1. **IM 渠道：飞书 + 微信都做**(⚠️微信走非官方模拟个人号登录、有封号风险,owner 已知悉接受;实现上把微信 adapter 单独隔离,风险不牵连飞书/其他)。
2. **非局域网真远程：走 owner 大陆服务器中转**(不自建隧道;复用 owner 现有大陆机基础设施——服务器信息在 owner 桌面,**到真正建这块时再向 owner 取,不提前翻找凭据**)。
3. **IM adapter 进程模型：照 cc-haha = 独立子进程**(不内嵌 sidecar 主进程;Electron 侧复用现有 sidecar 拉起/健康检查模式管它生命周期)。
4. **H5：做多设备管理 + 踢出**(不是单设备)。
5. **附件收发：排进一期**(与 H5 局域网远程同期做,不后置)。

> 结论先行：cc 的两块功能（H5 远程访问 / IM 多渠道桥接）**本来就是本地 token + 不走云账户**的设计，跟 owner 的铁律天然对齐，不需要"魔改"多少；真正要改的是**部署形态**（cc 假设开发者会手动跑 CLI，我们要做成小白店主开箱即用）。我们已有的 `bridge*`/`teamService` 那套是完全不同的子系统（Anthropic 云端 code session 遥控），**跟本方案无关，不能混用**。

---

## 0. 一句话架构判断

cc-haha 其实是"**一个 WebSocket 会话协议，三种客户端**"：

```
Electron 桌面壳 ──┐
手机浏览器(H5)  ──┼──→ 同一个 /ws/:sessionId ──→ 同一个 Claude Code session（同一套审批闸）
IM adapter 进程 ──┘        (WsBridge 转发)
```

我们已经有这个协议的对等实现：`ts/src/server/index.ts` 里的 `/agent/ws`（`Bun.serve<AgentWsData>`，见 §3）。所以本方案 90% 的工作量不是"发明新协议"，而是：
1. 让 `/agent/ws` 能被局域网内的手机浏览器安全地连上（H5 部分）；
2. 写一个新的、可被 Electron 生命周期管理的 adapter 子进程，把 IM 平台的消息转成对 `/agent/ws` 的调用（IM 部分）。

---

## 1. cc-haha 真实怎么做的（file:line 实证）

### 1.1 H5 手机远程访问（无 IM，纯"扫码用手机浏览器开同一个聊天界面"）

同一个 React 应用包，同时服务 Electron 壳 / 桌面浏览器 / 手机浏览器三种运行时，靠一个 CSS 属性区分，不是三份代码：

- `desktop/src/lib/touchH5.ts:1-25`（文件头注释原话）："The same bundle serves three runtimes: the Electron desktop shell, desktop browsers, and phone browsers reaching the H5 server... instead of scattering UA checks through components we mark `<html data-touch-h5>` once"。`isTouchH5Environment()`（56-60行）判定：`hasDesktopHost=false`（没有 Electron 注入的 `window.desktopHost`）且指针是粗指针（触屏）才算 H5 环境。

后端：`src/server/services/h5AccessService.ts`（全文 805 行）
- 开关型功能，默认关闭（`DEFAULT_STORED_SETTINGS.enabled=false`，66-75行）。
- Token：`h5_` 前缀 + 32 字节随机数 base64url（157-159行），**服务器只用 SHA-256 哈希比对**（`validateToken()` 774-785行），明文只为了桌面端自己能再显示一次（767-772 行注释：issue #767，之前 token 只显示一次丢了就要重新生成，坑了已配对的手机）。
- 局域网 IP 自动发现：`findPrivateLanAddress()`（451-478行）遍历网卡，给物理网卡（`wifi|wlan|ethernet|en\d+`）加分、给虚拟网卡（`wsl|docker|vpn|tailscale|zerotier|utun` 等，449行 `VIRTUAL_INTERFACE_RE`）减分，选分最高的当 `publicBaseUrl`（如 `http://192.168.1.20:8850`）。
- `fixedPort`（27-32行注释）：让桌面重启后端口不变，手机收藏的二维码/URL 不失效。
- `disconnectGraceSeconds`（33-36行注释）：手机锁屏断连后，会话子进程不立刻杀，给个宽限期（默认 30s，89行 `DEFAULT_DISCONNECT_GRACE_MS`），任务能在后台跑完。

请求分类（谁能连、谁能改设置）：`src/server/h5AccessPolicy.ts`
- `classifyH5Request()`（61-88行）三分类：`local-trusted`（回环地址 + Electron `file://` 来源）/ `internal-sdk`（回环 + `/sdk/` 路径）/ `h5-browser`（其余，即局域网手机或反代来的请求）。
- `shouldRequireH5Token()`（90-110行）：只有 `h5-browser` 类请求需要带 token；本机 Electron 永远不需要。
- **关键红线**：`src/server/index.ts:99-112`（`isH5AccessControlRequest`）—— `/api/h5-access`（改开关/改 token/改允许来源）这组接口**只认 `local-trusted`**，手机/反代来源直接拒绝。也就是说：**配对设置这件事，永远只能在电脑本机上做，手机端不能反向改配置**——跟我们"审批闸只在本机拍板"的产品直觉完全一致，不用改。

前端配对入口：`desktop/src/pages/Settings.tsx`
- Settings 里一个独立 tab（204行 `TabButton icon="qr_code_2" label="H5Access"`），核心状态在 3305-3373 行 `H5AccessSettings()`：
  - `buildH5LaunchUrl(baseUrl, token)`（87-99行）拼出 `http://<lan-ip>:<port>/?serverUrl=...&h5Token=...`；
  - 用前端 `qrcode` 包本地生成二维码（3362行 `QRCode.toDataURL(h5LaunchUrl,...)`）——**二维码就是这个 URL，扫码=直接带 token 打开浏览器，不用手动输**；
  - `desktop/src/components/layout/H5ConnectionView.tsx` 是兜底：如果没有 URL 参数（比如手机浏览器 localStorage 被清了），才展示手输 "Server URL + Token" 的表单。
- 官方文档 `docs/desktop/06-h5-access.md:5`原话："它不是公开 SaaS 登录系统。任何拿到 H5 Token 的人，都可以访问当前桌面端服务暴露的核心聊天能力" —— cc 自己就把这个定位成"局域网/自己反代"的轻量功能，不是账户体系，跟我们要的形态完全一样。

### 1.2 IM 多渠道桥接（微信/飞书/钉钉/Telegram/WhatsApp）

这套代码**不在 `src/` 里，是仓库根下独立的 `adapters/` 子包**（`adapters/README.md` 有清楚的目录树）。跟桌面主进程之间只通过"配置文件 + WebSocket 客户端"松耦合：

```
adapters/README.md:16-25 官方画的真实链路：
Desktop Webapp Settings -> /api/adapters -> ~/.claude/adapters.json
  -> adapters/<platform>/index.ts -> /api/sessions + /ws/:sessionId -> Claude Code session
```

- 配置存哪：`adapters/common/config.ts:69-78`（`AdapterConfig` 含 telegram/feishu/wechat/dingtalk/whatsapp 五个平台段 + 顶层 `pairing`），文件在 `~/.claude/adapters.json`，服务端读写在 `src/server/services/adapterService.ts`（原子写：临时文件+rename，`chmod 0o600`，102-122行 GET 时对 `botToken`/`appSecret`/`clientSecret`/配对码做掩码 `****后4位`）。

- **配对机制（不走账户，纯本地一次性码）**：`adapters/common/pairing.ts`
  - `generatePairingCode()`（68-74行）：6 位安全字母表（排除 0/O/1/I/L 防认错，15行）；
  - 配对码由桌面端本机生成、60 分钟过期（44行 `CODE_TTL_MS`）；
  - 用户在 IM 里把这 6 位码当**一条普通文本消息**发给机器人，`tryPair()`（98-140行）校验：过期检查（110-111行）、5 分钟内最多 5 次失败限流（18-32行防爆破）、大小写/空格容错比较（113-115行）；
  - 成功后把 `{userId, displayName, pairedAt}` 写进该平台的 `pairedUsers`，**配对码立即清空，一次性使用**（135-137行）；
  - `isAllowedUser()`（143-150行）是各 adapter 每次收消息都要过的授权闸：`allowedUsers ∪ pairedUsers` 命中才放行，两者都为空则默认全拒（88-89行注释"默认关闭"）。

- **会话桥接**：`adapters/common/ws-bridge.ts`（全文 304 行）
  - 每个 IM `chatId` 对应一个桌面 `sessionId`（`connectSession(chatId, sessionId)`，63-70行），adapter 进程直接拿 WebSocket 客户端连桌面服务端的 `/ws/:sessionId`（跟手机浏览器、Electron 壳连的是**同一个协议**）；
  - `sendUserMessage()`（73-83行）把 IM 收到的文本转发成 `{type:'user_message', content, attachments}`；
  - `sendPermissionResponse(chatId, requestId, allowed, rule)`（85-104行）——**审批闸的放行指令也走这条通道**；
  - 断线重连指数退避（269-292行，最多 10 次）、30s 心跳（294-302行）、**同一 chatId 的消息处理严格串行排队**（47-50行注释 + 206-213行 `handlerChains`，防止后一条消息在前一条 await 未完时读到脏状态）。

- **审批闸在 IM 里怎么露出**：`adapters/common/permission.ts`
  - 纯文本兜底：回复 `1`/`允许`/`/allow <id>` = 允许一次，`2`/`永久允许` = 记住规则，`3`/`拒绝` = 拒绝（`parsePermissionCommand` 13-42行，中英文都认）；
  - 富交互卡片：`adapters/dingtalk/permission-card.ts:11-42`（`buildDingTalkPermissionCardParams`）拼钉钉互动卡片的三个按钮（允许一次/永久允许/拒绝），点击回调 `parsePermitCallbackData` 解析出 `{requestId, allowed, rule}` 再灌回 `ws-bridge.sendPermissionResponse`；飞书/Telegram 同理各自平台的 inline card / inline keyboard。
  - **结论**：cc 的 IM 审批闸不是另起一套逻辑，就是把桌面端本来就有的 `permission_request` 事件，翻译成"这个 IM 平台支持的 UI 形式"（文本数字 / 按钮卡片），再把用户的选择原样转成 `permission_response` 灌回同一个会话——这正是我们 CLAUDE.md 里"两条线只用三种廉价方式相接"的思路，cc 已经这么做了。

- **风险点老实说**：微信通道走的是 `ilinkai.weixin.qq.com`（`adapters/wechat/protocol.ts:3`），机制是"扫码登录一个真实微信号来假扮机器人"（`QrLoginStatus` 状态机 `wait/scaned/confirmed`，跟微信手机扫码登录一模一样，`protocol.ts:14`），官方文档自己也承认这是"适合个人私聊远程使用"（`docs/im/wechat.md:5`）的非官方玩法。这类"个人号自动化"（itchat/wechaty 那条历史路线）在业内长期存在被腾讯风控封号的风险，cc 自己也没把它当正式渠道包装——这是通用编程常识判断，不是我瞎猜。相比之下飞书/钉钉/Telegram 走的是各平台**官方** Bot API（`@larksuiteoapi/node-sdk`、DingTalk Stream API、grammy），风险低得多、长期稳定性好得多。

- **进程形态（这是 cc 假设了"用户是开发者"的地方）**：`adapters/README.md:29-30` 原话——"IM 配置和配对都在 Desktop Webapp 的 Settings -> IM 接入；**Webapp 不会自动启动 Adapter 进程，仍需手动运行 `bun run wechat`、`bun run dingtalk`、`bun run telegram` 或 `bun run feishu`**"。这是留给我们改的地方（见 §2.4）。

### 1.3 跟"H5/IM"完全无关、别搞混的另一套东西

`src/bridge/*`、`src/remote/*`、`src/coordinator/*`、`src/self-hosted-runner/*`、`src/ssh/*` 是 cc 的"**云端 code session 远程遥控**"功能（Control 端遥控一个跑在 Anthropic 云端/自托管 runner 上的后台 agent，走 JWT + `apiBaseUrl` HTTPS）。我们仓库里 `ts/src/tasks/bridge*.ts`（`bridgeCodeSessionClient.ts`/`bridgeWorkerClient.ts`/`bridgeRemoteState.ts` 等，共 5823 行）已经是这套东西的对等实现（`docs/当前架构与状态-总览.md:149`："Bridge/远程遥控(E维度)……走 Anthropic code sessions API"）。**这跟本方案（局域网手机 H5 + IM 桥接）是两条完全不同的技术线，接口、鉴权模型、目标场景都不一样，不能复用也不该混着讲。**

---

## 2. 我们的现实：逐条 adapt

owner 定的三条硬约束，逐条对照 cc 真实实现看要不要改：

### 2.1 不走账户体系（本地配对代替云账户）

**结论：cc 本来就是这么做的，不需要"改"，只需要抄。** H5 部分自始至终没有云账户——就是本地生成 token + 局域网 IP，纯文件持久化（存进 cc 的 `settings.json`，我们对应存进 `<stateRoot>` 下的 JSON）。IM 部分的"配对"也不是账户注册，就是本地生成一次性 6 位码 + 本地 JSON 文件记 `pairedUsers`。**唯一要注意**：cc 的 token/配对码文件用 `~/.claude/adapters.json`（全局，跨项目共享，因为 cc 是通用 CLI 工具）；我们是单机单店桌面产品，应该存进本产品自己的 `<stateRoot>`（`~/.billiardbuddy/state/`）下，别学 cc 存进用户全局 `~/.claude/`（那是 Claude Code CLI 自己的地盘，我们不该碰）。

### 2.2 对外触达仍过审批闸（不自动群发）

**结论：只要 IM/H5 客户端老老实实走同一条 `/agent/ws` 的 `run`/`approve`/`reject`，这条自动满足，不用加代码。** 我们的审批闸（五档权限 + "只卡对外/不可逆/花钱"）是在 harness/permissions 层挂在工具调用上的，跟"这个 WS 连接是从 Electron 来的还是从手机/IM adapter 来的"无关——只要没人为 IM/H5 开一条绕过 `approve`/`reject` 事件、直接执行工具的"快捷通道"，审批闸就是天然生效的。真正要做的是**翻译层**：把我们 WS 上的 `approval_request` 事件，翻译成 IM 平台能展示的形式（文本数字 / 飞书卡片 / 钉钉卡片），照抄 `adapters/common/permission.ts` 的思路——这是纯 UI 适配，不是把产品逻辑织进循环，符合我们"三种廉价接法"的判据。H5 手机浏览器完全不用管这条：它加载的就是同一份前端，审批卡片长什么样、怎么点，跟桌面端一模一样，天然过审批闸。

### 2.3 白标（手机端也不露真实 model 名/provider）

**结论：这条现有基建已经在做（`ts/src/harness/messageSanitize.ts`），跟客户端从哪连进来无关，是 harness 层面的输出过滤，天然覆盖 IM/H5。** 唯一要盯的验证点：IM adapter 转发给用户的文本，必须是"过完 sanitize 之后的最终文本"，不能因为 adapter 进程独立于主 harness 进程、走了另一条直接读 transcript 的旁路而漏过滤——设计上让 adapter 只消费 WS 上已经吐出来的最终事件（跟 cc 一致），不要自己另外拼装文本，这条就不会破。

### 2.4 部署形态（cc 没有、我们必须做的 adapt）

这是 cc 没解决、专属于我们"给不懂技术的台球店老板用"这个场景的地方：
- cc：开发者手动 `bun run wechat`；我们：Electron 主进程要像管理 sidecar 一样管理 adapter 子进程的启停（用户在设置里点"开启飞书接入"，Electron 就把对应 adapter 子进程拉起来、崩了自动重启、应用退出就杀掉）——参考我们已有的 sidecar 生命周期代码（`ts/desktop/electron/main.ts` 里 `buildSidecarPlan`/端口占用/`waitForServer` 那一套，adapter 子进程完全可以复用同一套"拉起+健康检查+崩溃重启"模式，不用另造轮子）。
- cc 的 H5 二维码要求电脑和手机在同一个"可信网络"；我们店主的场景是"人不在店里"，纯局域网不够用，需要一个内网穿透/远程访问方案（见 §4 分期建议）。

---

## 3. 我们已有 vs 要建

### 3.1 已有、可直接复用

| 能力 | 位置 | 说明 |
|---|---|---|
| 会话级 WebSocket 协议 | `ts/src/server/index.ts:3187-4777`（`Bun.serve<AgentWsData>`，`/agent/ws`） | `run`/`replay`(按 `after` 序号补发)/`interrupt`/`steer`/`approve`/`reject` 六种消息类型，`conversationId` 做 session key——跟 cc 的 `/ws/:sessionId` 是同构的协议，H5/IM 都应该直接接这条，不用建新协议。 |
| 断线重连/事件补发 | 同上，`replayWsEvents`（`after` 参数） | 对应 cc `disconnectGraceSeconds` 场景（手机断了再连上要能接得上），我们已有序号补发机制，只差"断线宽限期不杀进程"这个策略参数。 |
| 审批放行/拒绝 | 同上 `approve`/`reject` 分支（2363-2379 行、4753-4772 行） | `runApprovedTool`/`handleReject`，跟 cc `sendPermissionResponse` 语义一致，IM/H5 直接调用即可。 |
| Electron 侧子进程生命周期管理 | `ts/desktop/electron/main.ts`（`buildSidecarPlan`/端口占用/`waitForServer`） | IM adapter 子进程的"拉起+健康检查+崩溃重启+随主进程退出而杀"直接抄这一套模式。 |
| 输出白标过滤 | `ts/src/harness/messageSanitize.ts` | harness 层，天然覆盖新增客户端类型，不用重做。 |
| 权限五档 + 审批闸 | `ts/src/permissions/` | 天然覆盖，见 §2.2。 |

### 3.2 完全没有、要新建

| 能力 | cc 对应实现 | 我们要建在哪 |
|---|---|---|
| LAN 请求分类 + token 鉴权中间件 | `src/server/h5AccessPolicy.ts` | `ts/src/server/` 新文件（如 `h5AccessPolicy.ts`），照抄三分类思路（`local-trusted`/`h5-browser`），接到 `/agent/ws` 升级前的校验和现有 REST 路由前面。 |
| H5 Access 配置服务（开关/token/局域网 IP/固定端口） | `src/server/services/h5AccessService.ts` | `ts/src/server/services/` 新文件，存进 `<stateRoot>` 下 JSON（不是 `~/.claude/`，见 2.1），复用同样的 token 生成/哈希比对逻辑。 |
| 局域网监听（当前只绑 `127.0.0.1`） | `os.networkInterfaces()` 打分选优 | `ts/desktop/electron/main.ts` 的 `SERVER_BIND_HOST`/sidecar 启动参数要能可选绑 `0.0.0.0` 或选中的 LAN 网卡地址；`ts/src/server/index.ts:969` 的 `host` 默认值同步开放。 |
| CORS 放行局域网来源 | 无（当前 `localCorsOrigin` 只认 127.0.0.1/localhost） | 改 `localCorsOrigin`（`ts/src/server/index.ts:242-280`），按 H5 设置里的"允许来源"动态放行，别整体放开成 `*`。 |
| 桌面端"H5 访问"设置页 + 二维码 | `desktop/src/pages/Settings.tsx:3305-3373` | `ts/desktop/renderer/` 新增设置区块，同样用前端 `qrcode` 包本地生成，不经服务器传二维码图。 |
| 手机响应式 CSS 标记 | `desktop/src/lib/touchH5.ts` | 我们前端渲染层加同名思路的一个小工具 + `globals.css` 里加 `[data-touch-h5]` 作用域规则（工作量小，纯抄）。 |
| adapters 配置 + 配对码服务 | `adapters/common/config.ts` + `adapters/common/pairing.ts` + `src/server/services/adapterService.ts` | `ts/src/server/services/` 新文件（如 `imAdapterService.ts`），配置/配对码存 `<stateRoot>`；配对码生成、TTL、限流、一次性消费直接照抄 pairing.ts 的逻辑常量。 |
| IM 平台 adapter 进程（先接一个平台） | `adapters/<platform>/index.ts` + `adapters/common/ws-bridge.ts` + `adapters/common/permission.ts` | 新增 `ts/src/im/` 或作为 sidecar 子包，`ws-bridge` 直接对接我们的 `/agent/ws`；先接飞书（官方 SDK，风险低）。 |
| adapter 进程的 Electron 生命周期管理 | 无（cc 是手动 CLI） | `ts/desktop/electron/main.ts` 新增管理逻辑，见 §2.4。 |
| 审批闸→IM 卡片翻译层 | `adapters/common/permission.ts` + `adapters/dingtalk/permission-card.ts` | 每接一个 IM 平台各写一份，飞书先做纯文本"回复1/2/3"最简版即可上线，卡片是增强项不是必需项。 |
| 内网穿透/远程访问（人不在店里、不在同一 WiFi） | cc 只给"局域网 或 用户自己的反向代理域名"两个选项，没有内置隧道 | 待 owner 决策，见 §5。 |

---

## 4. 架构落点

```
ts/src/server/
  h5AccessPolicy.ts          [新] 请求分类：local-trusted / h5-browser（比照 cc h5AccessPolicy.ts）
  services/
    h5AccessService.ts       [新] H5 开关/token/局域网发现/固定端口，落 <stateRoot>/h5-access.json
    imAdapterService.ts      [新] adapters.json 等价物，落 <stateRoot>/im-adapters.json（配置+配对码+已配对用户）
  index.ts                   [改] /agent/ws 升级前插入 h5AccessPolicy 校验；localCorsOrigin 按 allowedOrigins 动态放行；
                                  host 默认值支持从"仅回环"切到"局域网可选网卡"

ts/src/im/                   [新] IM adapter 子系统（可先做成同进程内的模块，不一定非要独立子进程；
                                  是否独立进程见下面"分期建议"里的技术选型讨论）
  feishuAdapter.ts           [新] 飞书官方 SDK 接入：收消息→配对/授权检查→WS 连 /agent/ws→转发；approval_request→文本提示
  common/
    pairing.ts               [新] 照抄 cc pairing.ts 常量与流程（6位码/60min TTL/5次限流/一次性）
    wsBridgeClient.ts        [新] 照抄 cc ws-bridge.ts（chatId↔conversationId 映射、重连、心跳、串行队列）

ts/desktop/electron/main.ts  [改] 新增 IM adapter 子进程生命周期管理（复用 sidecar 那套 拉起/健康检查/崩溃重启/退出即杀）
                              [改] H5 LAN 绑定选项（用户在设置里开启后，sidecar 以 0.0.0.0 或选中网卡地址重启）

ts/desktop/renderer/         [新] 设置页新增"手机远程访问"+"IM 接入"两个区块（二维码用前端 qrcode 包本地生成）
```

**关键落点决策**：IM adapter 要不要做成"独立子进程"（照抄 cc 用单独 `adapters/` 包）还是"内嵌进 sidecar 主进程的一个模块"？
- cc 用独立进程是因为它是给"CLI 开发者"用的可选组件，能装能不装。
- 我们是打包发行的单机产品，装依赖成本已经在打包阶段解决了（`ts/CLAUDE.md` 铁律 3："加任何新依赖当场想它怎么到用户机器上"）。**建议内嵌进 sidecar 主进程**（同一个 Bun 进程里跑一个 IM adapter 模块，而不是 fork 一个新的 Bun/Node 子进程）：省掉一层进程间通信和生命周期管理复杂度，且 IM SDK（飞书官方 SDK 是纯 JS/TS）在 Bun 里能直接跑。只有当某个 IM 平台的 SDK 明确跟 Bun 不兼容（比如强依赖某些 Node-only 原生模块）时，才退回"独立子进程 + Electron 管生命周期"这条路（参考 whitespace：我们已经有"native 能力走 Node sidecar"的先例，`ts/CLAUDE.md` 铁律 9）。

**安全落点**：
- 局域网默认关闭、每次开启生成/复用 token（哈希存储，明文只本机可查，参照 h5AccessService.ts 774-785 行/153-159 行）。
- 配对码 60 分钟一次性、5 次失败限流（照抄 pairing.ts 常量）。
- `/api/h5-access`、`/api/adapters` 这类"改配置"的接口，仿照 cc `isH5AccessControlRequest` 的思路，只认本机（Electron 壳）请求，局域网手机/IM 侧永远不能反向改这些配置——只能查看/使用。
- 对外触达红线在手机/IM 端怎么卡：不额外做，天然继承 §2.2 的结论——只要 IM/H5 都走同一条 `/agent/ws` 的 `approve`/`reject`，红线就在。

---

## 5. 分期建议

**第一期（最小可用、风险最低、直接对标 cc 已验证的设计）**：只做 H5 局域网远程访问，不接任何 IM。
- 理由：这部分 cc 的实现已经被验证过、协议complexity最低（复用 `/agent/ws` 原样）、不涉及任何第三方平台审核/风控风险、店主"人在店里但离电脑远（比如在球台边）"这个高频场景马上能覆盖。
- 交付：设置页开关 + 二维码 + 局域网发现 + token 校验 + 断线宽限。

**第二期：接一个 IM 渠道**，推荐**飞书**（不是微信）：
- 理由：官方 Bot API，无 ToS/封号风险，`@larksuiteoapi/node-sdk` 现成可用；国内店主对飞书接受度虽不如微信高，但作为"验证 IM 桥接架构是否work"的第一个渠道，稳定性优先。
- 交付：配对码流程 + 纯文本"回复1/2/3"审批 + 收发文本消息（先不做图片/附件）。

**第三期：视 owner 决策再扩渠道**：
- 若 owner 坚持要微信（老板确实更习惯用微信），需要明确接受"个人号自动化"的封号风险，且建议优先看"企业微信客服"这类**官方**渠道能不能覆盖需求，而不是 cc 那种 QR 扫码模拟个人号登录的路子；
- 钉钉（官方 Stream API，企业场景）、Telegram（如有海外店主）按需再加；
- 补图片/附件收发（cc 的 `AttachmentRef` 协议可直接照抄）。

**第四期：解决"人真的不在同一个 WiFi"的远程访问**：
- cc 自己给的方案就是"用户自己的反向代理域名"（owner 自己整一个 frp/Cloudflare Tunnel/花生壳之类，cc 不内置隧道服务）；
- 我们要不要内置一个更傻瓜的方案（比如内置 frp 客户端 + owner 自己那台美国/国内服务器当 relay）是个待决策项——这会让"不走账户体系"这条铁律出现一个例外（相当于经过 owner 自己服务器转发），需要 owner 明确拍板要不要做、做到什么程度。

---

## 6. 风险清单

1. **微信个人号自动化封号风险**——cc 自己也是拿 `ilinkai.weixin.qq.com` 这条非官方通道实现的，历史上这类个人号自动化被腾讯风控大规模封号是常态，一旦店主自己的微信号被封，责任说不清。
2. **纯局域网限制**——第一期 H5 方案要求手机和电脑同一 WiFi，店主真正需要的"人不在店里也能用"场景覆盖不到，需要第四期方案兜底，但那涉及是否要经过 owner 自己的服务器（架构例外）。
3. **token/二维码泄露面**——二维码截图一旦被转发出去，任何人都能连上聊天核心能力（cc 文档原话就是这么警告的），需要在设置页给"重新生成 token 会让旧二维码失效"这个操作明确的提示。
4. **单店单用户下的多端并发语义**——现在桌面/手机/IM 如果同时对着同一个 `conversationId` 发消息，`/agent/ws` 目前的 `steer`/`interrupt` 语义要不要区分"谁在主导对话"，需要在实现前想清楚（比如手机端插一句话算 steer 还是算新 run）。
5. **飞书等 IM 的审批体验退化**——第一期纯文本"回复1/2/3"比 cc 的钉钉卡片体验差很多，可能出现店主没看懂就瞎回复导致误批准，需要文案上把"审批说明"写清楚（`formatPermissionInstructions` 那一套抄过来）。

---

## 7. 待 owner 决策项

1. **IM 渠道优先级**：是否认可"飞书先行、微信延后且需明确接受封号风险"这个建议，还是坚持微信优先（店主习惯）？
2. **远程访问（非局域网）方案**：要不要在产品里内置隧道/中转（经过 owner 自己的服务器），还是第一期先只做局域网、把"不在店里怎么办"留到以后？
3. **IM adapter 进程形态**：内嵌进 sidecar 主进程 vs 独立子进程由 Electron 管理——本方案建议内嵌，除非某个 IM SDK 被证实跟 Bun 不兼容。
4. **H5 是否需要"多设备管理/踢出"UX**：cc 只有"重新生成 token 让所有旧连接失效"这一种粗粒度撤销，要不要做更细的"看到有哪些设备连着、单独踢掉"？
5. **附件（图片/语音）收发是否第一期就要**：cc 的 IM 附件是独立设计（`AttachmentRef` 协议 + 24h GC），工作量不小，建议排进第三期而非第一期。
