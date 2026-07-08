# 桌面版 AI Agent（通用本机 AI 执行助手）

> **⚠️ 2026-07-09 重大变更:老 Python 线(`server/`)已整体退役删除。** 当前唯一代码栈是 **`ts/`**(Bun/TS 内核,cc-haha 标准 coding-agent 循环)。老 `web/` 前端 + `desktop/` 打包入口(拉起 Python)仍在,属"批3 成栈切换"单独处理(切成 ts/ 后端 + ts-desktop 前端后一并退役)。**下方描述 Python 架构(`services/agent`、`api/v1`、`compose_agent_system_prompt`、FastAPI/pytest、店脑 Python 实现、代码流向地图 server/api/v1 链路)的章节都是历史,已不反映现状**——当前权威入口是 `docs/plans/强-coding-agent-桌面外壳-阶段目标.md` + `docs/当前目标与文档口径-2026-07-07.md` + `docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md`(§3.401 有全 16 模块 cc 差异矩阵与本轮进度)。台球领域包知识 YAML 随 server/ 一并删除,以后在 TS 侧重新策展。本文件的 Python 章节待后续统一重写。

> **🧭 新会话先在这定位（权威入口，按此为准）：**
> - **这是什么**：装在用户电脑上的**通用 AI Agent**——能读写/改本机文件、跑命令、上网查抓、生图、列清单、派子代理，实打实把活干完。对标 Claude Code 的本机执行助手。**台球房运营**是**可 `@挂载` 的领域知识库**（`knowledge_packs=["billiards"]`），不是产品边界。
> - **接手先读**：本文件就是唯一入口——读完这段导航，直接跳下方「现状与待办」节（上下文 + 已完成 + 待办）。
> - **当前路线** → `docs/plans/TS-harness-重构-主开发文档-2026-07-05.md`（当前施工主文档：`ts-harness-rewrite` = Claude Code imitation branch，先把 Claude Code/cc-haha 内核能力搬透，再替换旧 Python 产品）；`docs/plans/通用Agent改造-0到6路线图.md` 是长期愿景。
> - **看懂产品/架构事实** → `docs/桌面版AI-Agent-产品形态/README.md`（壳/脑/知识/数据流/桌面专属 vs 共享/全内置 key 边界，含目录结构权威清单）。
> - **改前必看跨模块影响** → `docs/耦合地图与改动检查清单.md`；**文档索引** → `docs/README.md`。
> - ⚠️ **与原仓库关系**：本仓库（`billiards-desktop-agent`）和云端 `billiards-ai-ops` **共享大量代码**（`server/`/`web/`/`prompts/` 基本共享）。桌面专属的只有 Electron 壳（`desktop/`）+ Agent 大脑（`services/agent/`）+ 桌面 UI（`web/src/components/desktop/`）+ 模型 key 内置守卫 + 本地 SQLite。**改共享逻辑两仓库会漂移，注意同步。**
> - ⚠️ **项目 auto-memory 不在本路径**（原记忆按旧文件夹路径存）。关键上下文/教训以本文件为准（含下方「现状与待办」节）。
> - 🧑‍✈️ **owner 最高做主**：技术栈/语言/架构/库选型一切 owner 拍板、不锁死（现状 Electron+FastAPI+SQLite+Next.js，但"现状≠限制"，要换随时换）。参考代码(cc-haha/Claude Code)可直接复制/抄/移植/改写、好库直接用，别硬造轮子。助手只提示风险**一次**再照办，不设规矩挡他。唯一不松 = 产品对终端用户的安全红线（见末节）。

## 项目简介

**装在用户自己电脑上的桌面软件，是一个通用本机 AI Agent。** 用户一句话 → AI 大脑（ReAct 循环）自主调工具把事做完：读写/修改本机文件、跑命令、上网查资料抓网页、生成图片、列任务清单、把大任务派给子代理。面向不懂技术的用户：说大白话、给能直接用的结果。

**台球房运营**只是一个**可挂载的台球运营专家**：前端选择「台球运营专家」→ `knowledge_packs:["billiards"]`/`billiards_mode=True` → 才追加台球运营上下文 + 门店画像 + 店脑记忆 + 台球工具集；**默认不挂时就是个通用电脑助手**。

