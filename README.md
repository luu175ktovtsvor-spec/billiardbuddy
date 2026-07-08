# 球房运营 AI 助手 · 桌面版

> 📌 状态:✅现行 · 最后核对 2026-07-09
>
> **⚠️ 2026-07-09:老 Python 后端(`server/`)已整体退役删除,当前唯一代码栈是 `ts/`(Bun/TS 内核,cc-haha 标准 coding-agent 循环)。** 老 `web/` 前端 + `desktop/` 打包入口(拉起 Python)仍在,属"批3 成栈切换"单独处理。下方"全本地 FastAPI/代码在哪 server/"等描述待随批3统一重写;当前权威口径见 `docs/plans/强-coding-agent-桌面外壳-阶段目标.md` 与 `docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md`。

> **想看完整的架构/规范/铁律/现状与待办 → 唯一入口是 [`CLAUDE.md`](./CLAUDE.md)。** 本文件只做"项目地图"，让任何人（或新开一个 AI 会话）打开秒懂"这是什么、代码在哪、怎么跑"。

## 这是什么

装在店主自己电脑上的**通用本机 AI Agent** 桌面软件——一句话 → AI 自己调工具把事办完（读写本机文件、跑命令、上网查抓、生图、剪视频、列清单、派子代理）。**台球房运营只是一个可 `@挂载` 的领域知识库**（`billiards_mode`），默认不挂就是个通用电脑助手。

- **全本地**：Electron 壳 + 本地 FastAPI + 本地 SQLite + 加密知识库（`prompts.enc`），数据不连云。
- **全内置 key**：文字/生图/视频模型 key 全部内置打包（owner 提供），用户零配置、不填 key，开箱即用；真 key 收在服务器网关，客户端只带可吊销令牌。
- **真 Agent**：ReAct 循环自主调工具；本机文件/命令能直接推进，真对外/不可逆动作（群发、删数据、登录授权等）弹审批卡片，人确认才执行。

## 怎么跑（开发）

```bash
# TS 内核(当前唯一代码栈)
cd ts && bun install
bun test                  # 全量单测
bun run typecheck         # tsc --noEmit
bun run build:sidecar     # 出本机 sidecar 二进制
bun run desktop:dev       # 最小 Electron 壳拉起 sidecar
```

完整命令见 `CLAUDE.md`「开发 / 测试」节。老 `server/` pytest、老 `web/` 前端、`desktop/` 拉起 Python 的 dev 流程均已退役。

## 代码在哪

```
ts/         唯一代码栈:Bun/TS 内核(cc-haha 标准 coding-agent 循环)——
            ts/src/harness(循环) · permissions(权限/审批) · tools(文件/命令/搜索) · sandbox/workspace(护栏)
            · hooks · skills · commands(内置 slash 命令在 ts/commands) · tasks(子代理/后台) · mcp · plugins
            · context(压缩恢复) · model/proxy(provider/OpenAI 兼容) · media(生图/真实素材剪辑) · server(Bun.serve API)
gateway/    模型 key 收拢网关(国内服务器总闸):客户端只带 app 令牌,真 key 在服务器,三层阀门限流+藏 key
web/        (退役中)老 Next.js 前端 —— 目标壳切 ts-desktop 后整体退役
desktop/    (退役中)老 Electron 壳(拉起 Python)—— 批3 切成拉起 ts/ 后端 + ts-desktop
```

> 老 `server/`(Python 后端)+ 台球知识 YAML 已整体删除(git 历史可回查);台球领域包以后在 TS 侧重新策展。

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
