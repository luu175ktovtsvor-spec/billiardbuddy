# 交接 · 下一窗口开工指引（商品化收官 · C 批后）

> 📌 状态:📦历史 · **D 批 10 单已全部完成并 FF 合入本地 main(5a9a337)** · 可删 · 归档 2026-07-04
> 这是一份**薄启动器**：只负责给你定位 + 交代现状 + 工作法。**真权威在 CLAUDE.md / 主计划 / 进度台账那三份**，本文件只做入口指路。
> —— D 批收官记录：10 单串行(D1砍鸡肋+#55 / D2高德 / D3-4定时任务 / D5-6店铺资料库 / D7场景方案 / D8朗读 / D9语音 / D10全局快捷键)全过独立 Sonnet 审查(逮 1 Critical 跨线程sqlite崩溃+多个 Important 均修·全对抗验证)+全分支复审(5接缝自洽·1865 passed·tsc/node--check/耦合地图全绿·无交叉问题)。main 3724d82→5a9a337(38 commit·未 push·推 GitHub 由 owner 定)。真机验收(说话转字/Alt+Space/定时真跑/朗读/截图/打包)归 G2。owner 行动项见进度台账末尾。

## 一句话
你接手「台球运营 AI 助手桌面版」（装在用户电脑上的**通用本机 AI Agent**，对标 Claude Code；台球运营只是可挂载的领域知识库）的**商品化收官改造**。A/B/C/F 四批已完成合入本地 `main`。这轮**建议做 D 批（能力实心化：砍鸡肋 + 补五件——定时任务/语音输入/全局快捷键/店铺资料库/成品交付物/朗读/高德）**。
> D 是文档依赖图里 C 之后最自然的下一批（依赖 B Electron + F1 通知层，两者都已在 main）。**E（创作线收敛）、G（发版+真机验收）也都已解锁**——owner 若改派 E 或 G，工作法完全通用、只需读主计划对应批次节。**开哪批以 owner 当场指定为准。**

## 开工前按顺序读这三份（唯一权威，别跳）
1. **`CLAUDE.md`** — 项目导航 + 铁律 + 架构原则，唯一权威入口。先读开头导航段 +「核心架构原则」+「关键约束」。
2. **`docs/plans/商品化收官-总开发文档-2026-07-03.md`** — 主计划。读你的批次章节（**「批次 D」节 = 第 174-214 行**）+ **§5 决策清单（379 行，owner 已授权 AI 代拍的定论，照办不再上报）** + **§6 明确不做清单（398 行，防跑偏）**。
3. **`.superpowers/sdd/商品化收官-progress.md`** — 进度台账。读**顶部 banner** + 末尾**「## 批次 C」+「🏁 C 批收官」节**（看 A/B/C/F 是怎么一单一单做下来的，照抄那个模式）。

## 当前状态（2026-07-04，C 批收官后）
- 批次 **A（前端简约化）、B（Windows 观感）、C（首屏改造）、F（后端壳子补强）已全部完成并 FF 合入本地 `main`**（HEAD `49fbe14`；C 批工作 = `4f5cf7c..fcf8f05` 共 7 commit，其上是本轮归档 commit）。
- 后端 `cd server && uv run pytest tests/ -q` = **1723 passed, 1 skipped**；前端 `cd web && npx tsc --noEmit` 过。
- **未 push GitHub**（历史有旧明文密钥，G1 轮换后 owner 再定推不推；默认只在本地）。
- 你从当前 `main` 起一条新分支（如 `batch-d-capabilities`）开工。D 依赖的 B Electron + F1 通知层（= F-9 `notify_service`）都已在 main、就位。

## 工作法（照 A/B/C/F 的成功模式 · 就是 superpowers 的 `subagent-driven-development` skill，可直接调）
1. **拆单前先 grep / 读真实代码把落点定死**——别凭想象（A/B/C/F 全靠这个逮到真坑；C 批我的侦察还误判过一处 category，实现子代理用 git blame 纠正了——所以让子代理"验证而非照抄侦察"）。
2. 每个工作单 → 派一个**全新 Sonnet 子代理**实现（施工单写 scratchpad、报告/diff 走文件 handoff、不塞主窗口上下文）。
3. → 生成 diff 包（`superpowers/.../scripts/review-package BASE HEAD`）派 **Sonnet 审查子代理**（出「规范符合度 + 代码质量」两个结论）。
4. → 有 Critical/Important 就修或派修复子代理，再复核；Minor 记台账留全分支复审裁。
5. → 一批做完做**全分支复审**（专抓单元之间叠加才暴露的交叉问题——C 批全分支复审就逮到了 1 个 per-task 审查漏掉的 Critical：`addSelectedFiles` 异步 setState 后紧接 `chat.send` 的时序竞态。**这一步别省。**）
6. → **FF 合入本地 `main`**（推不推 GitHub 由 owner 定，默认本地）→ 归档本交接 doc → 更新台账。
- **子代理一律用 Sonnet**（owner 指定，覆盖 skill 的"最省模型"默认；含全分支复审也用 Sonnet，C/F 批已验证够用）。

## 合并前必过的门槛
- `cd server && uv run pytest tests/ -q` 全绿 + `cd web && npx tsc --noEmit` 过；改了 Electron 壳（D2/D3/D4 会）→ `node --check desktop/src/*.js` 过。
- 改了承重接口（`web/src/lib/api.ts` / `server/api/v1/` 路由）→ 跑 `python3 scripts/build_coupling_map.py --write` 刷耦合地图（否则 `test_coupling_map_fresh.py` 红）。
- **每步更新进度台账**（`.superpowers/sdd/商品化收官-progress.md`，它是 gitignored scratch·别指望进仓库）：记每单进度、审查发现、Minor、owner 决策项。
- owner 拍板项 / 要真机的：攒着一次性问，别拦路（owner 已授权 AI 代拍有调研支撑的定论）。

## D 批几个坑先知道
- **D 不是"前端为主"，是前端 + 后端 + Electron 壳混合**（跟 C 不同）：D2 定时任务/D3 语音/D4 全局快捷键都重度动 `desktop/src/*.js`。真机验收（说话转字、Alt+Space 小窗、定时真跑真通知）归 **G2**，本轮只出代码 + 测试 + `node --check`。
- **D2 定时任务用现成 F1 通知层**（F-9 `server/services/notify_service.py` + `GET /notifications` + Electron 通知桥，已在 main）——**别重造通知**。桌面 app 不常驻的现实：任务在 app 启动时**补跑睡过点的最近一次**（Claude Code 同款语义）；「开机自动启动」开关 `app.setLoginItemSettings` 默认关。
- **D3 语音输入的 whisper 不在安装包里**（2026-07-02 改按需下载，包 1.7G→500M）——语音必须**共用口播的「模型就绪门」**：没下载完前麦克风灰掉 + 大白话提示。别假设 whisper 已就位。
- **D1 砍鸡肋**：灰色技能（上钟/追分/交友获客/人设）**保留不删**（PPT 在册·owner 铁律不消毒），但要确认它们**只在 `billiards_mode` 台球注册表内、绝不漏进通用模式**（顺带修台账 #55「通用模式子代理泄漏台球工具」）。删的是 `commit`/`review` 两个开发者技能 + 3 个 MCP 预设 + 开发机遗留的 5 个测试 server。
- **D8 高德 / whisper 托管等有 owner 行动项**（高德 Web API key 走 owner 网关代持、whisper 权重托管服务器）——先问 owner，别猜 key。
- 拿不准的、需要 owner 配合的（密钥 / 真机 / key / 拍板）→ 先问 owner，别猜。

## 不归你的（别顺手做）
- **C 批留给 G2 的欠账**（见台账「🏁 C 批收官」节）：C 的简报卡/场景卡/追问 chips/报表检测的**视觉+真机验收**、**e2e-pw/run.js 为新欢迎屏整体更新**（欢迎屏大改·旧断言必挂）、几个 Minor（差评卡图标/海报 chip `!m.kind`/scan effect 门控）。这些归 G2 或后续，不归 D。
- **F/C 批挂着的待 owner 拍板项**（密钥轮换+git 历史重写、GPT 出图从大陆超时→异步化编排、发布线去留、F-3b 成本/F-5 危险命令等）——都在台账「待 owner 拍板/知会」节，是 owner 行动项/别的批次，**不影响你 D 批，别去动**。旧 Python Agent 付费评测入口已经退场，Agent 循环行为改跑 TS smoke。
- 主计划 **E3「GPT 出图异步化」** 编排（做 E 才相关，你做 D 不用管）。

## 你的第一步
读完上面三份权威文档 → 按主计划「批次 D」节 grep/读真实代码把落点定死（D1 先摸清各注册表/技能/MCP 预设的真实位置；D2 摸清 `reminders.py` + F-9 `notify_service` 接口）→ 拆工作单 → 从 `main` 起 `batch-d-capabilities` → 照工作法一单一单推。有疑问先问 owner。
