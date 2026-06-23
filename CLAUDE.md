# 桌面版 AI Agent（通用本机 AI 执行助手）

> **🧭 新会话先在这定位（权威入口，按此为准）：**
> - **这是什么**：装在用户电脑上的**通用 AI Agent**——能读写/改本机文件、跑命令、上网查抓、生图、列清单、派子代理，实打实把活干完。对标 Claude Code 的本机执行助手。**台球房运营**是**可 `@挂载` 的领域知识库**（`knowledge_packs=["billiards"]`），不是产品边界。
> - **接手先读** `交接-给新会话/现状与待办.md`（上下文 + 已完成 + 待办）。
> - **当前路线** → `docs/plans/通用Agent改造-0到6路线图.md`（主路线图：做成通用偏代码 Agent、对标 Claude Code）+ `docs/plans/cc-haha功能矩阵-全搬对照.md`（配套进度）。
> - **看懂产品/架构事实** → `docs/桌面版AI-Agent-产品形态/README.md`（壳/脑/知识/数据流/桌面专属 vs 共享/纯 BYOK 边界，含目录结构权威清单）。
> - **改前必看跨模块影响** → `docs/耦合地图与改动检查清单.md`；**文档索引** → `docs/README.md`。
> - ⚠️ **与原仓库关系**：本仓库（`billiards-desktop-agent`）和云端 `billiards-ai-ops` **共享大量代码**（`server/`/`web/`/`prompts/` 基本共享）。桌面专属的只有 Electron 壳（`desktop/`）+ Agent 大脑（`services/agent/`）+ 桌面 UI（`web/src/components/desktop/`）+ 纯 BYOK 守卫 + 本地 SQLite。**改共享逻辑两仓库会漂移，注意同步。**
> - ⚠️ **项目 auto-memory 不在本路径**（原记忆按旧文件夹路径存）。关键上下文/教训以本文件 + 交接文档为准。
> - 🧑‍✈️ **owner 最高做主**：技术栈/语言/架构/抄不抄/用不用库一切 owner 拍板、不锁死（现状 Electron+FastAPI+SQLite+Next.js，但"现状≠限制"，要换随时换）。参考代码(cc-haha/Claude Code)可抄、好库直接用，别硬造轮子。助手只提示风险**一次**再照办，不设规矩挡他。唯一不松 = 产品对终端用户的安全红线（见末节）。

## 项目简介

**装在用户自己电脑上的桌面软件，是一个通用本机 AI Agent。** 用户一句话 → AI 大脑（ReAct 循环）自主调工具把事做完：读写/修改本机文件、跑命令、上网查资料抓网页、生成图片、列任务清单、把大任务派给子代理。面向不懂技术的用户：说大白话、给能直接用的结果。

**台球房运营**只是一个**可挂载的领域知识库**：前端 `@「台球行业知识库」` → `billiards_mode=True` → 才追加台球人设 + 门店画像 + 店脑记忆 + 台球工具集；**默认不挂时就是个通用电脑助手**。

**形态 = 全本地 + 纯 BYOK + 真 Agent：**
- **全本地**：Electron 壳 + 本地 FastAPI + 本地 SQLite + 加密知识库（`prompts.enc`）。数据全在用户机器上，不连云。
- **纯 BYOK**：盒子**不内置任何平台大模型 key**。用户自带文字/生图 key（任意 OpenAI 兼容端点），花自己的钱。**代码层强制**：`DESKTOP_LOCAL=1` 没配 key 即空 key、**绝不回退平台 key**。多供应商 CC-Switch 式快切。详见 `docs/product-brain/BYOK-门店自带模型-实现.md`。
- **真 Agent**：ReAct 循环自主调工具；**只有真对外/不可逆动作（发布/群发/私信、删数据）走审批闸**（弹卡片，人点确认才执行）。做出成品给用户看、读写本机文件（写改前自动备份、可回滚）都不算对外，直接做。

> 技术栈、目录结构、已落地能力清单：见根 `README.md` + `docs/桌面版AI-Agent-产品形态/README.md`（单一权威，不在此重复以免漂移）。
> ⚠️ **大陆调不了 OpenAI**，生图主走国内模型（硅基流动 OpenAI 兼容 / 通义万相 native 异步 / 即梦）。`resolve_image_kind(base_url)` 按端点路由到对应适配器。

## 核心架构原则

