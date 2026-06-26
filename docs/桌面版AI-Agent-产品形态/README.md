# 桌面版 AI Agent · 产品形态架构地图

> 📌 状态:✅现行 · 最后核对 2026-06-26

> 这一份把"桌面版通用 AI Agent"整个产品**从壳到脑到知识**讲透，一张文档全看懂。（产品=通用本机 AI Agent 默认；台球运营=可 `@挂载` 的领域知识库，不是产品边界。）
> 本仓库就是「桌面版 AI Agent」独立仓库，`main` = 桌面产品全部代码（历史上从云端 web SaaS 仓库独立而来，与原仓库 `billiards-ai-ops` 仍共享后端 `server/`、前端 `web/`、知识库 `prompts/`）。本文标清**哪些是桌面专属、哪些与 web 共享**。

## 一、这是什么（形态 + 理念）

**一个装在用户自己电脑上的桌面软件**（不是网页、不连我们的云），本质是**通用本机 AI Agent**：
- **全本地**：Electron 外壳 + 本地 FastAPI 后端 + 本地 SQLite 数据库 + 加密知识库（`prompts.enc`）。数据全在用户自己机器上。
- **全内置 key**：盒子**内置 owner 自己的全部模型 key**，**用户零配置、不填 key**，开箱即用。⚠️ 内置 key 须在各平台设消费上限防被扒盗刷（详见 `docs/待改清单-真机验收与打包-2026-06-23.md` 专题D）。
- **真 Agent**：用户说一句话 → AI 大脑（ReAct 循环）自己想 → 调工具实打实干（读写/改本机文件、跑命令、上网查抓、生图、列清单、派子代理）→ 花钱或对外的动作走**审批闸**（弹卡片，人点确认才执行）。
- **台球运营=可挂载领域包**：`@「台球行业知识库」`（`billiards_mode`）时才追加台球人设 + 门店画像 + 店脑 + 台球工具集（写文案/海报/诊断/约客/改报表）；默认不挂就是通用电脑助手。
- **macOS 原生质感** UI（无边框窗口 + 毛玻璃侧栏 + 红绿灯 + 双栏 + 右侧预览）。