**形态 = 全本地 + 全内置(模型 key 打包) + 真 Agent：**
- **全本地**：Electron 壳 + 本地 FastAPI + 本地 SQLite + 加密知识库（`prompts.enc`）。数据全在用户机器上，不连云。
- **全内置 key**：盒子**内置 owner 自己的模型 key**（文字/生图等 OpenAI 兼容端点），**用户零配置、不填 key**，开箱即用。⚠️ 内置 key 须在各平台后台设**消费上限**防被扒盗刷；海外模型（GPT Image-2）国内仍需"国外出口"。CD/Seedance 2.0 这类模型直接生成视频链路已删除,不再保留视频生成模型 key/配置。详见 `docs/归档/待改清单-真机验收与打包-2026-06-23.md` 专题D（历史清单，约八成已落地，已归档仅供回查）。
- **真 Agent**：ReAct 循环自主调工具；权限/审批按 cc-haha 五档对齐:default 默认询问本机文件写改,acceptEdits 自动接受可逆文件修改,bypassPermissions 仍不能越过 forceConfirm/用户交互/硬拒红线;对外触达、花钱、不可逆动作继续走审批闸。

> 技术栈、目录结构、已落地能力清单：见根 `README.md` + `docs/桌面版AI-Agent-产品形态/README.md`（单一权威，不在此重复以免漂移）。
> ⚠️ **大陆调不了 OpenAI**，生图主走国内模型（硅基流动 OpenAI 兼容 / 通义万相 native 异步 / 即梦）。`resolve_image_kind(base_url)` 按端点路由到对应适配器。

## 现状与待办（最新：2026-07-05/06 · 换 TS 全量重写、替代 Python）

> **🎯 最新战略方向（2026-07-07 · owner 拍板并校准）**：`docs/plans/TS-harness-重构-主开发文档-2026-07-05.md`——当前直接在 `main` 上做 Claude Code imitation / cc-haha 内核移植。目标不是“做一个像 Agent 的壳”，而是把 Claude Code 那套创造能力地基搬透：Anthropic content-block、工具配对、权限、plan/todo/reminder/steering、压缩/轨迹/打转、skills/subagents/hooks/MCP、改文件回滚、内容管道等。**内核以 `~/Desktop/cc-haha-ref` 为可执行规格；该仓库 LICENSE 允许 use/copy/modify/distribute/publish copies,所以源码/架构/边界测试可直接复制/抄/移植/改写；唯一验收硬闸是行为对齐。**前端、业务、台球 pack、生图视频、免登录内置 key 仍按我们自己的产品文档做。✅ **owner 2026-07-05 拍板:TS 版 = 替代（直接重写整个软件到"Mac+Windows 直接可用"终态，前端也在本轮、用我们自己的小白设计），下面「商品化收官」等 Python 线冻结/退场、转历史。**
>
> **📦 Python 产品线已冻结、转历史**（被 TS 替代）：原「商品化收官」等已归档（`docs/归档/商品化收官-总开发文档-2026-07-03.md`），**作废、仅回查**。⚠️ **下方"现状 / 卡上线 / 待 owner 拍板 / P0 真机验收 / 上一轮优化"整段都是 Python 线遗留、随之作废**——其中真机验收 / 内置 key / 首启不崩 / 沙箱 / 知识库解密 / 白标等**要求已并入 TS 主文档 §10（试用就绪）+ W14**，照那份走，别再翻这套。

**现状**：功能面已齐、代码全在本地 `main`——视频创作工作区 V2（真实素材剪辑 → 大白话反馈 → 重调，模板渲染复用自带 Chromium）、生图编辑台（GPT + 火山 Seedream 双模型，改图/局部重绘/换比例）、真 key 收网关（客户端只带可吊销令牌）、运行中插话纠偏（Claude Code 式 steering）、MiMo 适配五连修（压缩/店脑救活/缓存可观测）、全仓两轮审查（7 模块）+ 三波修复（12 子代理）+ 7 路复扫，全部合入 `main`。后端 `cd server && uv run pytest tests/ -q` 全绿（1377 passed）；前端 `cd web && npx tsc --noEmit` 全过。代码已全部推上 origin（2026-07-03 核实 0 未推；⚠️ 历史中旧密码/资料因此也在 GitHub，密钥轮换+历史重写优先级提高，见商品化收官文档 G1）。详细总账在仓库外 `~/Desktop/球房-验收报告/`（《全仓七路审查-2026-07-02》+《全链路修复与复扫-总报告-2026-07-02》，按文档维护规约不进仓库）。