1. **通用 Agent 为默认，领域知识可挂载** — `compose_agent_system_prompt`（`api/v1/agent.py`）三段拼装：`_GENERIC_BASE_PROMPT`（通用助手身份，永远注入）+ `_SAFETY_REDLINE`（安全红线，永远注入、与挂没挂领域无关）+ `_BILLIARDS_PERSONA`（仅 `billiards_mode` 时追加）。工具也分层：`general_registry()` vs `billiards_registry()`，由 `_build_agent_registry(billiards_mode)` 选。
2. **真 Agent（ReAct + 工具 + 审批闸 + BYOK）** — `services/agent/loop.py` 真循环(think→调工具→结果回灌→再推理)，真 function calling。本机文件/命令/网络/生图/子代理等工具实打实执行。
3. **纯 BYOK，绝不内置平台 key** — `factory.get_image_config_for_store` 在 `DESKTOP_LOCAL=1` 没配即空 key、不回退平台；文字 provider 无 BYOK 落空 key → 友好 503。全仓无硬编码平台 key。
4. **四层防御** — ① 权限模式(逐项确认/自动接受修改/跳过确认)；② 工具 allow-ask-deny + 审批闸；③ 本地文件沙箱(改前备份)；④ 审批签名绑定 args。
5. **对外/花钱动作走审批闸** — 生图/发布等标 `requires_approval=True`，循环里不直接执行，吐 `approval_request` 弹卡片、人确认后经 `/agent/execute` 才跑。绝不自动群发/私信。
6. **本地文件操作有护栏** — `local_tools` 沙箱（内容库 + 用户选定文件；`full_disk_access` 时放开）；`..` 穿越/越界抛错；写/改前自动备份。
7. **Prompt 与业务解耦** — 知识存 `prompts/` YAML（`{变量}` 占位），改 prompt 不改业务代码。`PromptEngine` 是单例 `get_prompt_engine()`。
8. **动手前先看大厂 harness 怎么做** — 实现 harness/agent 能力前，先看大厂（Anthropic/OpenAI/Google/微软/AWS + 国内字节/阿里/Kimi）的 agent/harness 架构与设计；业界共识「harness 就是产品」，我们做的正是它。全景+研究入口见 `docs/references/AI-Agent-harness全景与参考.md`；再对照 `~/Desktop/cc-haha-ref`（可抄）动手。

## 开发规范