## 二、一张架构图

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 外壳 (desktop/)                                     │
│  主进程 main.js ──拉起──> 本地 FastAPI (子进程)               │
│       │  注入 DATABASE_URL/DESKTOP_LOCAL=1/内置key/UPLOAD_DIR │
│       │  自动更新 updater.js · 一键发布 publish.js/video.js    │
│  渲染进程 = 桌面前端 UI (web/ 的 Next.js, 加载本地 server.js)  │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTP/SSE  127.0.0.1:8077
┌───────────────▼─────────────────────────────────────────────┐
│  本地后端 FastAPI (server/)                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ Agent 大脑 (services/agent/)                          │    │
│  │  loop.py  ReAct 循环: 想→调工具→结果回灌→再想        │    │
│  │  ├ registry/tools  运营工具(写文案/海报/诊断/约客…)   │    │
│  │  ├ local_tools     本机文件读改(沙箱+备份)            │    │
│  │  ├ approval        审批闸(花钱/对外人确认)            │    │
│  │  ├ hooks           Pre/Post/Stop 钩子(可拦截/续跑)    │    │
│  │  └ microcompact/anti-spin  省token/防打转            │    │
│  └─────────────────────────────────────────────────────┘    │
│  知识库 prompts/(57知识+72场景, 桌面=加密 prompts.enc)        │
│  本地语义模型 bge-zh (RAG 按意思找料)                         │
│  SQLite (init_local.py 建库/平滑补列)                         │
│  大模型: 文字/生图全内置 key(owner 提供·用户零配置)·BYOK可选档│
└─────────────────────────────────────────────────────────────┘
```

## 三、分层文件清单（桌面专属代码）

### 1. Electron 外壳 — `desktop/src/`（桌面专属，全新）
| 文件 | 干什么 |
|------|------|
| `main.js` | 主进程：建窗口（macOS 红绿灯/毛玻璃）、起后端、生命周期 |
| `backend.js` | 拉起本地 FastAPI 子进程，注入环境（`DATABASE_URL`=本地 SQLite / `DESKTOP_LOCAL=1` / `SECRET_KEY` / `BYOK_ENCRYPT_KEY` / `RAG_EMBEDDER` / `UPLOAD_DIR`=可写目录），轮询 `/health` 就绪、崩溃自动重启 |
| `frontend.js` | 拉起本地 Next.js standalone（`server.js`） |
| `preload.js` | contextBridge 白名单暴露能力给渲染进程（安全沙箱） |
| `updater.js` | 自动更新（electron-updater，mac 未签名跳过） |
| `publish.js` / `video.js` | 一键发布 RPA worker（patchright）+ 视频剪辑（ffmpeg） |

### 2. Agent 大脑 — `server/services/agent/`（核心，本程重点打磨）
| 文件 | 干什么 |
|------|------|
| `loop.py` | **ReAct 主循环**（同步 + 流式 SSE 两入口共享核心）：调模型→有工具就逐个先经审批闸/校验→执行→结果回灌→再想；含 `_microcompact`(省token)/anti-spin(防打转)/Stop hook/max_turns 强制收尾 |
| `registry.py` | 工具注册表 + `@tool` 装饰器（声明能力位：deliverable/read_only/force_confirm/is_question）|
| `tools.py` | 运营工具：写文案/海报(`make_poster`含风格扩写)/诊断/约客/玩法/平台内容/团购/批量/提问，复用 `run_generation` 管道（自带配额/落库/店脑/合规）|
| `local_tools.py` | 本机文件读/写/改/改Excel（沙箱 `_resolve`=内容库+选定文件、改前 `_backup`）|
| `approval.py` | 审批签名（HMAC 绑定 args，防"改了参数再确认"）|
| `hooks.py` | Hook 机制（PreToolUse 拦截 / PostToolUse 观察 / Stop 阻断停止），故障安全 |
| `context.py` | 运行时上下文（db/store/user/权限模式/选定文件/防打转计数）|
| `poster_styles.py` | 10 种海报风格（大白话名 + 喂模型的视觉关键词）|
| `proactive.py` / `scenario_catalog.py` | 主动出击(今日建议预生成) / 场景清单(find_scenario)|

### 3. Agent / 桌面专属 API — `server/api/v1/`
| 文件 | 干什么 |
|------|------|
| `agent.py` | Agent 对话 SSE 端点 + 审批执行 `/agent/execute` + 会话历史列表 |
| `canvas.py` | 画布定向改 + 报表可视化看/点格改（桌面专属、沙箱、自动备份）|
| `../db/init_local.py` | 桌面 SQLite 建库 + 老库平滑补列 |
| `../desktop_entry.py` | 桌面后端入口（PyInstaller 打包用）|

### 4. 桌面前端 UI — `web/src/components/desktop/`（桌面专属，macOS 重做）
| 文件 | 干什么 |
|------|------|
| `macos-shell.tsx` | 双栏外壳：毛玻璃侧栏(会话列表/门店/花费) + 主区 + 右侧预览，`.app-drag` 拖拽区 |
| `chat-shell.tsx` | 对话容器：接 `use-agent-chat`、拉门店/成本/今日建议、会话历史 |
| `chat-thread.tsx` | 消息流渲染：步骤标签/成品卡/审批卡/提问卡 |
| `desktop-composer.tsx` | 输入框 + 权限模式（逐项确认/自动接受修改/跳过确认，用词照搬 Claude Code）|
| `preview-panel.tsx` / `welcome-screen.tsx` | 右侧预览（海报/内容）/ 欢迎起手页 |
| `../hooks/use-agent-chat.ts` | 对话状态机（send/审批/提问/会话加载，SSE 处理）|
| `../lib/agent-tools.ts` | 工具元信息（中文标签/成品判定/审批文案）|

### 5. 国内生图供应商口子 — `server/services/ai/providers/`（内置 key 默认，BYOK 可覆盖）
| 文件 | 干什么 |
|------|------|
| `image_catalog.py` | 生图供应商目录 + `resolve_image_kind`(按 base_url 路由) + 下载 |
| `siliconflow_image.py` / `dashscope_image.py` | 硅基流动(OpenAI式) / 通义万相(native异步) 适配器 |
| `openai_image.py` | gpt-image-2 + 兼容端点（用配置 model、不写死）|
| `../factory.py` | `get_image_config_for_store`：桌面 key 守卫——门店 BYOK 优先，否则返回内置 key + 各自 base_url（全内置已落地，见专题D；BYOK 可选）|

## 四、一次对话的数据流

```
老板在输入框说"给我做张周末双人优惠海报"
  → 桌面前端 use-agent-chat.send() → POST /api/v1/agent/chat (SSE)
  → loop.run_agent_loop_stream(): 注入门店画像+店脑记忆+红线规则
  → 模型(内置 key·BYOK 时用自带)想 → 决定调 make_poster + 扩写成丰富中文画面描述
  → make_poster 标 requires_approval → 不直接执行, 吐 approval_request
  → 前端弹审批卡, 老板点"确认" → POST /agent/execute (签名校验 args)
  → 真调生图(内置生图 key·BYOK 时用自带) → 出图存 UPLOAD_DIR → SSE 推回 → 右侧预览展示
```

## 五、桌面专属 vs 与 web 共享（重要）

- **桌面专属（上面 1/3/4 大部分 + 5 的全内置 key 守卫 + 2 的 local_tools/hooks/microcompact）**：这些是把 web SaaS"变成"本地桌面 Agent 的部分。
- **与 web 共享（不在本文清单、但桌面也用）**：`server/prompts/`（57+72 知识库，桌面是加密版）、`server/services/`（content/poster/memory/dashboard 等服务）、`web/src/` 的大部分页面与 `lib/api.ts`、`models/`、`schemas/`。
- 所以"桌面产品"≠ 一个干净独立目录，它是**在共享 SaaS 之上加了一层本地化 + Agent 化**。这也是为什么单独开仓库 = 复制整套、会和原仓库共享码漂移（取舍见下）。

## 六、全内置 key 边界 + 四层防御

- **当前代码（全内置已落地·见专题D）**：`factory.get_image_config_for_store` 在 `DESKTOP_LOCAL=1` 下，门店 BYOK 优先、否则返回内置 key + 各自 base_url；内置 key 未注入时才友好报错（不静默落到无关平台 key）。BYOK = 可选高级档。
- **四层防御**：① 权限模式（逐项确认/自动接受修改/跳过确认）；② 工具 allow-ask-deny + 审批闸；③ 本地文件沙箱（内容库+选定文件、改前备份）；④ 审批签名绑定 args。

## 七、怎么跑

- **开发**：`desktop/` 里 `npm run dev`（Electron 起壳 + `backend.js` 跑 `uv run uvicorn` + `frontend.js` 跑 Next dev）。
- **打包**：CI `.github/workflows/desktop-build-win.yml`（PyInstaller 打后端 .exe + electron-builder 出 nsis）。⚠️ 打包出包后**真机端到端验收尚未做**（见 `docs/完整优化清单.md`）。

---
*本文件是「桌面版 AI Agent」独立仓库的产品形态地图（架构地图，一张文档看懂产品）。当前产品化主线待办见 `docs/完整优化清单.md`。*
