---
name: fullstack-e2e
description: 对这个桌面 Electron 应用(台球运营管家)做"全栈"端到端测试——Playwright 驱动前端(DOM+截图+electronApp.evaluate 主进程) + 读后端日志/API + Claude 自己看截图做视觉判断 + 自动把每个问题归因到 前端/后端/传输。当用户要测桌面 app、做端到端或真机验收、验证界面是否正常渲染、复现/定位某个 bug、或判断一个问题到底是前端还是后端时使用。配套驱动: desktop/e2e-pw/run.js。
---

# 全栈端到端测试（Playwright-Electron + 后端日志 + Claude 视觉）

> 这是**本项目（台球运营管家）专属**的落地版；通用方法论见全局 skill `electron-fullstack-e2e`（任何 Electron app 都适用）。本 skill 写死了本项目的端口/日志/驱动/清理。

## 为什么是"全栈"而不是纯 Playwright
**Playwright 只驱动前端（渲染进程 DOM），看得到"界面卡住"却不知道后端干了啥 → 单边、会误判。** 真·端到端 + "把前后端问题拆开"必须三边证据一起看：
1. **前端**：Playwright 查 DOM + `electronApp.evaluate` 查主进程 + 截图（交给 **Claude 自己看**，不调任何外部视觉模型）。
2. **后端**：读 `~/qf-monitor.log` 增量 + 直连 `:8077` API（后端到底成没成）。
3. **归因**：前端失败 + 后端成功 = **前端/传输**问题；前端失败 + 后端报错 = **后端**问题；都成 = 正常。
> 实例 M1：前端 spinner 卡死、后端日志却有"生图完成" → 自动归因=**前端/传输**（后端已出图、前端没渲染），不是后端逻辑。光看前端会误判成"后端没出图"。
> ⚠️ **后端返 200/"成功" ≠ 走对了模型/供应商。** 静默错路由也返成功（本次真 bug：选「火山 Seedream」被判据写错，静默路由到了 gpt-image-2）。核实**真实端点**（后端 httpx 日志里那条 `POST <url>` 到底打的 `ark.cn-beijing` 还是 `api.openai.com`）+ **DB `generations.model_used`**，别只看"成没成"。

## Quick start
```bash
# 前提：装机版 app 正开着（占着 :3100 前端 / :8077 后端）。驱动会"挂"上去、不扰动它。
node desktop/e2e-pw/run.js
```
产出在 `desktop/e2e-pw/test-results/`：
- `<场景>__<检查点>.png` —— 截图（**Claude 用 Read 工具逐张看，判 {pass, reason}**）
- `manifest.json` —— 每个检查点的 期望(expectation) + 前端断言 + 后端日志增量 + **自动归因**

## ⚠️ 测「当前分支的代码」而不是装机版（装机版=旧编译，测不到你新写的）
装机版 app 是**旧 main 编译的**——挂上去测的是老代码，查不到你分支上的新功能/新 bug。要真机测**当前 worktree/分支的代码**，从这个 worktree 起 dev 版（本套已实测跑通）：
1. **补齐 worktree 缺的东西**（都 gitignored，软链主仓库现成的即可，跑完删）：
   ```bash
   ln -s 主仓库/server/.env.bundled.local server/.env.bundled.local
   ln -s 主仓库/web/node_modules web/node_modules
   ln -s 主仓库/desktop/node_modules desktop/node_modules   # electron 二进制在这
   ```
2. **自己起后端**（复用主仓库 `.venv` 跑 worktree 代码 + 注入内置 env；**日志重定向进 `~/qf-monitor.log`** 才有后端证据）。`UD=~/Library/Application Support/billiards-desktop-agent`：
   ```bash
   set -a; . 主仓库/server/.env.bundled.local; set +a
   export DESKTOP_LOCAL=1 DATABASE_URL="sqlite+aiosqlite:///$UD/billiards.db" \
     SECRET_KEY=$(cat "$UD/secret.key") BYOK_ENCRYPT_KEY=$(cat "$UD/byok.key") \
     UPLOAD_DIR="$UD/uploads" RAG_EMBEDDER=fastembed
   cd server && 主仓库/server/.venv/bin/python -m uvicorn main:app --port 8077 >> ~/qf-monitor.log 2>&1 &
   ```
3. **自己起前端**：`API_PROXY_URL=http://localhost:8077 npx next dev -p 3100`
4. **驱动挂上去**（同"不扰动装机版"那组 env）：`DESKTOP_MANAGE_BACKEND=0 DESKTOP_MANAGE_FRONTEND=0 DESKTOP_APP_URL=http://localhost:3100 node desktop/e2e-pw/run.js`
> 先确认 8077/3100 空（装机版没在跑）。studio/视频等独立页有各自驱动（`run-studio.js` 等）。跑完删软链、停这两个进程。

