# 球房运营 AI 助手 · 桌面版 AI Agent

> **🧭 新会话先在这定位（权威来源，按此为准）：**
> 1. **这是「桌面版台球房运营 AI Agent」的独立仓库**（`billiards-desktop-agent`），从云端 web SaaS 仓库（`billiards-ai-ops`）的 `feat/desktop-agent` 分支独立出来。**默认分支 `main` = 当前桌面产品全部代码。**
> 2. **接手先读 `交接-给新会话/现状与待办.md`**（整个上下文 + 已完成 + 还要做什么，专为新 Claude Code 会话写）。
> 3. **想全看懂产品形态 → `docs/桌面版AI-Agent-产品形态/README.md`**（壳/脑/知识/数据流/桌面专属 vs 共享/纯 BYOK 边界）。
> 4. **知识库真实性**：已对齐台球行业真实运营逻辑；核对底本（PPT 原文等）已移出仓库、开发者本地留存，不随产品分发，仓库内不保留任何第三方门店/来源名。
> 5. **改前必看跨模块影响 → `docs/耦合地图与改动检查清单.md`**。
> 6. ⚠️ **与原仓库的关系**：本仓库和 `billiards-ai-ops` **共享大量代码**（后端 `server/` 基本共享、前端 `web/` 也共享、知识库 `prompts/` 共享）。桌面专属的只有 Electron 壳（`desktop/`）+ Agent 大脑（`services/agent/`）+ 桌面 UI（`web/src/components/desktop/`）+ 纯 BYOK 守卫 + 本地 SQLite。**改共享逻辑两个仓库会漂移，需注意同步。**
> 7. ⚠️ **项目 auto-memory 不在本路径**：原项目的记忆是按原文件夹路径存的，本文件夹是新路径、新会话没有那些记忆。**关键上下文/教训都已写进本文件 + 交接文档**，以此为准。
> 8. 📁 **docs/ 已清理**：删掉了云端 web 时代/别分支/被 PPT原件全文取代的旧文档，只留桌面 + 真实运营相关。文档导航见 `docs/README.md`。

## 项目简介

**装在台球房老板自己电脑上的桌面软件**，做 AI 运营管家。帮老板/店长/员工完成文案、活动、海报、话术、诊断、约客、社群运营等日常运营工作——**不是**收银/计费/灯控/会员充值系统。

**形态 = 全本地 + 纯 BYOK + 真 Agent：**
- **全本地**：Electron 壳 + 本地 FastAPI + 本地 SQLite + 加密知识库（`prompts.enc`）。门店数据全在老板机器上，不连云。
- **纯 BYOK**：盒子**不内置任何平台大模型 key**。老板自带文字/生图 key，花自己的钱、自担成本并发。**代码层强制**：`DESKTOP_LOCAL=1` 没配 key 即空 key、**绝不回退平台 key**。
- **真 Agent**：老板一句话 → AI 大脑（ReAct 循环）自主调运营工具完成任务；花钱/对外动作走**审批闸**（弹卡片，人点确认才执行）。绝不自动群发/私信。

## AI 模型配置（纯 BYOK 三态）

| 用途 | 怎么来 |
|------|------|
| 文字模型 | **老板自带**（任意 OpenAI 兼容端点：DeepSeek / 硅基流动 / 火山 / MiMo…），`byok_*` 字段，`core/crypto.py` Fernet 加密落本地 |
| 生图模型 | **老板自带**（国内可用：硅基流动 Kolors / 通义万相 / 即梦 / gpt-image…），`byok_image_*` 字段，`factory.get_image_config_for_store` 按门店路由 |
| 多供应商快切 | CC Switch 式：存多套 key + active 指针，预设卡片一键切换，原子写 + 自动备份 + 永留一个可用配置 |

⚠️ **大陆调不了 OpenAI**，生图主走国内模型（硅基流动 OpenAI 兼容 / 通义万相 native 异步 / 即梦）。`resolve_image_kind(base_url)` 按端点路由到对应适配器。

## 技术栈

- **外壳**：Electron（`desktop/`）
- **后端（本地）**：Python 3.12 + FastAPI + SQLAlchemy + **SQLite（aiosqlite）**；`db/init_local.py` 建库 + 老库平滑补列
- **前端**：Next.js 14 + React 18 + TypeScript + TailwindCSS（macOS 桌面 UI；`useDesktop().isDesktop` 区分桌面/web）
- **本地语义**：bge-zh（fastembed/onnxruntime）做 RAG
- **知识加密**：`prompt_pack.py` 把 YAML 打成 `prompts.enc`，运行时 `sys._MEIPASS` 定位解密
- **打包**：PyInstaller（后端）+ electron-builder（壳），CI 出 Windows nsis / Mac dmg