**卡上线的两件事**：① 真机打包验收没跑全（见下方 P0 清单）；② 服务器搬 key（按 `docs/plans/密钥收网关-部署清单-2026-07-02.md` 把真 key 填进网关 `gw.env`、发 app 令牌）。

**待 owner 拍板**（2026-07-02 修复总报告遗留，别重复排查）：删除死代码/死依赖清单、服务器搬 key + 轮换 PG 密码、git 历史重写、真机验证清单排期。旧 Python Agent 付费评测入口已退场，Agent 循环行为回归统一走 TS 测试和 `bun run smoke:agent-tools`。

### P0 · 真机端到端验收（最卡，上线前最后一关）
代码都只过了编译/单测层，**没在真盒子上用真 key 跑过一次**。要做：打包出安装包（Windows nsis / Mac dmg）→ 装到全新机器 → 开箱即用（内置 key，不用填）→ 走完整链路（写文案/做海报/剪视频/改本地报表）。重点验：
1. 海报/Logo/二维码生成能落盘（`UPLOAD_DIR` 已指到 userData 可写目录，要装到 `/Applications` 真验）
2. 干净 CI 出包（非 dev build）首启不崩（uploads 子目录不存在时不 mkdir 崩）
3. 慢机器首启不超时（`backend.js` 超时已放宽到 60s）
4. 首启即可用：内置 key 直接写一条文案，不用填 key、不报 503（BYOK 仅可选高级档）
5. canvas 报表只能改「老板当场选定」的文件（沙箱已加）
6. macOS 未签名 Gatekeeper/translocation 行为（可能要 ad-hoc 签名或引导右键打开）
7. 端口占用（8077 后端 / 3100 前端）兜底
8. 自动更新真链路（等上传凭据配好、CI 改 `--publish always`）
9. 平台发布 RPA 已退场：安装包不应包含 `publisher`/`publisher-bin`，preload 不暴露 `electron.publish`
10. 剪辑后台异步 + 完成通知（真机时实现 + 验证：点了立即返回 taskId + 子进程后台跑 + 完成经独立 channel 主动播报）
11. **MCP 客户端打包**：已从手写 stdio 换成官方 `mcp` SDK，`build_backend.js` 已加 `--collect-all mcp/jsonschema`，但 PyInstaller 有没有把依赖全带进包只有真机重打才能确认——装一个 MCP server 走一遍 `/mcp` 发现 + 调用
12. **免登录单用户真机验证**（最关键的行为变更）：已删整套 SaaS 登录鉴权，改成本地单用户免登录。真机务必验：① 全新安装首启自动 seed 了 owner+店；② 打开 App 直接进 `/dashboard/chat`、不卡登录页；③ `/auth/me` 拿到本地 owner；④ 设置抽屉里建/改店、跑一条生成全链路通；⑤ 老库（已注册过的）升级后 seed 跳过、不重复建
13. 另补新增验证项：视频渲染 worker 链路（装机包拉起自身二进制离屏渲染）、`/video-edit/localfile` 预览、插话纠偏体验、CI 包知识库能否解密（Fernet key 双源修复后首次出包必验）、Windows 口播字幕中文、文件夹对话框"新建"按钮

**上一轮「真机验收与打包」优化**（2026-06，已合并，历史清单见 `docs/归档/待改清单-真机验收与打包-2026-06-23.md`）：全内置 key 基座、GPT Image-2 美国机中转、代理直连绕开 Clash、知识库读导航、改文件 diff 展示、思考显示+深度思考开关、店脑记忆解绑、记忆管理面板等已落地；AI 模型生成视频已按新阶段目标删除,真实素材剪辑保留。

**工作方式**：当前主施工分支是 `ts-harness-rewrite`，它就是 Claude Code imitation branch；先在这个分支把内核质量打到可替换旧产品，再由 owner 决定合并 `main`、替换 Python 线。推不推 GitHub 由 owner 决定（默认只本地）。**TS 重写按"一窗一模块 + Superpowers"走**（见 TS 主文档 §4.5/§0.5-0.7/§9 执行说明）；旧的"模块级 git worktree 修复流程"是 Python 轮次的做法，不作为当前主线。

## 核心架构原则

