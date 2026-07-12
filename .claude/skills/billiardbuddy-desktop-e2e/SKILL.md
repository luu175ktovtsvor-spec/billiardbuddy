---
name: billiardbuddy-desktop-e2e
description: 对球房管家 Electron、React 和 Bun sidecar 做桌面全栈 E2E，联合 DOM、截图、主进程、API、日志和 JSONL 证据归因问题。需要真机验收、验证界面与后端接通、复现桌面 Bug 或判断前端/传输/后端责任时使用。配套驱动 run.mjs。
---

# 球房管家 · 桌面全栈 E2E（playwright-electron + sidecar 证据 + 视觉判断）

> 本项目（ts/ 架构）专属的落地版；通用方法论见全局 skill `electron-fullstack-e2e`。本 skill 写死本项目的端口/起法/前端/日志。
> ⚠️ 这是**开发期测试 skill**（测我们自己的 app），不进产品分发；内容写真实端口/路径没问题。
> 🚧 **当前是骨架**：方法论 + 起服 + 归因 + 产出都通了，**具体检查点（测试用例）留占位，随前端搭好逐步补**（见「怎么加检查点」）。
> 先读取 `.claude/skills/模块化开发总路由/SKILL.md` 和开工改动说明；只验证受影响用户路径，并把契约、前端和后端证据关联起来。

## 为什么是「全栈」而不是纯 Playwright
**Playwright 只驱动前端（React DOM），看得到「界面卡住」却不知道后端 sidecar 干了啥 → 单边、会误判。** 真端到端 + 把前后端问题拆开，必须三边证据一起看：
1. **前端**：playwright-electron 查 React DOM + `electronApp.evaluate()` 查主进程（BrowserWindow 状态）+ 截图（由当前视觉能力直接检查，不调用外部视觉模型）。
2. **后端**：读 sidecar stdout 日志增量 + 直连 sidecar HTTP/WS API + 翻 JSONL transcript（文件式存储，会话/工具证据都在文件里）。
3. **归因**：前端失败 + 后端成功 = **前端/传输**问题；前端失败 + 后端报错 = **后端**问题；都成 = 正常。

> ⚠️ **后端返 200/"成功" ≠ 走对了模型/供应商。** 白标下前端只看代称——真实路由要核 sidecar 日志里那条实际出网 URL（`ark.cn-beijing`=豆包 / relay=GPT）+ transcript 里的 usage/model 字段，别只看"成没成"。

## 新架构参数（vs 已废的老 Python 线）
| 项 | 老架构（已删） | **新架构（本 skill）** |
|---|---|---|
| 后端 | FastAPI `:8077` | Bun/TS sidecar，`main.ts` 起时 `reserveServerPort` 动态端口（driver 从主进程 evaluate 拿）；或 `bun run dev:server` 固定 `:8850` |
| 前端 | 老 web `:3100` | **React** `desktop/renderer-react`（`QF_UI_REACT=1` 加载 `renderer-dist`，需先 `bun run ui:build`） |
| 起壳 | `desktop/e2e-pw/run.js` | `bun run desktop:build`（出 `main.mjs`）后 playwright `_electron.launch(main.mjs)` |
| 驱动 | playwright-electron | 同 —— `_electron.launch`，electron 自己 `spawnSidecar` 拉起后端 |
| 证据存储 | SQLite/DB | JSONL transcript + JSON meta（`stateRoot/transcripts/*.jsonl`、`sessions.json`） |
| 日志 | `~/qf-monitor.log` | sidecar stdout（driver 重定向到 `test-results/sidecar.log`） |

## Quick start
```bash
cd ts
bun run ui:build          # 出 React 产物 renderer-dist（QF_UI_REACT 要它）
bun run desktop:build     # 出 electron main.mjs / preload.cjs
node ../.claude/skills/billiardbuddy-desktop-e2e/run.mjs   # 跑骨架：启动 app + 截图 + 产出 manifest
```
产出在 `test-results/`：
- `<场景>__<检查点>.png` —— 截图（逐张检查并记录 `{pass, reason}`）
- `manifest.json` —— 每检查点的 期望 + 前端断言 + 后端证据增量 + **自动归因**
- `sidecar.log` —— 后端 stdout（后端到底成没成的证据）

## ⚠️ 测「当前分支的代码」，不是装机版
装机版 app 是旧编译，挂上去测不到你新写的功能/bug。**从当前 worktree 起 dev 版**：`ui:build` + `desktop:build` 用的就是当前分支代码，driver `_electron.launch` 挂的就是它。别去挂已安装的 app。

## 三边证据怎么取（driver 已封装）
- **前端 DOM/主进程**：`window.locator(...)`；`electronApp.evaluate(({BrowserWindow}) => ...)` 查窗口/菜单/托盘状态。
- **后端 API**：`getSidecarBase(electronApp)` 拿 sidecar 基址 → `fetch('${base}/api/v1/...')`（健康检查、命令列表、会话等）。
- **后端日志/transcript**：读 `test-results/sidecar.log` 增量 + `stateRoot/transcripts/<id>.jsonl`。
- **视觉**：driver 只负责截图落盘；Skill 使用者逐张检查并记录 pass/fail 与理由。

## 归因矩阵（driver 自动填进 manifest）
| 前端断言 | 后端证据 | 归因 |
|---|---|---|
| 失败 | 成功 | 前端/传输（后端做了、前端没渲染/没收到） |
| 失败 | 报错 | 后端 |
| 成功 | 成功 | 正常 |
| 成功 | 报错 | 传输/前端误报"成功"（危险，重点查） |

## 怎么加检查点（以后往这里补）
每个检查点 = 一个 `{ name, expectation, run(ctx) }`，塞进 `run.mjs` 的 `CHECKPOINTS` 数组。`run(ctx)` 里：① 用 `ctx.window` 操作/断言前端；② 用 `ctx.backend` 取后端证据；③ 调 `ctx.shot(名字)` 截图；④ return `{ frontendPass, backendOk, note }`，driver 自动算归因 + 写 manifest。
**建议补的第一批**（等前端可测后）：app 启动→主对话框渲染 → 发一条消息→流式回显 → 斜杠面板列出命令（含 /台球）→ 工具卡展开看 diff → 生图工作台出图。现在骨架里放了 `app-boot` 一个占位检查点做样板。