## 项目结构（桌面专属为主）

```
desktop/src/                 Electron 壳
  main.js        主进程：建窗口(macOS 红绿灯/毛玻璃)、起后端、生命周期
  backend.js     拉起本地 FastAPI：注入 DATABASE_URL(SQLite)/DESKTOP_LOCAL=1/SECRET_KEY/BYOK_ENCRYPT_KEY/RAG_EMBEDDER/UPLOAD_DIR；轮询 /health；崩溃自动重启
  frontend.js    拉起本地 Next.js standalone
  preload.js     contextBridge 白名单暴露能力(安全沙箱)
  updater.js     自动更新(electron-updater)
  publish.js/video.js  一键发布 RPA(patchright) + 视频剪辑(ffmpeg)

server/services/agent/       Agent 大脑（核心）
  loop.py        ReAct 主循环(同步+流式SSE共享核心)：想→调工具→结果回灌→再想；含 microcompact/anti-spin/Stop hook/max_turns 强制收尾
  registry.py    工具注册表 + @tool(能力位 deliverable/read_only/force_confirm/is_question)
  tools.py       运营工具(写文案/海报/诊断/约客/玩法/平台内容/团购/批量/提问)，复用 run_generation 管道
  local_tools.py 本机文件读/写/改/改Excel(沙箱 _resolve + 改前 _backup)
  approval.py    审批签名(HMAC 绑定 args，防"改参数再确认")
  hooks.py       Hook 机制(PreToolUse 拦截/PostToolUse 观察/Stop 阻断停止)，故障安全
  context.py     运行时上下文(db/store/user/权限模式/选定文件/防打转计数)
  poster_styles.py  10 种海报风格(大白话名 + 喂模型视觉关键词)
  proactive.py/scenario_catalog.py  主动出击 / 场景清单(find_scenario)

server/api/v1/
  agent.py       Agent 对话 SSE + 审批执行 /agent/execute + 会话历史列表
  canvas.py      画布定向改 + 报表可视化看/点格改(桌面专属，沙箱，自动备份)

server/services/ai/providers/  生图 BYOK 口子
  image_catalog.py  供应商目录 + resolve_image_kind + 下载
  siliconflow_image.py/dashscope_image.py  硅基流动/通义万相 适配器
  openai_image.py   gpt-image + 兼容端点(用配置 model 不写死)
  ../factory.py     get_image_config_for_store(桌面纯 BYOK 守卫)

web/src/components/desktop/   桌面 macOS UI
  macos-shell.tsx   双栏外壳(毛玻璃侧栏+主区+右侧预览，.app-drag 拖拽区)
  chat-shell.tsx    对话容器(接 use-agent-chat，拉门店/成本/今日建议/会话历史)
  chat-thread.tsx   消息流(步骤标签/成品卡/审批卡/提问卡)
  desktop-composer.tsx  输入框+权限模式(逐项确认/自动接受修改/跳过确认，用词照搬 Claude Code)
  preview-panel.tsx/welcome-screen.tsx  右侧预览/欢迎起手页
  ../hooks/use-agent-chat.ts   对话状态机
  ../lib/agent-tools.ts        工具元信息(中文标签/成品判定)

server/prompts/              知识库(桌面运行时=加密 prompts.enc)：52 knowledge + 72 operation + fewshots + rules（PPT-only 精简）
docs/桌面版AI-Agent-产品形态/  架构地图(全看懂从这开始)
交接-给新会话/                 现状与待办(新会话接手先读)
```

## 核心架构原则