1. **通用 Agent 为默认，领域知识可挂载** — `compose_agent_system_prompt`（`api/v1/agent.py`）三段拼装：`_GENERIC_BASE_PROMPT`（通用助手身份，永远注入）+ `_SAFETY_REDLINE`（安全红线，永远注入、与挂没挂领域无关）+ `_BILLIARDS_PERSONA`（仅 `billiards_mode` 时追加）。工具也分层：`general_registry()` vs `billiards_registry()`，由 `_build_agent_registry(billiards_mode)` 选。
2. **真 Agent（ReAct + 工具 + 审批闸）** — `services/agent/loop.py` 真循环(think→调工具→结果回灌→再推理)，真 function calling。本机文件/命令/网络/生图/子代理等工具实打实执行。
3. **全内置模型 key（owner 提供）** — 模型 key 内置打包、用户零配置；`factory` 返回内置 key + 各自 base_url。⚠️ 内置 key 设消费上限防盗刷（原"纯 BYOK·空 key 不回退"逻辑作废，见待改清单专题D）。
4. **四层防御** — ① 权限模式(default/acceptEdits/plan/bypassPermissions/dontAsk)；② 工具 allow-ask-deny + 审批闸；③ 本地文件沙箱(改前备份)；④ 审批签名绑定 args。
5. **文件/对外/花钱动作按类别审批** — 本机文件写改属于 `file` 类,default 询问、acceptEdits 放行;生图等成本动作、发布/群发等对外动作、删数据等不可逆动作按 `spend/outreach/destructive` 类继续审批或强确认。绝不自动群发/私信。
6. **本地文件操作有护栏** — `local_tools` 沙箱（内容库 + 用户选定文件；`full_disk_access` 时放开）；`..` 穿越/越界抛错；写/改前自动备份。
7. **Prompt 与业务解耦** — 知识存 `prompts/` YAML（`{变量}` 占位），改 prompt 不改业务代码。`PromptEngine` 是单例 `get_prompt_engine()`。
8. **动手前先看大厂 harness 怎么做** — 实现 harness/agent 能力前，先看大厂（Anthropic/OpenAI/Google/微软/AWS + 国内字节/阿里/Kimi）的 agent/harness 架构与设计；业界共识「harness 就是产品」，我们做的正是它。全景+研究入口见 `docs/references/AI-Agent-harness全景与参考.md`；再对照 `~/Desktop/cc-haha-ref`（可抄）动手。

## 开发规范

### 前端（macOS 桌面 UI 是第一公民）
- Next.js App Router；交互组件加 `"use client"`；样式用 Tailwind 不写 CSS 文件（项目无 `cn` helper，用模板字符串）
- `useDesktop().isDesktop` 区分桌面/web；桌面页面用 `web/src/components/desktop/`
- API 统一走 `lib/api.ts`；SSE 流式用 `streamAgent`；useEffect 加 `cancelled` flag 防卸载后 setState；**副作用别放进 setState 更新函数**(StrictMode 会双跑)
- 设计语言：macOS 原生质感(无边框窗口毛玻璃 + SF 字体 + 中性主按钮/气泡 + 绿色小点缀,禁回流蓝色主体系)；权限用词照搬 Claude Code（逐项确认/自动接受修改/跳过确认）。设计规范见 `docs/design/桌面Agent-macOS设计规范.md`。

### 后端
- API 前缀 `/api/v1/`；Pydantic v2；async SQLAlchemy。**免登录单用户**：已删 SaaS 登录鉴权，`api/deps.py` 的 `get_current_user/get_current_store` 返回本地 seed 的唯一 owner/店
- **桌面用 SQLite**：UUID 列别传字符串(`db/types.py` 已兜)、PG 专属 SQL(jsonb/make_interval/advisory_lock/pg_insert)要按 `db.bind.dialect.name` 分支兜底，否则 SQLite 崩。建库走 `db/init_local.py` 的 `Base.metadata.create_all`（无 Alembic）。
- 上传/海报落点用 `UPLOAD_DIR`(指 userData 可写目录，app 包内只读)
- AI 调用结果写 `generations` 表；所有 Generation 查询加 `is_deleted == False`
- **多租户**：`core/tenant.py` 自动过滤只覆盖 generations/usage_quotas；其它带 store_id 的表靠手写 `.where(store_id==)`，漏写=跨店泄露
- **改接口后跑 `node scripts/build_coupling_map.mjs --write`** 刷新耦合地图接线表，否则 `ts/src/scripts/buildCouplingMap.test.ts` 红。
- **测试期用真 OpenAI key 联调生图/改图，别本机直连 `api.openai.com`**：本机若挂了本地代理（Clash 等），生图这类慢请求（gpt-image-2 编辑可能要等几分钟才有响应）会被代理隧道中途断线——但 OpenAI 那头其实已经生成完并扣费，图片结果传不回来、钱白花。已在美国 relay 服务器（`zzyppz.cn`）加了一条**测试专用**路由 `/relay/openai-test/`（与生产 `/relay/openai/` 完全隔离，2026-07-01 新加，owner 要求做成可长期复用的网关形态，不是单次任务专用）；具体 base_url/令牌/测试 key 记在 `server/.env.usrelay.local`（gitignored，本地已有，别再问 owner 要）。免费验证鉴权可用 `GET /relay/openai-test/v1/models`（不计费）。

