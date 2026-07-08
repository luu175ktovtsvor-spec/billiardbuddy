# 球房运营 AI 助手 · 桌面版

> 📌 状态:✅现行 · 最后核对 2026-07-02

> **想看完整的架构/规范/铁律/现状与待办 → 唯一入口是 [`CLAUDE.md`](./CLAUDE.md)。** 本文件只做"项目地图"，让任何人（或新开一个 AI 会话）打开秒懂"这是什么、代码在哪、怎么跑"。

## 这是什么

装在店主自己电脑上的**通用本机 AI Agent** 桌面软件——一句话 → AI 自己调工具把事办完（读写本机文件、跑命令、上网查抓、生图、剪视频、列清单、派子代理）。**台球房运营只是一个可 `@挂载` 的领域知识库**（`billiards_mode`），默认不挂就是个通用电脑助手。

- **全本地**：Electron 壳 + 本地 FastAPI + 本地 SQLite + 加密知识库（`prompts.enc`），数据不连云。
- **全内置 key**：文字/生图/视频模型 key 全部内置打包（owner 提供），用户零配置、不填 key，开箱即用；真 key 收在服务器网关，客户端只带可吊销令牌。
- **真 Agent**：ReAct 循环自主调工具；本机文件/命令能直接推进，真对外/不可逆动作（群发、删数据、登录授权等）弹审批卡片，人确认才执行。

## 怎么跑（开发）

```bash
# 后端依赖 + 前端依赖
cd server && uv sync
cd ../web && pnpm install
# 起桌面壳（Electron 会自动拉起本地 FastAPI + 本地 Next.js）
cd ../desktop && npm install && npm run dev

# 快速测试门（不花钱、不联网 AI）：后端 pytest + 前端 tsc
bash scripts/test.sh

# 打包出安装包（CI: PyInstaller 后端 + electron-builder nsis/dmg）
# 见 .github/workflows/desktop-build-win.yml；改前端后必须重打包才能看到真效果
```

完整命令清单（单测/单文件/评测/耦合地图刷新）见 `CLAUDE.md`「开发 / 测试」节。

## 代码在哪

```
server/     后端：Python 3.12 + FastAPI + SQLAlchemy + 本地 SQLite；Agent 大脑在 server/services/agent/
web/        前端：Next.js 14 + React + TypeScript；桌面 UI 在 web/src/components/desktop/
desktop/    Electron 壳：main/backend/frontend/preload/updater/video，负责拉起本地后端+前端、打包
gateway/    模型 key 收拢网关（国内服务器总闸）：客户端只带 app 令牌，真 key 全在服务器 gw.env，三层阀门限流+每用户配额+藏 key
```

其它值得知道的目录：`server/prompts/` 知识库源文件（运行时加密为 `prompts.enc`）；`web/src/app/dashboard/video/` 视频创作工作区页面；`server/services/video_edit/` 视频剪辑/生成引擎。

## 文档去哪找

- **架构/规范/铁律/现状与待办** → 根目录 [`CLAUDE.md`](./CLAUDE.md)（唯一入口，最高优先级）
- **文档总索引**（按主题分类的全部文档）→ [`docs/README.md`](./docs/README.md)
- **一张图看懂产品架构** → `docs/桌面版AI-Agent-产品形态/README.md`
- 历史/已完成/已否决的文档挪进 `docs/归档/`，仅供回查，不再维护

## 当前状态（2026-07-02）

功能面已齐：视频创作工作区、生图编辑台（GPT + 火山双模型）、真 key 收网关、运行中插话纠偏等均已合入 `main`；后端 1377 测试全绿、前端 `tsc` 全过；Windows/macOS 双平台已能打包出安装包（口播转录模型即 whisper 权重约 1.4G，已抽离成首启按需下载，安装包体积由此从约 1.7G 降到约 500M）；已做过多轮真机验证。**卡上线的最后两件事**：① 全新机器的完整打包验收没跑全；② 服务器搬 key（把真 key 填进网关、发 app 令牌）。详见 `CLAUDE.md`「现状与待办」节。

## 关键边界（铁律，详见 CLAUDE.md）

- **全内置 key**：内置 owner 的模型 key、用户不填；各平台后台设消费上限防盗刷。
- **POS 只读**：不做收银/计费/灯控/会员充值系统，只读老板导出的报表做诊断。
- **不自动群发/私信/平台发布**：当前不内置平台发布 RPA；对外或不可逆动作一律走审批闸，人确认后执行。
- **行业真实但守红线**：台球知识库贴行业真实运营逻辑，但硬线是不营销实际性交易、不帮刑事级犯罪。
