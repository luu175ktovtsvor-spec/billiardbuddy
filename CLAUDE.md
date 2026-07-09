# 桌面版 AI Agent(通用本机 AI 执行助手)

> 📌 状态:✅现行 · 最后核对 2026-07-10 · **唯一代码栈 = `ts/`**(Bun/TS 内核 + Electron 壳,cc-haha 标准 coding-agent 循环)。老 Python 线(`server/`/`web/`/`desktop/`)已整体退役删除。

> **🧭 新会话先在这定位(权威入口,按此为准):**
> - **这是什么**:装在用户电脑上的**通用本机 AI Agent 桌面软件**(强 coding agent 外壳),对标 cc-haha(`~/Desktop/cc-haha-ref`,LICENSE 允许 copy/modify/distribute,可直接复制/抄/移植/改写)。能读写/改本机文件、跑命令、上网查抓、生图、列清单、派子代理,实打实把活干完。**台球房运营 = 可 `@挂载` 的领域知识包,不是产品边界**;默认不挂 = 通用电脑助手。
> - **架构地图/状态总览(先读这份)** → `docs/当前架构与状态-总览.md`(唯一当前架构入口:定位/内核/存储/桌面壳/网关/美国 relay/dataeye/媒体能力/今日进度/在建方向/owner 铁律)。
> - **服务器/部署** → `docs/服务器与部署-当前拓扑.md`。
> - **ts 内核详细规约** → `ts/CLAUDE.md` + `ts/AGENTS.md`(内核铁律:只认 Anthropic content-block、文件式存储、native sidecar 边界等)。
> - **施工进度矩阵** → `docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md`(§3.401/§3.405 有全 16 模块 cc 差异矩阵与本轮进度);**文档索引** → `docs/README.md`;**当前目标总纲** → `docs/plans/强-coding-agent-桌面外壳-阶段目标.md` + `docs/当前目标与文档口径-2026-07-07.md`。
> - 🧑‍✈️ **owner 最高做主**:技术栈/架构/库选型一切 owner 拍板、不锁死。参考代码(cc-haha)可直接复制/抄/移植/改写、好库直接用,别硬造轮子。助手只提示风险**一次**再照办。唯一不松 = 产品对终端用户的安全红线(见末节)。

## 项目简介

**装在用户自己电脑上的桌面软件,是一个通用本机 AI Agent。** 用户一句话 → AI 大脑(ReAct 循环)自主调工具把事做完:读写/改本机文件、跑命令、上网查抓、生图、列任务清单、派子代理。面向不懂技术的用户:说大白话、给能直接用的结果。

**台球房运营**只是一个**可挂载的领域知识包**(`billiards`):用户在输入框选"台球运营专家"→ SessionStart 挂领域包(领域上下文 + 门店画像 + 店脑记忆 + 台球工具);默认不挂时就是通用电脑助手。

**形态 = 全本地 + 免登录单用户 + 全内置 key + 真 Agent:**
- **全本地 + 免登录单用户**:数据全在用户机器上;已删整套 SaaS 登录鉴权。
- **全内置 key**:盒子内置 owner 的模型 key,走网关藏 key、白标(不向客户端暴露底层模型),用户零配置开箱即用。BYOK 降为可选高级档,未启用回退内置 key。
- **真 Agent**:ReAct 循环自主调工具;权限五档(default/acceptEdits/plan/bypassPermissions/dontAsk)对齐 cc-haha;审批闸只卡对外/不可逆/花钱。

> 架构/目录/能力清单不在此重复,见 `docs/当前架构与状态-总览.md`(单一权威,防漂移)。

## 现状与待办(最新:2026-07-10)

> **当前真相以 `docs/当前架构与状态-总览.md` 为准,本节是摘要。** 老 Python 线的"商品化收官 / 真机验收 / 密钥搬 key / SQLite 兼容 / 完整优化清单"等整套遗留**已随 `server/` 删除、全部作废**,别再翻。