### Prompt 模板（YAML）
- 必须有 `key:`；渲染类(knowledge/operation/copywriting/activity)还需 `template:`（缺它是 `render()` 时 KeyError）
- 加载器**故意宽松**(凡有 `key` 即登记)——fewshots/预设库是 `templates:`/`examples:` 不同结构，切勿加"必须有 template"校验
- **品牌/来源铁律（判据：PPT原件全文里有 = 保留）**：禁止出现「来源出处 / 文件名 / PPT原件全文之外凭空捏造的无关第三方品牌」；但**PPT原件全文中真实出现的平台 / 获客渠道 / 器材名一律保留、不脱敏、不删**——平台名（美团 / 抖音 / 快手 / 小红书 / 大众点评…）、获客渠道含交友社交软件（探探 / 陌陌 / Soul / 积目…）、器材品牌（乔氏 / 星牌…）都是台球运营的行业必需真实信息。**用户已拍板：只要PPT原件全文里出现的这类词，全部保留。** 这些词需进 `knowledge/term_whitelist.yaml` 白名单，确保 `test_knowledge_guardrails.py` 不误杀。

## 台球运营专家（可挂载领域包 · PPT-only）

> 这是「台球运营专家」挂载时才生效的领域知识；**通用 Agent 默认不挂它**。安全红线独立于此、永远注入。
> 核对底本（PPT 原文 + 硬规则对照16条带行号 + 亲验摘要）已移出仓库、开发者本地留存，不随产品分发；仓库内不保留任何第三方门店/来源名。模块化重构（L0/L1/L3 分层）依据见 `docs/知识库重构-架构与映射.md`。

- **只保留 PPT 原件全文里有据的**运营逻辑/内容；PPT 没有的（借鉴别处/模型衍生/凭空杜撰）一律删。**唯一例外 = 安全红线**（助教自爱不越界·不实际性交易 / 门店不当庄不抽水不定盘口 / 未成年保护）。
- **不消毒、贴一线**：PPT 在册的真实打法（美女人设 / 异性情绪价值 / 擦边引流 / 交友软件获客 / 红包 / 超休 / 追分氛围 / 助教免费体验）照实落地，不因「听着擦边」误当红线。
- **架构 = 大厂标准 B**：精炼 PPT 核心 + 让模型自己延伸场景 + 即时检索 RAG（bge-zh + `look_up_knowledge`）。**不替模型穷举预建场景。** 现 **57 knowledge + 72 operation** YAML，覆盖营销/客户运营/人才管理/数据分析。硬数字以本地留存的硬规则对照（16条带行号）为单一可信源。

## 开发 / 测试（当前栈 = `ts/`；老 Python/pytest 已退役）

```bash
# —— TS 内核快速门（当前唯一代码栈）——
bash scripts/test.sh               # = cd ts && bun test + bun run typecheck
cd ts && bun test                  # 全量单测(发现 ts/**/*.test.ts)
cd ts && bun test src/harness/loop.test.ts   # 跑单文件
cd ts && bun run typecheck         # tsc --noEmit
cd ts && bun run build:sidecar     # bun build --compile 出本机 sidecar 二进制
cd ts && bun run smoke:sandbox     # 离线 smoke(sandbox/sqlite/native/model/agent-tools)

# —— 桌面(批3 成栈切换前:老 desktop 拉起 Python 已失效;ts-desktop 前端待建)——
cd ts && bun run desktop:dev       # 最小 Electron 壳拉起 sidecar(需先 build:sidecar)
```
> 老 `server/`(FastAPI/pytest)、老 `web/` 前端 vitest/tsc、`desktop/` 拉起 Python 的 dev 流程、
> `scripts/build_coupling_map.mjs`(耦合地图,映射 web→Python)均已退役,不再是现役命令。