1. **真 Agent（ReAct + 工具 + 审批闸 + BYOK）** — `services/agent/loop.py` 真循环(think→调工具→结果回灌→再推理)，真 function calling，工具复用 `run_generation/generate_workbench` 管道(自带配额/落库/店脑/合规过滤)。
2. **纯 BYOK，绝不内置平台 key** — `factory.get_image_config_for_store` 在 `DESKTOP_LOCAL=1` 没配即空 key、不回退平台；文字 provider 无 BYOK 落空 key → 友好 503。全仓无硬编码平台 key。
3. **四层防御** — ① 权限模式(逐项确认/自动接受修改/跳过确认)；② 工具 allow-ask-deny + 审批闸；③ 本地文件沙箱(内容库+选定文件、改前备份)；④ 审批签名绑定 args。
4. **对外/花钱动作走审批闸** — 生图/发布等标 `requires_approval=True`，循环里不直接执行，吐 `approval_request` 弹卡片、人确认后经 `/agent/execute` 才跑。绝不自动群发/私信。
5. **本地文件操作有护栏** — `local_tools` 只动「内容库」+ 用户经 OS 选择器当场选定的文件；`..` 穿越/越界抛错；写/改前自动备份。
6. **Prompt 与业务解耦** — 知识存 `prompts/` YAML（`{变量}` 占位），改 prompt 不改业务代码。`PromptEngine` 是单例 `get_prompt_engine()`。
7. **Agent 大脑持续学 Claude Code/cc-haha** — 对照 `~/Desktop/cc-haha-ref`（只读研学、**绝不抄码**）学其省 token/Hook/上下文压缩/工具系统机制，用我们 Python 实现。已借：循环状态机/入参校验/权限瀑布+force_confirm/结构化结果/超大结果护栏/AskUserQuestion/microcompact/Hook 三件/anti-spin。

## 开发规范