**头号方向 = 全方位对标 cc-haha、不做阉割版、能抄就抄。** 对标"方式"是硬口径:**内核直接照 cc 移植、发现分叉就掰回去**(替换非叠加,不是保留旧实现打补丁);唯一验收硬闸 = 行为对齐测试(刁钻边界判得跟 cc 一模一样)。产品层边界(白标命名/网关藏 key/免登录/审批只卡三类/台球包/生图/视频剪辑/UI 外观)故意保持我们自己的、不对标 cc。七条主线思路完整落地见总览 §一~§十。

**本会话(至 2026-07-10)已落地**:
1. **记忆四层注入**(领域包 + 门店画像 + 店脑记忆 + 安全红线)。
2. **台球 PPT 策展**(按 `~/Desktop/球房-PPT底本-本地存档/` PPT 底本在 TS 侧策展)。
3. **斜杠 = 技能底座**:`/台球` + 技能清单注入 + `/api/v1/agent/commands`。
4. **桌面基建 6 项**(壳生命周期/端口/杀 sidecar/原生菜单托盘/集中 IPC 白名单等)。
5. **前端交互批 1 + 批 2**(markdown / 代码卡片渲染)。
6. **permissions 输入层 + 输出层 read-ignore 过滤**。
7. **技能基建修复**:`create_skill` 写盘 + 三层技能加载 + skillify + 10 个 bundled 命令技能。
8. **GPT 生图异步根治 + 双服务器部署**(慢调用挪美国 relay,两台已部署验证全链路、未花钱;激活置 `QF_GPT_IMAGE_ASYNC=1`)。权威 `docs/plans/GPT生图异步化-根治方案-2026-07-09.md`。
9. **文档重写**:docs 主线重写为"全方位对标 cc-haha",过时文档 `git rm` 删除(不归档)。

> 更早(2026-07-09):两个生图模型接通 + 真机 bug 修复、服务器删光老 Python 台球全栈、cc-haha 对齐战役 P0 波(max_output_tokens 续写/resume/todo 过审;permissions 同族工具绕过、hooks 信任门 rework)。逐模块进度见迁移矩阵 §3.401/§3.405。