## 代码流向地图（一次对话怎么跑完，跨文件读才看得懂）

1. **前端发起**：`web/src/components/desktop/`(composer) → `web/src/lib/api.ts` 的 `streamAgent`(SSE) → `POST /api/v1/agent`。
2. **组装大脑**（`server/api/v1/agent.py`）：`compose_agent_system_prompt` 三段拼装（通用身份 + 安全红线永远注入 + 仅 `billiards_mode` 追加台球人设）；工具选择 `billiards_registry() if billiards_mode else general_registry()`（`agent.py:262`，定义在 `services/agent/registry.py`）。
3. **ReAct 循环**（`server/services/agent/loop.py`）：同步 `run_agent_loop` / 流式 `run_agent_loop_stream` 共享状态机，只在"怎么调模型/怎么对外吐"分叉。一轮＝调模型 → 有 `tool_calls` 就逐个经 `_plan_tool_call`(审批闸判定 or 直接执行) → 结果作 `role:tool` 回灌 → 再调模型，直到收敛或 `max_turns` 兜底。工具报错不崩循环、错误文本回灌让模型自救。
4. **审批闸**：标 `requires_approval=True` 的工具（发布/群发/删数据等对外·不可逆动作）不在循环里直接跑，吐 `approval_request` 弹卡片，人确认后经 `POST /api/v1/agent/execute`（签名绑定 args）才执行。做成品给用户看 / 读写本机文件（带备份）不算对外，直接做。
5. **工具实现**：`services/agent/` 下 `tools.py`(运营) `local_tools.py`(本机文件·沙箱) `web_tools.py`(查抓) `image_tools.py`(生图) `computer_tools.py` `skills.py` `background_tools.py` `mcp_client.py` 等，由 `registry.py` 分层登记。
6. **模型出口**：`services/ai/factory.py` 返回内置 key + base_url；生图按 `resolve_image_kind(base_url)` 路由到 `services/ai/providers/`(硅基流动/通义万相/openai_image)。桌面高并发统一走 `gateway/app.ts`（Bun/TS 国内总闸·三层阀门·藏 key·客户端只带 app 令牌）。

## 关键约束（铁律 · 违反即破坏产品）

1. **安全红线永远注入**（`_SAFETY_REDLINE`，与挂没挂领域无关、用户偏好松不开）：不营销实际性交易、不帮开赌场/坐庄抽水等刑事级犯罪、未成年保护、法律文书提示专业把关、不照搬绝对化广告词。
2. **全内置（key + 依赖 + 模型 + 二进制 → 全打进安装包）**：内置 owner 的 key、用户不填（须设消费上限防盗刷）。**⚠️ 凡是分发给客户要用的东西——Python 依赖、本地模型权重（如 whisper）、ffmpeg/ffprobe 等二进制——一律打进 DMG/EXE，用户装完开箱即用、不联网、不自己装任何东西。装在开发机上不算数，没打进包 = 客户用不了（owner 2026-06-29 拍板）。** 加任何新依赖/模型/二进制时，当场就要想"它怎么进 DMG/EXE"，不能只 `pip/npm install` 完就算完。（原"纯 BYOK·不内置"铁律已废，见待改清单专题D）
3. **不自动触达**：不自动群发/私信，对外/花钱动作一律走审批闸；做成品给用户看、读写本机文件（带备份）不算对外，直接做。
4. **本地文件有护栏**：沙箱 + 改前自动备份可回滚；危险命令(删根/提权/格式化)直接拒；`..` 越界抛错。
5. **SQLite 兼容**：PG 专属 SQL/类型要按方言兜底，别让桌面崩。
6. **内核对齐 + 用库**：cc-haha/Claude Code 的行为和架构作为规格迁移，成熟第三方库/SDK 直接引用（如 MCP 客户端用官方 `mcp` SDK），别为"少依赖"硬造轮子。**体积/打包大小不是理由——owner 拍板「体积大无所谓、运行得好优先」（2026-06-29）**；只有依赖确实难维护/运行不稳/有许可问题时才自写。大模型权重（如本地 whisper）该上就上，按质量选不按体积省。
7. **挂载台球知识库时**：POS 只读（不做收银/计费/灯控/会员充值，只读导出报表诊断）；术语大白话；助教/擦边贴行业真实但守安全红线；生图 prompt 不主动塞中文文字/价格/Logo/二维码（用户显式填例外）；不用原生 `<select>`（用 CardSelect）。
8. **不做鸡肋死模板 + 用户视角**：功能用 AI 真智能(理解+扩写)，预设只是起点；验证前端操作真影响输出。
9. **改前看牵连、改后查回头 + 完成前真测真读**：动手前搜清这块被谁用、连着啥；改完跑全量回归（不只改的那块），关键连接点没测试盖到就补一个；声称改好前真跑（pytest/tsc/Playwright），别只报断言，出错当场认、绝不编造。
10. **文档边开发边维护**：见下方「文档维护规约」——每个窗口都照做，否则文档越堆越乱。