### 前端（macOS 桌面 UI 是第一公民）
- Next.js App Router；交互组件加 `"use client"`；样式用 Tailwind 不写 CSS 文件（项目无 `cn` helper，用模板字符串）
- `useDesktop().isDesktop` 区分桌面/web；桌面页面用 `web/src/components/desktop/`
- API 统一走 `lib/api.ts`；SSE 流式用 `streamAgent`；useEffect 加 `cancelled` flag 防卸载后 setState；**副作用别放进 setState 更新函数**(StrictMode 会双跑)
- 设计语言：macOS 原生质感(无边框窗口毛玻璃 + SF 字体 + #007AFF)；权限用词照搬 Claude Code（逐项确认/自动接受修改/跳过确认）。设计规范见 `docs/design/桌面Agent-macOS设计规范.md`。

### 后端
- API 前缀 `/api/v1/`；Pydantic v2；async SQLAlchemy。**免登录单用户**：已删 SaaS 登录鉴权，`api/deps.py` 的 `get_current_user/get_current_store` 返回本地 seed 的唯一 owner/店
- **桌面用 SQLite**：UUID 列别传字符串(`db/types.py` 已兜)、PG 专属 SQL(jsonb/make_interval/advisory_lock/pg_insert)要按 `db.bind.dialect.name` 分支兜底，否则 SQLite 崩。建库走 `db/init_local.py` 的 `Base.metadata.create_all`（无 Alembic）。
- 上传/海报落点用 `UPLOAD_DIR`(指 userData 可写目录，app 包内只读)
- AI 调用结果写 `generations` 表；所有 Generation 查询加 `is_deleted == False`
- **多租户**：`core/tenant.py` 自动过滤只覆盖 generations/usage_quotas；其它带 store_id 的表靠手写 `.where(store_id==)`，漏写=跨店泄露
- **改接口后跑 `python3 scripts/build_coupling_map.py --write`** 刷新耦合地图接线表，否则 `test_coupling_map_fresh.py` 红。

### Prompt 模板（YAML）
- 必须有 `key:`；渲染类(knowledge/operation/copywriting/activity)还需 `template:`（缺它是 `render()` 时 KeyError）
- 加载器**故意宽松**(凡有 `key` 即登记)——fewshots/预设库是 `templates:`/`examples:` 不同结构，切勿加"必须有 template"校验
- **品牌/来源铁律（判据：PPT原件全文里有 = 保留）**：禁止出现「来源出处 / 文件名 / PPT原件全文之外凭空捏造的无关第三方品牌」；但**PPT原件全文中真实出现的平台 / 获客渠道 / 器材名一律保留、不脱敏、不删**——平台名（美团 / 抖音 / 快手 / 小红书 / 大众点评…）、获客渠道含交友社交软件（探探 / 陌陌 / Soul / 积目…）、器材品牌（乔氏 / 星牌…）都是台球运营的行业必需真实信息。**用户已拍板：只要PPT原件全文里出现的这类词，全部保留。** 这些词需进 `knowledge/term_whitelist.yaml` 白名单，确保 `test_knowledge_guardrails.py` 不误杀。

## 台球领域知识库（可挂载领域包 · PPT-only）

> 这是 `@「台球行业知识库」` 挂载时才生效的领域知识；**通用 Agent 默认不挂它**。安全红线独立于此、永远注入。
> 核对底本（PPT 原文 + 硬规则对照16条带行号 + 亲验摘要）已移出仓库、开发者本地留存，不随产品分发；仓库内不保留任何第三方门店/来源名。模块化重构（L0/L1/L3 分层）依据见 `docs/知识库重构-架构与映射.md`。

- **只保留 PPT 原件全文里有据的**运营逻辑/内容；PPT 没有的（借鉴别处/模型衍生/凭空杜撰）一律删。**唯一例外 = 安全红线**（助教自爱不越界·不实际性交易 / 门店不当庄不抽水不定盘口 / 未成年保护）。
- **不消毒、贴一线**：PPT 在册的真实打法（美女人设 / 异性情绪价值 / 擦边引流 / 交友软件获客 / 红包 / 超休 / 追分氛围 / 助教免费体验）照实落地，不因「听着擦边」误当红线。
- **架构 = 大厂标准 B**：精炼 PPT 核心 + 让模型自己延伸场景 + 即时检索 RAG（bge-zh + `look_up_knowledge`）。**不替模型穷举预建场景。** 现 **57 knowledge + 72 operation** YAML，覆盖营销/客户运营/人才管理/数据分析。硬数字以本地留存的硬规则对照（16条带行号）为单一可信源。

## 开发 / 测试

```bash
# 测试(快速门，不花钱不联网)
cd server && uv run pytest tests/ -q

# 桌面开发
cd desktop && npm install && npm run dev   # Electron 起壳 + 本地后端 + 本地前端
# 打包(CI): .github/workflows/desktop-build-win.yml → PyInstaller 后端 + electron-builder nsis
```

## 关键约束（铁律 · 违反即破坏产品）

1. **安全红线永远注入**（`_SAFETY_REDLINE`，与挂没挂领域无关、用户偏好松不开）：不营销实际性交易、不帮开赌场/坐庄抽水等刑事级犯罪、未成年保护、法律文书提示专业把关、不照搬绝对化广告词。
2. **纯 BYOK**：绝不内置/泄漏任何平台大模型 key（`DESKTOP_LOCAL=1` 没配即空 key、不回退）。
3. **不自动触达**：不自动群发/私信，对外/花钱动作一律走审批闸；做成品给用户看、读写本机文件（带备份）不算对外，直接做。
4. **本地文件有护栏**：沙箱 + 改前自动备份可回滚；危险命令(删根/提权/格式化)直接拒；`..` 越界抛错。
5. **SQLite 兼容**：PG 专属 SQL/类型要按方言兜底，别让桌面崩。
6. **可抄 + 用库**：cc-haha/Claude Code 参考代码可直接抄用搬进项目；成熟第三方库/SDK 直接引用（如 MCP 客户端用官方 `mcp` SDK），别为"少依赖"硬造轮子。只有依赖确实笨重/有打包风险时才自写。
7. **挂载台球知识库时**：POS 只读（不做收银/计费/灯控/会员充值，只读导出报表诊断）；术语大白话；助教/擦边贴行业真实但守安全红线；生图 prompt 不主动塞中文文字/价格/Logo/二维码（用户显式填例外）；不用原生 `<select>`（用 CardSelect）。
8. **不做鸡肋死模板 + 用户视角**：功能用 AI 真智能(理解+扩写)，预设只是起点；验证前端操作真影响输出。
9. **文档边开发边维护**：架构地图/真实性核对/交接文档/本文件过时即改。
