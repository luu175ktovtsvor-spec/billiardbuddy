# 球房运营 AI 助手 · 桌面版 AI Agent

> 装在台球房老板自己电脑上的 **AI 运营管家**——全本地、纯 BYOK（自带大模型 key）、真 Agent（一句话 → 自己调工具干活）。
> 本仓库是**桌面版台球房运营 AI Agent 的独立仓库**，`main` 即当前桌面产品的全部代码。**想一张文档全看懂 → `docs/桌面版AI-Agent-产品形态/README.md`（架构地图）；当前产品化主线待办 → `docs/完整优化清单.md`（37 项优化清单，go-forward 工作主线）。**

## 这是什么

- **全本地**：Electron 外壳 + 本地 FastAPI + 本地 SQLite + 加密知识库（`prompts.enc`）。门店数据全在老板自己机器上，不连云。
- **纯 BYOK**：盒子**不内置任何平台大模型 key**。老板自带文字/生图模型 key，花的是自己的钱、自担成本与并发。代码层强制：桌面没配 key 就空 key、绝不回退平台 key，空 key 时返回友好 503。
- **真 Agent**：老板说一句话 → AI 大脑（ReAct 循环）自己想 → 调运营工具（写文案 / 做海报 / 经营诊断 / 约客 / 改本地报表）→ 花钱或对外的动作走**审批闸**（弹卡片，人点确认才执行）。
- **macOS 原生质感** UI：无边框窗口 + 毛玻璃侧栏 + 红绿灯 + 双栏 + 右侧预览面板。

## 技术栈

- **外壳**：Electron（`desktop/`）
- **后端（本地）**：Python 3.12 + FastAPI + SQLAlchemy + **SQLite**（aiosqlite）
- **前端**：Next.js 14 + React 18 + TypeScript + TailwindCSS（macOS 桌面 UI）
- **AI（BYOK）**：文字（任意 OpenAI 兼容，如 DeepSeek/硅基/火山） + 生图（硅基流动 / 通义万相 / 即梦 / gpt-image 等，国内可用）
- **本地语义**：bge-zh（fastembed / onnxruntime，本地跑、非 pgvector）做 RAG，「按意思找料」换说法也找得到
- **知识库**：加密 `prompts.enc`（运行时解密，52 知识 + 72 场景 YAML）

## 怎么跑（开发）

```bash
# 1. 后端依赖
cd server && uv sync
# 2. 前端依赖
cd ../web && pnpm install
# 3. 起桌面壳（Electron 会自动拉起本地 FastAPI + 本地 Next.js）
cd ../desktop && npm install && npm run dev
```

> 桌面后端用本地 SQLite（`DATABASE_URL=sqlite+aiosqlite:///…`）+ `DESKTOP_LOCAL=1`，由 `desktop/src/backend.js` 注入环境后拉起。BYOK key 首启在 app 内填。

## 打包

CI（`.github/workflows/desktop-build-win.yml`）：PyInstaller 打后端可执行 + electron-builder 出安装包（Windows nsis / Mac dmg）。
⚠️ **打包出包后真机端到端验收尚未做**（填 BYOK → 写文案/改报表/海报/发布全链路），是上线前最后一关。

## 核心目录

```
desktop/src/            Electron 壳（main/backend/frontend/preload/updater/publish/video）
server/services/agent/  Agent 大脑（loop/registry/tools/local_tools/approval/hooks/poster_styles…）
server/api/v1/agent.py  Agent 对话 SSE + 审批执行 + 会话历史
server/api/v1/canvas.py 画布定向改 + 报表可视化看/点格改（桌面专属）
server/services/ai/providers/  生图 BYOK 口子（image_catalog/siliconflow/dashscope/openai_image）
web/src/components/desktop/     桌面 macOS UI（macos-shell/chat-shell/chat-thread/composer/preview）
server/prompts/         知识库（桌面运行时用加密 prompts.enc）
docs/桌面版AI-Agent-产品形态/   架构地图（全看懂从这开始）
docs/台球行业真实性分支/         知识库真实性核对 + PPT 原件全文
docs/完整优化清单.md             当前产品化主线待办（37 项优化清单，go-forward 工作主线）
```

## 关键边界（铁律）

- **纯 BYOK**：绝不内置/泄漏任何平台大模型 key。
- **POS 只读**：不做收银/计费/灯控/会员充值系统；只读老板从收银系统导出的报表做诊断。
- **不自动群发/私信**：对外或花钱动作一律走审批闸（人确认后执行），个人微信自动群发=封号红线。
- **行业真实但守红线**：助教获客/擦边等贴台球行业真实运营逻辑的做法，但硬线=不营销实际性交易、不帮刑事级犯罪（详见 `docs/台球行业真实性分支/`）。