## 文档维护规约（唯一入口 CLAUDE.md · 防文档越堆越乱）

> 本项目节奏常是「先落一个 spec/计划文档 → 新开窗口照着改 → 文档留原地」。spec 稿 + 报告会越堆越多、没人回头清。下面这套让它**自清**：标记 → 自动唠叨 → 一键体检。

**1. 唯一入口 = `CLAUDE.md`**：架构/规范/铁律/现状与待办都在这一份，不再另开"交接文档"分流权威（历史上的 `交接-给新会话/现状与待办.md` 已并入本文件「现状与待办」节并删除）。

**2. 文档分两类，各有归宿**
- **活文档**（长期维护的唯一真相源）：`docs/README.md`（文档索引）、`docs/模块修复-遗留与注意事项.md`、`docs/端到端问题清单-按模块.md`、`docs/桌面版AI-Agent-产品形态/README.md`、`docs/耦合地图与改动检查清单.md`、`docs/product-brain/*` 等。改了对应东西就**同步**它。
- **任务文档**（先落文档再开窗口产出的 spec/实现计划）：放 `docs/plans/`。它是**一次性的**，工作合并后就该退场。

**3. 每份文档顶部一行状态 banner（紧跟标题）** —— 让下个窗口一眼看出新鲜度：
- `> 📌 状态:✅现行 · 最后核对 2026-06-26`（活文档；核对过就把日期更到今天）
- `> 📌 状态:🚧进行中 · 任务〈名〉`（spec 稿正在被某窗口执行）
- `> 📌 状态:📦历史 · 工作已落地(提交 abc1234)· 可删`（任务完成的 spec 稿）
- `> 📌 状态:❌已否决 · 仅参考`

**4. 完工即归档，不删**：一个任务文档对应的工作合并进 main 后，**合并的那个窗口必须**：① 把该 spec 稿标 `📦` 并挪进 `docs/归档/`（保留可回查，别 `git rm` 丢历史）；② 成果记进活台账（`docs/模块修复-遗留与注意事项.md`）；③ 同步 `docs/README.md` 索引。**代码合了但文档没归档 = 这活没完。**

**5. 取代即归档、别堆叠**：写新文档取代旧的，旧的当场挪 `docs/归档/`，别让两份并存（这正是"太乱"的根因）。

**6. 现行 `docs/` 保持精简**：正文只留反映当前架构/现状的活文档；历史记录（旧清单/被超越的进度表/已否决的设计稿）一律在 `docs/归档/` 回查，不再维护。

**7. 验收报告不进仓库**：报告写到仓库外 `~/Desktop/球房-验收报告/`，不 commit（仓库内 `球房-验收报告/` 已 gitignore）。

**8. 自动牙齿 + 两个一键 skill**：`.claude/settings.json` 的 SessionStart 钩子每开机自动跑 `scripts/doc_freshness.mjs`，把"标了可删却还在/久未核对"的文档注入上下文提醒你（清爽时静默）。`/整理归档` 一键把已完成/已否决的文档按 banner 挪进 `docs/归档/`（轻量、几分钟收尾）；拿不准哪些过时、要交叉验代码是否真落地 → 跑 `/文档体检`（深扫，出归档/删除候选）。