## 另一条更快的路：后端直连（验「模型/接口能不能用」时优先）
问「某模型/接口到底能不能出活」时，不必起整套 Electron——直连后端最快、最决定性：`curl` 打 `/api/v1/studio/generate`（或 `/edit`、`/i2v`）拿 `job_id` → 轮询 `/api/v1/agent/media-jobs/{id}` → 拿到 `/uploads/...` 路径后**用 Read 打开那张图/那段视频亲自看**。桌面免登录（`DESKTOP_LOCAL=1` 直返 seed owner，无需 token）。本次 4 个生图 bug 全是这么逮的。

## 跑完后 Claude 要做的（视觉判断层）
1. `Read` 每张 `test-results/*.png`，对照 manifest 里的 `expectation` 判 `{pass, reason}`。
2. 结合 manifest 的 `归因` 字段，把失败项写成"前端/后端/传输"哪一边的问题。
3. 机器断言(DOM/主进程) PASS 但视觉看着不对，以**视觉为准**（反之亦然）——两层互补。
4. **机器判 FAIL 常是假警报**：UI 一改，驱动里写死的选择器就过时、找不到元素 → 误报 FAIL，但页面其实是好的。**逐张看图证伪**别直接当 bug；确认是选择器过时的，顺手更新 `run.js` 里对应检查点（否则每次跑都得人肉排假警报）。
5. **慢异步（视频/长任务）驱动等不到成品**：出片要几分钟，驱动截图时它还在"处理中" → 会误判 FAIL。这类只看前端"有没有空转卡死（有'中断'=没卡）"，**成品对不对要另外核实**：轮询 `media-jobs/{id}` 到 done + 用 Read 打开产物看。

## 怎么加场景
编辑 `desktop/e2e-pw/run.js`，照 S1/S2/S3 的样子：`since=logLineCount()` → 用 `send()/newChat()/win.locator()` 操作 → `waitStreamSettle()` 等流结束 → `checkpoint(win, 场景, 名, 期望, {dom, main, machinePass}, since)`。`checkpoint` 自动截图+抓后端日志增量+算归因。
- 选择器：**别把 CSS 和 `text=` 混写在一个字符串里**（Playwright 报错）。用 `win.locator('button:has-text("X")')` 或 `win.locator("text=X")` 单独写。
- 输入框 placeholder 含"要办的事"；发送按 Enter；spinner 文案含"中断"；海报图 `.markdown img`。

## 关键项目事实（写死在驱动里，换机器需改）
- 端口：前端 `:3100`、后端 `:8077`；后端日志 `~/qf-monitor.log`。
- **不扰动装机版**：`DESKTOP_MANAGE_BACKEND=0 DESKTOP_MANAGE_FRONTEND=0 DESKTOP_APP_URL=http://localhost:3100`（main.js 支持；无单实例锁，可另开一窗）。
  - 想测**全新启动/首启**：先退装机版释放端口，去掉这些 env 让驱动启自己的后端+前端（更真但慢、会测到启动链路）。
- Playwright 来自 `web/node_modules/playwright` 的 `_electron`（项目已装 1.60），electron 来自 `desktop/node_modules/electron`。

## ⚠️ 测试会污染，跑完清理
驱动会真发对话、真生图 → 污染 `store_memories`（学习器把测试输入当门店事实）+ 在 `uploads/posters/` 留测试图。**跑完务必清**：
- `sqlite3 "$HOME/Library/Application Support/billiards-desktop-agent/billiards.db" "DELETE FROM store_memories WHERE rowid>{基线}"`（先记基线 rowid）。
- 删 `uploads/posters/` 里本轮生成的测试图 + 软删对应 `generations` 行。
- 删测试用临时文件。
- **删后抽查真实数据没误伤**：`store_memories` 里真实门店记忆（如「鑫和台球」）还在、只清掉了测试行（搜含 "E2E" 的应为 0）。别只看 rowid 数字（表里本就有跳号/软删空洞，会吓到你）。

## 跟其它测法的关系
- 旧 `desktop/e2e/`、`desktop/test/` 是过时的纯 Playwright 脚本（含已废弃登录流程），**已被本套取代**。
- 交互式探查可用 native-devtools MCP（点/截图/输入），但**可复现的回归用本套**（脚本化、带后端归因）。