### 前端（macOS 桌面 UI 是第一公民）
- Next.js App Router；交互组件加 `"use client"`；样式用 Tailwind 不写 CSS 文件（项目无 `cn` helper，用模板字符串）
- `useDesktop().isDesktop` 区分桌面/web；桌面页面用 `web/src/components/desktop/`
- API 统一走 `lib/api.ts`；SSE 流式用 `streamAgent`；useEffect 加 `cancelled` flag 防卸载后 setState；**副作用别放进 setState 更新函数**(StrictMode 会双跑)
- 设计语言：macOS 原生质感(无边框窗口毛玻璃 + SF 字体 + #007AFF)；权限用词照搬 Claude Code（逐项确认/自动接受修改/跳过确认）

### 后端
- API 前缀 `/api/v1/`；Pydantic v2；async SQLAlchemy；JWT(HS256)
- **桌面用 SQLite**：UUID 列别传字符串(`db/types.py` 已兜)、PG 专属 SQL(jsonb/make_interval/advisory_lock/pg_insert)要按 `db.bind.dialect.name` 分支兜底，否则 SQLite 崩
- 上传/海报落点用 `UPLOAD_DIR`(指 userData 可写目录，app 包内只读)
- AI 调用结果写 `generations` 表；所有 Generation 查询加 `is_deleted == False`
- **多租户**：`core/tenant.py` 自动过滤只覆盖 generations/usage_quotas；其它带 store_id 的表靠手写 `.where(store_id==)`，漏写=跨店泄露

### Prompt 模板（YAML）
- 必须有 `key:`；渲染类(knowledge/operation/copywriting/activity)还需 `template:`（缺它是 `render()` 时 KeyError）
- 加载器**故意宽松**(凡有 `key` 即登记)——fewshots/预设库是 `templates:`/`examples:` 不同结构，切勿加"必须有 template"校验
- **品牌/来源铁律（判据：PPT原件全文里有 = 保留）**：禁止出现「来源出处 / 文件名 / PPT原件全文之外凭空捏造的无关第三方品牌」；但**PPT原件全文中真实出现的平台 / 获客渠道 / 器材名一律保留、不脱敏、不删**——平台名（美团 / 抖音 / 快手 / 小红书 / 大众点评…）、获客渠道含交友社交软件（探探 / 陌陌 / Soul / 积目…）、器材品牌（乔氏 / 星牌…）都是台球运营的行业必需真实信息。**用户已明确拍板：只要PPT原件全文里出现的这类词，全部保留，哪怕看起来"有风险"也不动。** 这些词需进 `knowledge/term_whitelist.yaml` 白名单，确保 `test_knowledge_guardrails.py` 不误杀。
- 护栏测试：`server/tests/test_knowledge_guardrails.py`

## 已落地能力（桌面版）

| 模块 | 状态 |
|------|------|
| 桌面全本地骨架(Electron + 本地 FastAPI + SQLite) + 自动更新 + Windows CI 出包 | ✅ |
| 纯 BYOK(文字+生图)+ CC Switch 式多供应商快切 | ✅ |
| Agent ReAct 循环 + 工具系统 + 审批闸 + 四层防御 | ✅ |
| 本机文件读改(read/write/edit/edit_excel，沙箱+备份)+ 权限分级 | ✅ |
| 国内生图 BYOK 口子(硅基流动/通义万相 适配器 + 路由 + 目录) | ✅ |
| 海报风格链路(10 风格大白话名 + Agent 提示词扩写 + 风格真拼进提示词) | ✅ |
| AskUserQuestion(问老板风格/选项) + 会话历史列表 | ✅ |
| Agent 机制(microcompact 省token / Hook 三件 / anti-spin 防打转) | ✅ |
| Canvas 画布定向改 + 报表可视化看/点格改 | ✅ |
| POS 真诊断(读老板导出报表 Excel) + BYOK 成本看板 | ✅ |
| 真 RAG(bge-zh 本地语义召回历史/知识/店脑) | ✅ |
| 一键发布闭环(平台内容→去发布带文案预填) | ✅ |
| **🔜 仅剩**：打包出安装包 + 真机端到端验收(详见交接文档) | 🔜 |

## 行业知识体系 · PPT-only（桌面运行时加密，最高知识政策）

**核对底本（PPT 原文全文 + 硬规则对照16条带行号 + 亲验摘要）已移出本仓库、由开发者本地留存，不随产品/代码分发；仓库里不保留任何第三方门店/来源名。** 知识库以"台球行业真实运营逻辑"为准对齐。

- **只保留 PPT 原件全文里有据的**运营逻辑/内容/知识；PPT 没有的（借鉴别处 / 模型衍生 / 凭空杜撰）一律删。**唯一例外 = 安全红线**（助教自爱不越界·不实际性交易 / 门店不当庄不抽水不定盘口 / 未成年保护——PPT P194「自爱」+「控制赌博金额」本就立了）。
- **不消毒、贴一线**：PPT 在册的真实打法（美女人设 / 异性情绪价值 / 擦边引流 / 交友软件获客 / 红包 / 超休 / 追分氛围 / 助教免费体验）照实落地，不因「听着擦边」误当红线。
- **架构 = 大厂标准 B**：精炼 PPT 核心 + 让模型自己延伸场景 + 即时检索 RAG（bge-zh + `look_up_knowledge`）。已查证 Anthropic 官方原话：curate canonical examples、别穷举规则、just-in-time retrieval。**不替模型穷举预建场景**——曾堆积的「模型衍生细则」已剥离（口诀 / 扣分表 / 回访天数 / 球技分级数字 / 三档框架 / 赛事主持词等，2026-06-20 一轮删 5895 行）。
- 现 **52 knowledge + 72 operation** YAML，覆盖营销 / 客户运营 / 人才管理(店长/教练/助教管理/前厅) / 数据分析。硬数字以本地留存的硬规则对照（16条带行号）为单一可信源。

## 开发 / 测试 / 打包

```bash
# 测试(快速门，不花钱不联网)
cd server && uv run pytest tests/ -q
bash scripts/test.sh

# 桌面开发
cd desktop && npm install && npm run dev   # Electron 起壳 + 本地后端 + 本地前端

# 打包(CI)
# .github/workflows/desktop-build-win.yml → PyInstaller 后端 + electron-builder nsis
```

## 不要做的事

- 不做收银/计费/灯控/会员充值系统（POS 只读，只读老板导出的报表做诊断）
- 不自动群发/自动私信（对外/花钱走审批闸；个人微信群发=封号红线）
- 不内置/泄漏任何平台大模型 key（纯 BYOK 铁律）
- 不抄 cc-haha 泄露源码进项目（只学架构、用自己 Python 写）
- 不在生图 prompt 主动塞中文文字/价格/Logo/二维码（用户显式填文字例外）
- 不用原生 `<select>`（用 CardSelect）；代码/YAML 不出现「来源出处/文件名/捏造的无关品牌」，但 **PPT原件全文中真实出现的平台/获客渠道/交友社交软件/器材名一律保留**（判据：PPT原件全文里有=保留，详见「Prompt 模板」节品牌/来源铁律）

## 关键约束（铁律）

1. **纯 BYOK**：绝不内置/泄漏平台 key（`DESKTOP_LOCAL=1` 没配即空 key、不回退）。
2. **POS 只读**：不碰收银系统，只读导出报表。
3. **不自动触达**：对外/花钱走审批闸。
4. **行业真实但守红线**：助教/擦边贴行业真实，硬线=不营销实际性交易、不帮刑事级犯罪。
5. **SQLite 兼容**：PG 专属 SQL/类型要按方言兜底，别让桌面崩。
6. **不做鸡肋死模板 + 用户视角**：给老板的功能要用 AI 真智能(理解+扩写)，预设只是起点；术语大白话；验证前端操作真影响输出。
7. **文档边开发边维护**：架构地图 / 真实性核对 / 交接文档 / 本文件过时即改。