**在建/待办(详见总览 §九)**:右侧交互预览直接对标 cc、不留分叉(task#17)→ 前端后续批次(task#18)→ 配置/工作目录/会话 checkpoint 持久化(task#19)→ 生图人像质检/授权/spend 闸(task#11)→ 桌面基建余项(task#21)→ 自动更新发包 + dataeye 上报重接(task#13/#16)→ 命令搬运波 0-5(task#24)→ 分发前白标 scrub + 知识/guardrails 加密(task#22/#23,**打包前才做、开发期保留明文**)→ 台球知识重策展(task#12)。另有一份全维度盘点缺口清单在独立任务台账跟踪(横切缺口:web/多模态、后台执行原语、hooks/MCP 生态、安全洞、崩溃兜底、领域包可插拔、Windows 对等、数据生命周期、验证债等)。

**工作方式**:子代理实现 + 子代理对抗审查,主代理编排 + 决策;直接在 `main` 上施工。TS 内核以 `~/Desktop/cc-haha-ref` 为可执行规格,唯一验收硬闸是行为对齐 + 测试锁边界。

## 核心架构原则

1. **通用 Agent 为默认,领域知识可挂载** — 首启默认通用 coding Agent;用户选"台球运营专家"才经 SessionStart hook 挂 `billiards` 领域包(领域上下文 + 门店画像 + 店脑记忆 + 台球工具)。安全红线独立于此、永远注入。
2. **真 Agent(ReAct + 工具 + 审批闸)** — `ts/src/` 内核真循环(think→调工具→结果回灌→再推理),真 function calling;本机文件/命令/网络/生图/子代理等工具实打实执行;工具报错不崩循环、错误文本回灌让模型自救。
3. **内核只认 Anthropic content-block** — 消息格式统一 content-block,OpenAI 兼容端点走 proxy 双向翻译层;工具 use/result 严格配对。
4. **文件式存储,无 SQL** — JSONL transcript + JSON 元信息(对齐 cc-haha)。
5. **全内置 key(走网关藏 key、白标)** — 客户端只带可吊销 app 令牌,真 key 只在服务器网关;不向客户端暴露底层模型/供应商。
6. **权限五档 + 审批闸只卡三类** — default/acceptEdits/plan/bypassPermissions/dontAsk;审批只卡**对外触达 / 不可逆 / 花钱**;bypassPermissions 仍不能越过 forceConfirm/用户交互/硬拒红线。做成品给用户看、读写本机文件(带备份)不算对外,直接做。
7. **本地文件有护栏** — 沙箱 + 改文件前自动备份可回滚;`..` 越界抛错;危险命令(删根/提权/格式化)直接拒。
8. **动手前先看大厂 harness 怎么做** — 以 `~/Desktop/cc-haha-ref` 为可执行规格,能抄就抄;参考全景见 `docs/references/AI-Agent-harness全景与参考.md` + `docs/references/竞品拆解/`。

## 开发规范

### 前端(桌面 UI · `ts/desktop/renderer/` vanilla JS)
- **交互全方位对标 cc-haha**(只抄交互);**颜色/文案照抄 WorkBuddy(腾讯 CodeBuddy)**:token 表见 `docs/references/竞品拆解/02`、文案见 `03`;UI 长相不必学 cc。
- 设计规范见 `docs/design/桌面Agent-macOS设计规范.md`(写码最高优先参考);设计图 `docs/design/mockups/`。
- 权限用词照搬 cc(逐项确认/自动接受修改/跳过确认);审批卡含原因 what/why/impact + 破坏性警告 + 卡内 diff。

### 后端(`ts/src/` · Bun/TS)
- 内核循环 / 权限 / 工具 / hooks / skills / mcp / tasks / 压缩 / steering / plan 详细规约见 `ts/CLAUDE.md` + `ts/AGENTS.md`。
- 存储走文件式(JSONL transcript + JSON meta),别引 SQL。
- 加任何新依赖/模型/二进制时,当场想"它怎么进 DMG/EXE"——凡分发给客户要用的东西(依赖/本地模型权重/ffmpeg 二进制)一律打进安装包,开箱即用不联网不自装。
- native 能力(whisper 转写等)走 Node 原生 sidecar,边界见 `ts/CLAUDE.md`。

## 台球运营专家(可挂载领域包 · PPT-only)

> 这是"台球运营专家"挂载时才生效的领域知识;通用 Agent 默认不挂。安全红线独立于此、永远注入。台球知识正按 owner 桌面 `~/Desktop/球房-PPT底本-本地存档/` **在 TS 侧重新策展**(task#12,老 Python YAML 已随 server/ 删除,只作结构参考)。

- **只保留 PPT 原件全文里有据的**运营逻辑/内容;PPT 没有的(借鉴别处/模型衍生/凭空杜撰)一律删。**唯一例外 = 安全红线**(助教自爱不越界·不实际性交易 / 门店不当庄不抽水不定盘口 / 未成年保护)。
- **不消毒、贴一线**:PPT 在册的真实打法(美女人设 / 异性情绪价值 / 擦边引流 / 交友软件获客 / 红包 / 超休 / 追分氛围 / 助教免费体验)照实落地,不因"听着擦边"误当红线。
- **品牌/来源铁律**:PPT 原件全文中真实出现的平台 / 获客渠道 / 器材名一律保留、不脱敏、不删——平台名(美团 / 抖音 / 快手 / 小红书 / 大众点评…)、获客渠道含交友社交软件(探探 / 陌陌 / Soul / 积目…)、器材品牌(乔氏 / 星牌…)都是台球运营行业必需真实信息;进白名单确保守卫测试不误杀。禁止出现 PPT 全文之外凭空捏造的无关第三方品牌。
- **架构 = 大厂标准 B**:精炼 PPT 核心 + 让模型自己延伸场景 + 即时检索 RAG(嵌入走 Node sidecar);不替模型穷举预建场景。
- **POS 只读**:不做收银/计费/灯控/会员充值,只读导出报表诊断;术语大白话。

## 开发 / 测试(当前栈 = `ts/`)

```bash
bash scripts/test.sh               # = cd ts && bun test + bun run typecheck
cd ts && bun test                  # 全量单测(发现 ts/**/*.test.ts)
cd ts && bun test src/harness/loop.test.ts   # 跑单文件
cd ts && bun run typecheck         # tsc --noEmit
cd ts && bun run build:sidecar     # bun build --compile 出本机 sidecar 二进制
cd ts && bun run smoke:sandbox     # 离线 smoke(sandbox/sqlite/native/model/agent-tools)
cd ts && bun run desktop:dev       # Electron 壳拉起 sidecar(需先 build:sidecar)
cd ts && bun run desktop:dist      # electron-builder 出安装包(mac dmg / win nsis)
```
> 老 `server/`(FastAPI/pytest)、老 `web/` vitest/tsc、`desktop/` 拉 Python 的 dev 流程、`scripts/build_coupling_map.mjs` 均已退役,不是现役命令。

## 关键约束(铁律 · 违反即破坏产品)

1. **安全红线永远注入**(与挂没挂领域无关、用户偏好松不开):不营销实际性交易、不帮开赌场/坐庄抽水等刑事级犯罪、未成年保护、法律文书提示专业把关、不照搬绝对化广告词。
2. **不做阉割版**:全方位对标 cc-haha、能直接抄 cc 代码就抄;唯一验收硬闸是行为对齐 + 测试锁边界。视频剪辑是自家产品不对标 cc;颜色/文案抄 WorkBuddy;交互抄 cc。
3. **全内置分发**:内置 owner 的 key(走网关藏 key、白标);凡分发给客户要用的东西一律打进 DMG/EXE,开箱即用。体积大无所谓、运行得好优先。
4. **审批闸只卡对外/不可逆/花钱**:不自动群发/私信;**生图不弹审批直接出图**(owner 去钱味);**不设消费上限**(owner 本轮);做成品给用户看、读写本机文件(带备份)不算对外,直接做。
5. **本地文件有护栏**:沙箱 + 改文件前自动备份可回滚;危险命令直接拒;`..` 越界抛错。
6. **内核只认 content-block + 用库**:OpenAI 端点走 proxy 翻译;成熟第三方库/SDK 直接引用(如 MCP 用官方 `mcp` SDK),别为"少依赖"硬造轮子。
7. **台球知识 PPT-only、禁编造**:只留 PPT 原件全文有据的;PPT 真实出现的平台/渠道/器材名进白名单不脱敏。
8. **改前看牵连、改后查回头 + 完成前真测真读**:动手前搜清这块被谁用、连着啥;改完跑全量回归(不只改的那块),关键连接点没测试盖到就补一个;声称改好前真跑(`bun test`/`typecheck`/Playwright),别只报断言,出错当场认、绝不编造。
9. **文档边开发边维护**:见下方规约。

## 文档维护规约(唯一入口 CLAUDE.md · 防文档越堆越乱)

**1. 唯一入口 = `CLAUDE.md`**:架构/规范/铁律/现状与待办都在这一份 + `docs/当前架构与状态-总览.md` 架构地图,不另开"交接文档"分流权威。

**2. 文档分两类**:
- **活文档**(长期维护的唯一真相源):`docs/当前架构与状态-总览.md`、`docs/服务器与部署-当前拓扑.md`、`docs/README.md`、`docs/product-brain/*` 域知识、`docs/references/*`、`docs/design/*`、`docs/plans/` 里今日权威计划。改了对应东西就同步它。
- **任务文档**(先落文档再开窗口产出的 spec/计划):放 `docs/plans/`,一次性,工作落地后就该退场。

**3. 每份文档顶部一行状态 banner(紧跟标题)**:
- `> 📌 状态:✅现行 · 最后核对 2026-07-09`(活文档;核对过更日期)
- `> 📌 状态:🚧进行中 · 任务〈名〉`(spec 正在被执行)
- `> 📌 状态:❌已否决 · 仅参考`

**4. ⚠️ 过时的直接删、不归档**(owner 硬口径,2026-07-09):归档区太乱,已整个删除。任务文档工作落地后 / 被新文档取代 / 变历史包袱,**直接 `git rm`**(git 历史可回查),不再挪 `docs/归档/`。写新文档取代旧的,旧的当场删,别让两份并存。

**5. 现行 `docs/` 只留活文档**:正文只留反映当前架构/现状的活文档;失真的旧清单/被超越的进度表/已完成任务的 spec 一律删。

**6. 验收报告不进仓库**:写到仓库外 `~/Desktop/球房-验收报告/`,不 commit。
