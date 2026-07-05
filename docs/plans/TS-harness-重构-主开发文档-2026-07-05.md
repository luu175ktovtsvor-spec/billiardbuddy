# TS Harness 重构 · 主开发文档

> 📌 状态:🚧进行中 · 本窗口(2026-07-05)落文档 · **下一窗口起按 Superpowers 开发规范逐 Phase 开工**
> 本文件是"换 TS、以 harness 为地基重写后端"的**权威主文档**。所有 Phase 的施工细节以此为准;每个 Phase 开工前用 Superpowers `writing-plans` 把该 Phase 拆成实现计划,再 `executing-plans`/子代理执行。

---

## 0. 新窗口先读这段(怎么用这份文档)

- **一句话目标**:把现有 Python/FastAPI 后端**换成 TS**,以一套**照着 Claude Code 重写的 agent harness 为地基**;地基全做完,再往上挂"生图 / 剪视频 / 记忆 / 台球知识库"等衍生模块。**先后端,前端暂缓。** 出 **Mac + Windows** 两个版本。
- **这份文档从哪来**:2026-07-05 一整轮 brainstorm(owner 拍板)——逆向了 4 个竞品 + 读了 cc-haha(Claude Code 泄露源码本地版)一手源码 + 联网核了 Windows/Node 生态。结论已内嵌本文,过程看 `docs/references/竞品拆解/01-04` + 会话内三张看板(配色走法B无关本项)。
- **怎么开工**:brainstorm 阶段已完成(本轮)→ **本文档 = 设计 spec** → 下一窗口对某个 Phase 跑 `writing-plans` 出分步计划 → `executing-plans`/`subagent-driven-development` 执行 → 每 Phase 过验收门。**一个 Phase 一个(或几个)窗口,别一窗吞全部。**
- **改前必读**:§1 铁律、§5 沙箱专章、§9 Superpowers 执行说明。

---

## 1. 决策与铁律(不可改,改需 owner)

> **⭐ 总原则（owner 2026-07-05，最高优先）：整个后端照 cc-haha 的逻辑/做法重写——地基逐块照它做，「人家怎么做我们就怎么做」（行为与结构对齐、地基不自创架构、不加码）。生图 / 视频等是在这地基上的正常衍生、保证功能可用即可（不追求超越；所需依赖/模型/二进制随便下、打进包，体积/下载无所谓）。唯一边界 = 下方铁律 2（照着重写、不把 cc-haha 的源码文件原样打进要卖的产品）。**

1. **换 TS**。理由:要"真对标"就抄源头 CC,而 **CC/cc-haha 本身就是 TS**——同语言,harness 照着重写是 1:1、零跨语言摩擦;沙箱是 npm 包、MCP 官方 SDK 是 TS 原生。(注:换语言不是"对标"的必要条件——CC 自己是 Node 就是证据。)
   - **⚠️ 范围与工期真相(owner 2026-07-05 知情后仍拍板全 TS)**:后端共 **~7 万行**,harness 只占 **~19%**(1.35 万行,这块照 cc-haha);**另 ~81%(5.7 万行:生图/视频/剪辑/店脑/RAG/canvas/数据回传/建表/解密…)没有 cc-haha 可参考,是把我们自己已跑通、测试全绿的 Python 从零翻译成 TS——纯翻译、功能不涨、要全部重验**。全 TS ≈ **20 周**量级(只换前端+壳 ≈10 周);owner 选全 TS,接受翻倍工期,换"一套语言 + 彻底甩掉 PyInstaller 打包痛点"。详细重写清单见**附录 B**。
2. **照着重写、不搬源码**。cc-haha 是 Anthropic 泄露源码(已被 DMCA),**照着它的做法用我们自己的 TS 重写(reimplement),绝不把它的源码文件原样打进要卖的产品**。唯一例外:沙箱 `@anthropic-ai/sandbox-runtime` 是**公开发布的 npm 包**,直接装直接用(合法)。
3. **本轮 = 重写整个软件到"直接可用"终态**（owner 2026-07-05 拍板"直接重写"）。顺序上后端优先，但**前端也在本轮内**（原"暂缓"作废）——终态要 Mac+Windows 装上直接能用。**前端用我们自己的小白产品设计**（配色走法B / 文案6条 / 创作界面收敛4件在此落地），**不照 cc-haha 的开发者 UI**：后端 harness 照 CC、**前端是我们的**。
   - **⭐ 战略（owner 2026-07-05）:TS 版 = 替代现 Python 产品**。「商品化收官」等 Python 线冻结/退场，**TS 成唯一产品**。Python 相关文档转历史（见 docs/README 归档）。
   - **双平台都本轮到位**:Mac + Windows 都要装上直接可用（Windows 真沙箱/中文字体是硬骨头、同批做）。
4. **地基优先,衍生后挂**。harness 地基**全部做完**才往上衍生生图/剪视频/其它。
5. **Mac + Windows 双版本**。沙箱等平台差异见 §5。
6. **保留的产品红线**(跟旧后端一致,不因换语言丢掉):审批闸只卡对外/不可逆动作 · 全本地 · 免登录单用户 · 内置 key 走网关藏 key · 改文件前自动备份可回滚 · 台球是可 @挂载领域包不是产品边界。
7. **不是从零建 harness**。现有 Python `services/agent/` 已有一套挺全的 harness(循环/工具/沙箱/审批/压缩/提醒/轨迹/打转检测/MCP/技能/钩子)。换 TS = **逐块移植现有 harness + 顺手把最弱两块(OS 真沙箱、环境定向)换成 CC 的做法**。这决定了工期是"一块一块搬+测",可控。

---

## 2. 技术栈选型

| 项 | 选择 | 说明 |
|---|---|---|
| 语言 | **TypeScript** | 对标 CC、同语言好搬 |
| 运行时 | **Bun（已定 · owner 2026-07-05）** | 跟 cc-haha 同。⚠️ 两条 Phase 0 必办:① **后端跑法 = Bun sidecar 进程**（Electron 主进程是 Node、Bun 进不去,后端作为独立进程随 Electron 启停,参考 cc-haha 的 Bun+Electron 打包）;② **Phase 0 搭 Bun 时顺手验原生插件能跑**——whisper `.node` / ONNX runtime / sharp 走 N-API,Bun 的 N-API 兼容在追赶但不保证,Phase 0 装依赖时把这三个各跑一次确认（是搭环境的一部分,不是单独的验证阶段）;**万一某个在 Bun 下不通,就那一块回退**(用 Node 子进程跑该模块 / 换纯 JS 实现如 transformers.js),不影响其余一路 Bun。 |
| 桌面壳 | Electron(沿用) | 已有 `desktop/`,壳基本可复用 |
| 测试 | Phase 0 定(bun test / vitest) | 对标现有 pytest 覆盖度 |
| 沙箱 | `@anthropic-ai/sandbox-runtime`(Mac/Linux)+ Windows 原生 launcher | 见 §5 |
| 图像 | **`sharp`** 🟢 | 免编译预编译 libvips;Electron 要 `asarUnpack` |
| 视频 | **spawn 打包的 ffmpeg/ffprobe 二进制** 🟢 | `ffmpeg-static` 打进包;`fluent-ffmpeg` 维护慢、只当可选糖 |
| 本地转录 | **whisper.cpp 的带 prebuild 的 Node 绑定** 🟡 | 引擎同 whisper.cpp、质量不掉档;**坑在打包**——要预编译 `.node`(选带 prebuild 的绑定,或 CI 出各平台 `.node` 打进包),别选装机时编译的 |
| 向量嵌入 | **`transformers.js` + `Xenova/bge-m3`** 🟢 | 多语言含中文、ONNX、免原生编译、Electron 友好;直接顶替 bge-zh(bge-m3 中文更强) |
| MCP 客户端 | **`@modelcontextprotocol/sdk`(官方 TS SDK)** 🟢 | 跟现用 Python `mcp` SDK 同为一方,平迁无风险;stdio 起子进程 |
| DB | Phase 0 定(better-sqlite3 / drizzle) | 对标现 SQLite;PG 兼容按方言兜底的逻辑照搬思路 |

> ⚠️ 打包提醒:whisper 绑定 + ONNX runtime 是**原生插件**,跨平台(mac x64/arm64 · win x64 · linux)的**预编译 .node 打进 DMG/EXE** 是本次打包最大的活,Phase 0/3 都要盯。sharp/ffmpeg 同理要 `asarUnpack`。

---

## 3. 架构分层(地基 / 衍生 / 基础设施)

> 现有 Python 模块 → 分类 → 换 TS 时的落点。**地基先做(Phase 1),衍生后挂(Phase 2),基础设施随需跟上。**

### 3.1 地基 · Harness(Phase 1 全做完)
| 现 Python 模块(`server/services/agent/` 除非注明) | 职责 | 换 TS 参考 cc-haha |
|---|---|---|
| `loop.py` | ReAct 主循环(想→调工具→回灌) | `src/query.ts` |
| `registry.py` | 工具分层登记(general/billiards) | `src/tools.ts` / `Tool.ts` |
| `local_tools.py` | 本机文件工具 + **应用层沙箱** | `src/tools/File*Tool` + `utils/permissions/pathValidation.ts` |
| `web_tools.py` | 网页查抓工具 | `src/tools/WebFetchTool` 等 |
| `approval.py` + 权限系统 | **审批/权限照 cc-haha 机制**（owner 2026-07-05 拍板;权限三档已照搬 CC）——权限三档 + 工具级 allow/ask/deny（deny 优先）+ "可逆性/爆炸半径"心智模型 + "授权只在指定范围·批准一次≠永久" + Bash 危险命令分类器。**但默认口径按我们产品调、红线不松**（见 §1 铁律 6）:① 本地文件读写（带备份）默认**直接做**（不像 CC 默认要确认——小白嫌烦）;② 对外/花钱/不可逆动作（发布/群发/私信/删数据/生图）弹**审批卡** + **绝不自动触达**（比 CC 还严一点） | `utils/permissions/` 全套 + `prompts.ts:getActionsSection` |
| `context.py` / `context_overflow.py` | 上下文管理 / 压缩 | `src/query.ts:399-471`(压缩栈) |
| `reminders.py` | 提醒/steering 注入(**定向**) | `utils/attachments.ts` |
| `transcript.py` | 完整轨迹落盘 JSONL(**跨轮记忆管道**) | `src/context.ts` + memdir |
| `stuck_detector.py` | 打转检测(**我们已有**) | (补工具死循环 4/40,抄腾讯) |
| `denial_tracker.py` | 拒绝跟踪 | `utils/permissions/denialTracking.ts` |
| `goal_hook.py` | 目标自检钩子 | — |
| `message_repair.py` | tool_call 截断修复 | — |
| `tool_result_store.py` | 大工具结果落盘 | — |
| `multimodal.py` | 多模态送图 | — |
| `mcp_client.py` / `mcp_config.py` | MCP 客户端 | `@modelcontextprotocol/sdk` |
| `skills.py` / `plugins.py` | 技能 / 插件 | `src/skills/` `src/plugins/` |
| `hooks.py` / `hooks_config.py` | 事件钩子 | `src/hooks/` |
| `output_styles.py` | 输出风格 | `src/outputStyles/` |
| `shadow_git_hook.py`(+ `services/shadow_git.py`) | 改文件前影子 git 备份 | — (我们特有,保留) |
| `checkpoint_index.py` | 检查点/恢复 | — |
| `background_tools.py` | 后台任务 | — |
| `computer_tools.py` | computer use(截屏/点击) | `src/tools/` computer 类 |
| `ai/factory.py` `base.py` `failover.py` | 模型出口(内置 key + base_url + 降级) | `src/…/model-provider` |
| `ai/prompt_engine.py` `prompt_pack.py` | Prompt YAML 模板引擎 | — (我们特有,保留;prompts.enc 加密也保留) |
| **新增(补 CC 的强项)** | **`<env>` 环境块 + git/工作区快照注入** | `constants/prompts.ts:640-710` + `context.ts:96-189` |
| **新增** | **plan 模式**(唯一可写 plan 文件、跟沙箱白名单咬合) | `utils/messages.ts:3324-3409` |
| **新增** | **OS 级真沙箱**(见 §5) | `utils/sandbox/sandbox-adapter.ts` |
| **新增** | **文件夹工作区模型**(选文件夹当工作区、边界即方向) | Codex workspace-write(`04` §6) |

### 3.2 衍生模块(Phase 2,挂在地基上)
| 现 Python | 归属 |
|---|---|
| `tools.py`(运营工具) | 领域工具 |
| `image_tools.py` + `services/poster_service.py` + `poster_styles.py` + `ai/providers/*image*`(seedream/openai/siliconflow/dashscope) | **生图** |
| `video_edit_tools.py` + `services/video_service.py` + `services/video_edit/` + `services/scene_plan/` + `ai/providers/ark_video` | **剪视频/视频创作** |
| `services/memory_service.py` + `services/rag/` | **领域记忆 + RAG**(管道在地基,内容/逻辑是衍生,见 §6) |
| `services/{content,outreach,brand_voice,behavior,diagnosis,dashboard,games,report_reader,workbench_fewshot,scenario_role_map}_service.py` + `scenario_catalog.py` | **台球领域运营**(可 @挂载知识库) |
| `services/canvas_service.py` + `canvas_docedit.py` + `canvas_io.py` | 画布/文档编辑 |
| `amap_tools.py` / `im_telegram.py` / `proactive.py` | 领域工具 / IM / 主动 |

### 3.3 基础设施(随需跟上)
备份存储(`db_backup`/`shadow_git`/`storage_service`)· 数据回传(`data_sync/`)· 配额用量(`quota_service`/`usage_event_service`)· BYOK(`byok_profiles`)· 通知与媒体任务(`notify_service`/`media_job_notify`/`media_jobs_service`/`media_jobs_runner`)· 定时(`daily_scheduler`/`scheduled_tasks`)· 门店(`store_service`/`store_profile_service`)· 知识清单(`knowledge_manifest`)· **网关**(`gateway/` 藏 key,不变,TS 后端只需指向它)。

---

## 4. 分期实现计划

### Phase 0 · 立项脚手架
- 新分支(命名如 `ts-harness-rewrite`)· TS 工程骨架 · **定运行时(Bun/Node)+ 后端在 Electron 里怎么跑** · 测试框架 · CI 骨架。
- 把 §1 铁律(尤其"照着重写不搬码")写进新工程的 AGENTS.md/CLAUDE.md。
- **验收**:空骨架能起、能跑一个 hello 工具循环、测试框架通。

### Phase 1 · Harness 地基(全做完才往上走)
按 §3.1 逐块移植 + 补强,建议顺序:
1. **主循环** ← `loop.py` / 参考 `query.ts`。
2. **系统提示 + `<env>` 环境注入 + git/工作区快照** ← 补强(我们最弱的定向)。
3. **工具框架 + 核心文件/命令工具 + 文件夹工作区模型** ← `local_tools`。
4. **双层沙箱**(见 §5)← 应用层移植+补 TOCTOU;OS 层 Mac/Linux 装包、Windows 走 launcher。
5. **审批闸 + 权限三档** ← `approval.py`(保红线)。
6. **定向脚手架:plan 模式 + todo + system-reminder** ← `reminders.py` + 补 plan。
7. **压缩 + 上下文 + 完整轨迹** ← `context_overflow` / `transcript`。
8. **打转 + 工具死循环检测** ← `stuck_detector` + 补 4/40(抄腾讯)。
9. **子代理 + skills + hooks + commands + output styles** ← 各对应模块。
10. **Model provider 层**(内置 key 走网关)← `ai/factory`。
- **验收门**(每块 + 整体):对应单测通 · 一条真任务端到端(建文件夹当工作区→读写→改文件带备份→出错回灌)· 沙箱越界被挡 · `<env>` 块确实注入 · 审批卡对外动作弹出。

### Phase 2 · 衍生模块(挂在地基上)
按 §3.2 顺序挂:**记忆系统(管道已在地基,挂领域逻辑)→ 生图 → 剪视频 → 台球知识库(可 @挂载)→ 画布/其余**。每个模块:接地基的工具/审批/媒体任务框架,复用其 provider/service 逻辑(翻 TS)。
- **生图 / 视频定位(owner 2026-07-05)**:在地基上的**正常衍生,保证功能可用即可**,不追求超越竞品;所需依赖/模型/二进制**随便下、打进包,体积/下载不设限**。
- **验收**:各模块真出活(生图落盘 / 视频出片 / 记忆学到并召回 / 挂台球包后人设+工具生效)。

### Phase 3 · 平台打包(Mac + Windows)
- **桌面壳 / 后端拉起 / 打包 / 自动更新 = 照 cc-haha 的 plumbing**（同构、可近乎照搬，且顺手解我们几个 P0）:后端 = **Bun 编译单文件二进制 → Electron spawn → 等端口就绪(`waitForServer` TCP 轮询) → 前端连**。白捡的:**端口策略(固定→sticky→随机)解"端口占用"· `taskkill /T`+退出同步杀解"backend 孤儿"· 启动日志捕获解"首启超时排障"· electron-updater+CI 矩阵+未签名兜底(带 install-macos-unsigned.sh)解"苹果签名卡点"**。参考 `desktop/electron/services/{serverRuntime,sidecarManager}.ts` + `desktop/scripts/build-sidecars.ts`。
  - ⚠️ **全 TS 重写必踩的两坑**:① macOS 上 Bun 编译的二进制签名是坏的(load code signature error 4 → 被 SIGKILL),要 `codesign --remove-signature` 再 ad-hoc 重签;② Windows 用 `bun-windows-x64-baseline` 目标(兼容老 CPU,否则老机器起后端崩)。
  - ⛔ **UI/onboarding 不抄 cc-haha**(它是开发者工作台:终端/选项目文件夹/BYOK登录贴key)——我们保留自己的小白单窗口对话+创作面板+**内置 key 免登录 seed**(见 Phase 4 + §1 铁律 6)。
- Electron 打包 · **Windows 真沙箱 launcher**(见 §5)· 内置资产打进包(whisper 预编译 `.node` / ffmpeg 二进制 / bge-m3 ONNX / sharp libvips,全部 `asarUnpack`)。
- **验收**:Mac dmg + Windows nsis 装干净机、开箱即用(内置 key)、沙箱在两平台各自生效、whisper/生图/视频真跑通。

### Phase 4 · 前端（本轮必做 · 用我们自己的小白产品设计）
> 原"暂缓"作废——终态要直接可用，前端必须做。**在 Phase 3 打包前完成**（打的是含前端的整包）。
- 前端整套重写、接新 TS 后端（SSE/接口对齐）。**用我们为台球店主做的设计**，把本轮前面拍的前端决策落地:
  - **配色走法 B**（砍蓝 #007AFF / 绿 #10a37f 降点缀 / 主按钮+用户气泡走中性），见设计规范 §2。
  - **文案 6 条**（自称"我"+"管家" / 中性白话+修字符 / 系统提示走 toast / 动作按钮 3 图标+「…」/ 复制到微信→复制 / 长 prompt 气泡修全套），见 `前端文案与交互规范-改造清单`。
  - **创作界面收敛 4 件**（主窗对话+画布 + 一个"工作台"窗口 / 废旧剪辑台 / 做成视频跳工作台 / 对话流只放替身卡），见 `创作界面信息架构收敛-方案`。
- **不照 cc-haha 的开发者 UI**（它是给程序员的终端/IDE 风；我们是小白台球产品）。
- 详细组件清单（对话窗/审批卡/权限档/画布/生图视频工作台/设置/欢迎页/简报卡/记忆面板…）等子代理盘点回来补入本节。

---

## 4.5 · 逐窗清单（14 模块 · owner"一窗一模块"）

> §4 是分期，这里拆成 **14 个可执行窗口 = 14 个模块**（owner 规矩：一个窗口负责一个模块）。**顺序**：地基 W1-W6 先做完 → 衍生 W7-W10 可并行 → 前端 W11-W12 在打包 W13 前完成 → W14 收尾。

| # | 模块（窗口） | 层 | 主要内容 |
|---|---|---|---|
| **W1** | 立项脚手架 | 地基 | 新分支 · Bun 工程 · Electron spawn sidecar · 测试/CI（照 cc-haha plumbing 起步）|
| **W2** | Harness·核心 | 地基 | 主循环 + 工具框架 + 文件夹工作区 + 环境注入(`<env>`) |
| **W3** | Harness·沙箱 | 地基 | 双层：Mac/Linux 装 sandbox-runtime + Win（app 护栏+Job Object launcher，见 §5）|
| **W4** | Harness·其余 | 地基 | 审批权限(照 CC) + 定向(plan/todo/reminder) + 压缩/轨迹 + 死循环 + 子代理 + skills/hooks |
| **W5** | 数据层+基础设施 | 业务地基 | 建表/seed/多租户/config/Fernet 解密/备份/影子 git/数据回传（见附录 B.2）|
| **W6** | 模型出口+网关 | 业务地基 | factory/providers/prompt 引擎（= §11 模型编排：接现有几家 + 易扩展）|
| **W7** | 记忆 | 衍生 | 管道(照 memdir) + 领域(店脑/RAG)（见 §6）|
| **W8** | 生图 | 衍生 | poster + 各 image provider（保可用、依赖随便下）|
| **W9** | 视频 | 衍生 | video_service + video_edit(3.5K) + scene_plan + 离屏渲染 |
| **W10** | canvas + 看板报表 + 领域服务 | 衍生 | 改文件 + dashboard/report + content/store_profile 等领域服务群 |
| **W11** | 前端·对话核心 | 前端 | chat-shell/thread/composer + SSE 12 事件契约（我们的小白设计 · 见附录 B.1）|
| **W12** | 前端·创作+设置 | 前端 | 画布/studio/video 工作台/设置/记忆面板 |
| **W13** | 桌面壳+打包+自动更新 | 壳/发版 | 照 cc-haha plumbing + IPC + 首启 + 内置资产 + 双平台出包（见 §10.4 体积）|
| **W14** | 端到端真机验收 | 验收 | Mac + Win 各装干净机走全链路 + §10.3 试用就绪清单 |
| **W15** | 🔎 终审 · 查验审核 | 收官 | **owner 自己开、用 Opus 4.8（非 Sonnet）**：对全部 14 窗产出**逐项查验审核**——对照铁律/验收门/§10 试用就绪/白标/文案红线，交叉核 + 对抗验证、逮漏补缺，签发"可给人试" |

> 大模块（W2-W4 harness / W9 视频 / W11 前端）若一窗吞不下，可再拆半窗——但保持"一窗一模块"的边界清晰、别一窗吞多模块。每窗按 §9 走 Superpowers（writing-plans → 先测后码 → 过验收门）。
>
> **⚙️ 模型分配（owner 2026-07-05）**：**W1-W14 的执行子代理默认 Sonnet**；**W15 终审用 Opus 4.8**（owner 直接开、不派 Sonnet）。
>
> **🧪 真机测试（W14 验收 / W15 终审）**：能做真机就做——真打包 → 装干净/真 Windows 机 → 走全链路。**方法 = 项目自带 `fullstack-e2e` 技能**：Playwright-Electron 驱前端（DOM + 截图 + `electronApp.evaluate` 查主进程）+ 读后端日志/API + **Claude 自己看截图做视觉判断** + 自动把问题归因到 前端/后端/传输 三边；交互验收另用 `native-devtools-mcp`（macOS）。
> ⚠️ **测试技能要更新到新栈**：现有 `fullstack-e2e` + `desktop/e2e-pw/run.js` 是照当前 **Python(8077)/Next.js** 栈写死的（端口/路径/后端类型/选择器）；TS/Bun 重写后这些全变。**做法**：写死的部分（端口/启动方式/选择器）**显式改**，动态探索让测试窗口自己摸；**时机 = W13 打包把新端口/路径定了之后更新它**，W14/W15 再用。

## 5. 沙箱专章(双层 + Mac/Win 差异)

**威胁模型先说清**:我们防的是"**乖乖听话的 AI 工具手滑 / 被注入的输入使坏**",不是"对抗性恶意软件"。而我们**已有** app 层护栏(审批闸卡对外 + 改文件前备份 + 路径沙箱)覆盖了大半风险。所以 OS 沙箱是"再加一层兜底 + 让工作区内敢自动放行",不是唯一防线。

### 第一层 · 应用层(跨平台,移植我们现有 + 补强)
- 路径校验 + 越界拦(移植 `local_tools._resolve`)+ **补 CC 的 TOCTOU 防护**:UNC 路径 / `~user` 波浪号变体 / `$()`/`${}` 展开 / 写操作禁 glob / 删根检测(`rm /`、`rm ~`)。参考 `pathValidation.ts:141-489`。

### 第二层 · OS 真沙箱(平台分叉)
- **Mac / Linux 🟢**:直接装 `@anthropic-ai/sandbox-runtime`(Anthropic 公开包)。Mac=`sandbox-exec`+Seatbelt(零额外依赖),Linux=bwrap+seccomp。种子"可写=工作区文件夹、禁写=配置/技能目录",命令关进 OS 盒子跑。**有了这层才敢"工作区内命令自动放行、不弹确认"**;沙箱配置实时序列化进工具说明给模型看。
- **Windows ⚠️(尽力而为 + 原生 launcher)**:
  - `sandbox-runtime` 的 Windows 是 **alpha、官方明说"不是安全边界"**:只做 WFP 出站网络拦截 + ACL 文件 deny(**仅 deny、无白名单、连目录都不支持只能按单文件**),要**管理员装 + 注销重登**——分发体验差。**只能当"尽力而为层",不能当真隔离。**
  - **推荐主线**:**app 层护栏(审批+备份+路径沙箱)为主** + 抄 **Codex 的原生 launcher** 补一刀——`CreateRestrictedToken`(write-restricted + 合成 SID 二次写检查)+ `Job Object`(进程/资源围栏、**免管理员**)起子命令;网络要不要挡看是否上 WFP(要管理员)。Codex 的 `windows-sandbox-rs` 是它仓库里开源的参照(只为 Codex 定制、非通用库,照思路重写)。
  - 需写**原生代码**(Rust/C++ 编 helper.exe,Node 用 `child_process` 调)——这是 Windows 唯一能真隔离的路,没有"装个 npm 包就完事"的。
  - **盯一手**:微软 2026 Build 开源的 **MXC(跨平台内核级沙箱)**,成熟后可能比自研 launcher 省,现太新先观望。
- **✅ owner 2026-07-05 定**:Windows **首发 = app 护栏（审批+备份+路径沙箱，已有）+ Job Object（免管理员）起步**;restricted-token / WFP 那套（要管理员、分发摩擦大）**放二期、交后续窗口做**。首发降分发摩擦为先,真隔离二期补。

> 版本号提醒:`sandbox-runtime` 的 npm 页 403、精确版本没抓到,开工时 `npm view @anthropic-ai/sandbox-runtime version` 自核。

---

## 6. 记忆归属(回答"记忆是地基还是衍生")

> ✅ **owner 2026-07-05 定:记忆机制照 cc-haha 做**（它就是 Claude Code 本尊，按人家的来）。地基那半的"记忆管道"直接学 cc-haha 的 `src/memdir/`——记忆文件 + 扫描 + 相关性召回 + 时效/老化 + 类型 + 经 `context.ts:getUserContext` 注入。
> ⚠️ 两点注意:① 我们的**领域记忆是结构化的**（店脑记忆 DB + 门店画像 + 台球 RAG），不是 CC 那种纯 markdown 记忆文件——所以是"**学它的扫描/召回/时效/注入机制，套在我们结构化的领域记忆上**"，不是把店脑改成一堆 md 文件；② cc-haha 的记忆是 **CC 本尊、轻量得当**，不是竞品拆解 `04` §3 判为过度工程的 Qoder 六维健康度 / W-TinyLFU 那套重机器——照 CC 做即可，别加码。

**切成两半**:
- **地基(harness 提供的"管道")**:① 上下文注入机制(把持久上下文/CLAUDE.md-类内容装进系统提示,参考 `context.ts:getUserContext`)· ② 完整轨迹落盘(`transcript.py` 已做,JSONL 全历史)· ③ 一个记忆存取/检索的**接口**(参考 cc-haha `src/memdir/` 的 scan/relevance/types 骨架)。
- **衍生(领域内容与逻辑)**:我们的**店脑记忆**(学门店/偏好)· **RAG**(台球知识库检索)· 记忆抽取/召回逻辑(`memory_service.py` + `rag/`)。这些挂在地基的管道上。

**一句话**:地基管"记忆怎么进出模型",衍生管"记住什么台球/门店内容"。

---

## 7. Node 生态迁移清单(🟢 能用 / 🟡 有坑要验 / 🔴 无替代)

| 能力 | 现(Python) | Node 落点 | 判定 | 关键坑 |
|---|---|---|---|---|
| 图像 | PIL 等 | `sharp` | 🟢 | Electron 要 `asarUnpack`;按目标平台装预编译 libvips |
| 视频 | 调 ffmpeg | spawn 打包的 ffmpeg/ffprobe(`ffmpeg-static`) | 🟢 | `fluent-ffmpeg` 维护慢、只当糖 |
| MCP 客户端 | Python `mcp` | `@modelcontextprotocol/sdk`(官方 TS) | 🟢 | 同门平迁;stdio 起子进程 |
| 向量嵌入 | bge-zh | `transformers.js` + `Xenova/bge-m3` | 🟢 | ONNX q8 约 570MB;bge-m3 中文更强、免编译 |
| 本地转录 | whisper.cpp | 带 **prebuild** 的 whisper.cpp Node 绑定 | 🟡 | 质量不掉;**别选装机编译的**,要预编译 `.node` 或 CI 出各平台包 |
| 备选嵌入 | — | `fastembed-js` | 🟡 | 非一方、ONNX 原生要 prebuild |
| 无成熟替代 | — | — | 🔴 **无** | 三块硬骨头都有可行 Node 路,成本集中在原生插件跨平台预编译打包 |

---

## 8. 风险与待验

1. **Windows 真沙箱**:没有现成 Node 库,要写原生 launcher(Rust/C++ helper.exe)——本次工程最硬的一块。首发可先用"app 护栏 + Job Object(免管理员)"起步。
2. **原生插件跨平台预编译打包**:whisper `.node` + ONNX runtime + sharp libvips 各平台各出一份打进包——打包活最重的地方。但 **owner 2026-07-05 明确"体积/下载无所谓、不用担心这些"**,可放开(大包 / 按需下载都行);**唯一硬要求 = 它们在 Bun 下能跑**(Phase 0 搭环境时验,见 §2)。
3. **sandbox-runtime 版本/稳定性**:0.0.x + Windows alpha 设计在变,盯升级。
4. **whisper Node 绑定活跃度**:`whisper-node-addon` 等社区维护,选型时自查活跃度或自建 CI prebuild。
5. **工期**:换 TS 是整个后端重写(移植+补强),按 Phase/模块一块一块搬+测,别指望一次到位。owner 已表态愿投入、走新分支。
6. **owner 决策（均已定 · 2026-07-05）**:① ~~运行时~~ **定 Bun**（跟 cc-haha 同;残留待验=whisper/ONNX/sharp 三原生插件在 Bun 下能否跑,Phase 0 搭环境时顺手验,见 §2）· ② ~~Windows 沙箱首发范围~~ **定**:首发 app 护栏 + Job Object（免管理员），restricted-token/WFP 放二期、交后续窗口（见 §5）· ③ ~~先 spike 验工期~~ **定:不 spike、直接开发**——下一窗口直接从 Phase 0 起步。

---

## 9. Superpowers 执行说明(下一窗口怎么开工)

- **已完成**:brainstorm(本轮,owner 拍板方向)。**本文档 = 设计 spec。**
- **每个 Phase 一个执行循环**:
  1. 该 Phase 用 `superpowers:writing-plans` 把本文档对应 §拆成分步实现计划(含验收)。
  2. 用 `superpowers:executing-plans` 或 `subagent-driven-development` 执行。
  3. 用 `superpowers:test-driven-development` 先写测试。
  4. 过 §4 对应验收门,`verification-before-completion` 确认再收。
  5. `finishing-a-development-branch` 收尾。
- **一窗一 Phase(或半 Phase)**,别一窗吞全部;Phase 1 各子块也可分窗。
- **代码约定**（owner 2026-07-05）:结构 / 命名 / 写法**照 cc-haha 来、行为对齐它**;**注释从简**——注释不重要、别堆，代码本身读得懂即可。
- **每窗守铁律**(§1):照着重写不搬码 · 保红线 · 先测后码。

---

## 10 · 上线 / 试用就绪（白标不露模型 + 50 人并发 + 最后一公里）

> 这些是"开发完 ≠ 能给人试"的收官要求。10.1 是**铁律级产品要求**（重写必须做到）；10.2/10.3 多为运维/服务器/owner 行动项，不是 14 窗的编码。

### 10.1 ⭐铁律级：白标 · 绝不暴露底层模型（owner 2026-07-05）
- **系统提示永远注入一条**：你是【产品名 / 管家】，**绝不透露、不暗示底层用的是什么模型或厂商**（MiMo / DeepSeek / 豆包 / 火山 / GPT…）；被问"你是什么模型 / 你是不是 GPT"就答"我是[产品名]的助手"，不报模型名、不说"我是 GPT / 我是通义"。落 W4（harness 系统提示）+ 台球 persona。
- **前端任何用户可见处不显示模型名**：studio 成品标签 / 设置 / 状态里都不露；模型选择若保留，藏进高级档。落 W11/W12。
- ⚠️ **现状缺口**：`server/api/v1/agent.py` 的 `_GENERIC_BASE_PROMPT` 只设了"通用助手"身份、**没有 anti-reveal 指令**——重写时必须补上。
- 参照:**这块不抄 cc-haha**——CC 的系统提示是"You are Claude Code"、大方暴露自己（它是模型自家产品），跟我们白标藏模型正相反；竞品拆解也没写"怎么藏模型"。**这是我们自己定的产品要求。**

### 10.2 50 人并发 / key 会不会被打爆——网关已解决（server 端，TS 客户端不重写）
- **机制已建好**：`gateway/`（qfgw CN 39.106.214.21:8799）**三层阀门**——① 每家真实限流（令牌桶+信号量：MiMo 90 RPM / 生图 IPM+在途并发 / 视频并发 3 / 豆包 30 RPM / Seedream）② 每用户每日配额（防一个人烧光挤垮所有人）③ 满了排队（最多等 60s）超时背压拒、绝不硬撞 provider 触发 429/封号。**藏 key + 用量记录**。
- **TS 重写不动它**（server 端服务），客户端 factory 指向网关即可（见附录 B.5）。
- **50 人要额外做的**：文本 90 RPM 对 50 个稀疏用户通常够；**图（18 IPM）/ 视频（并发 3）是紧口子**——多人同时出图出片会排队，要么**加模型账号（网关 README §54 多账号 key 池扩容路）**、要么接受**"排队中·约 X 分钟"诚实 UX**。② **每平台设消费上限**（内置是 owner 的 key，50 人一用/一 bug 循环就烧钱——硬兜底）。③ 每用户每日配额设好。④ 规模再大转 Redis 共享限流 / 企业认证（网关 README 已写路）。

### 10.3 从"开发完"到"朋友 Windows 试用"的就绪清单
- **真机验收**：干净 Windows 装 nsis → 首启不崩/不超时 → **不填 key 免登录直进** → 走完整链路（W14）。
- **给朋友前硬前提**：① **消费上限**（见 10.2）② **Windows 签名 or SmartScreen 绕过指引**（未签名 exe 弹"未知发布者"吓退小白；买签名 / 或给一句"更多信息→仍要运行"）。
- **试用要有意义**：数据回传 + 看板 + 日志回传上线（看他怎么用 / 卡哪 / 报什么错；观察 > 开发）。
- **能迭代**：自动更新链路通（修完推新版、不用重装）。
- **别漏**：台球知识库打包能解密（Fernet）· 三台服务器在线且 TS 客户端契约对上（网关 / whisper 下载 / 数据回传 / 更新私服）· whisper 按需下载他网络可达 · 弱机首启不超时。
- **owner 行动项**：设消费上限 · （可选）买 Windows 签名 · 服务器填 TS 客户端令牌 / 确认 key 余额。

### 10.4 包体积（owner 2026-07-06 确认）
- **对方 cc-haha v0.4.5 参照**：Mac dmg ~185-196MB、Win exe ~165MB、Linux ~150-204MB。
- **我们现状（Python/PyInstaller）**：Mac dmg ~249MB、**Win ~416MB（偏大，PyInstaller + Python 运行时 + fastembed/onnxruntime 撑的）**。
- **好消息**：换 TS/Bun 本身就瘦身——Bun 编译单二进制（~55MB runtime，合并多模式省 100MB+）远小于 PyInstaller 的 Python 全家桶，重写后**自然向 cc-haha 的 ~165-196MB 靠**。"控制体积"换 TS 顺手就做了、不用额外操心。
- **保持**：whisper 权重（~1.4G）按需下载、不进包；base 目标 ~150-200MB。（与早先"体积无所谓"不冲突：那指别为省体积砍功能；这指别 PyInstaller 式无谓臃肿。）

### 10.5 前端/壳 加载与错误文案红线（owner 2026-07-06）
- **不出现"首次启动慢 / 请耐心等待 / 准备数据比较慢 / 需要几秒"这类词**——最多一个干净的"正在启动…"loading，别道歉、别警告慢。
- 现状 `desktop/src/main.js:757` 的启动失败框写了"第一次启动准备数据比较慢"，**重写别搬这类措辞**（换 TS/Bun 启动本来就快、更没必要提慢）。错误提示按文案 6 条：失败只给一件能做的事、别堆抱歉。
- **后台下载（whisper 模型 ~1.4G 等）必须静默、用户无感**——大厂都是"背后悄悄下、功能好了自动可用"，绝不弹"正在下载 X 模型 1.4G，请耐心等待/进度 X%"。⚠️ 现状 `VideoWorkspace.tsx:364/375` + `desktop-composer.tsx:432` 写了"正在下载语音模型 1.4G（仅首次）X%"——**重写去掉下载/进度/大小/请等这类字**。
- **门控方式保留、只删文字**：需要该模型的功能（口播/语音）在就绪前**安静地灰掉**（现有 `useWhisperReady` 门控是对的），最多 hover 一句极简"语音功能准备中"（不提下载、不提 1.4G、不提进度），就绪自动亮。这是大厂那种"该功能在备着"的最小态，**不是"请等待"提示**。

---

## 11 · 模型编排（W6 规格 · owner 2026-07-05"编排一下"）

> ⭐ **owner 2026-07-06 校准(编排的真实意图)**:目标就俩——**① 把现有这几家 key 接好**（MiMo/豆包/Seedream/Seedance/GPT + bge/whisper，见 11.1）;**② 留好"以后加别家模型很简单"的口子**（加一家 = 小改，见铁律 4）。**不追求复杂编排、不急着建降级链**——那些以后想加再加。别过度设计。
>
> 现状:出口很集中——文本/看图/编排=**MiMo v2.5**;VLM/导演=**豆包 doubao-seed-1-6**;生图=**Seedream** 主 + **GPT image-2** 兜(内容启发式路由);视频=**Seedance**(单点);嵌入=**bge** 本地;ASR=**whisper medium** 本地+MiMo 纠错。路由靠"网关按路径 + 生图按内容启发式"。**白标机制已具备**（`BUNDLED_MODEL_LABEL/_IMAGE_LABEL/_VIDEO_LABEL` 解耦显示名与真实模型），但只用在显示层。

### 11.1 模型阵容（TS 重写 W6 照此接）
| 任务 | 主模型 | 兜底（应做成自动降级） | 出口 |
|---|---|---|---|
| 文本对话/生成 | MiMo v2.5 | **豆包文本（已有 ARK key，顺手做兜底）** | 网关 |
| 看图（聊天里） | MiMo v2.5（同文本，壳子塞 image_url） | 同上 | 网关 |
| VLM（剪辑看画面） | 豆包视觉 doubao-seed-1-6 | 智谱 glm-4.6v-flash（**改成自动降级**，现在是手动切 env） | 网关/直连 |
| AI 导演 | 豆包 doubao-seed-1-6 | — | 网关 |
| 生图 | Seedream doubao-seedream-4-5（默认） | GPT image-2（复杂创意/西文主导，内容启发式；易拉宝 2:5、横幅强制回 Seedream） | 网关/relay |
| 生视频 | Seedance doubao-seedance-2-0 | 单点·兜底待定（可选可灵/Vidu，低优先） | 网关 |
| 嵌入/RAG | bge-m3 ONNX（本地离线） | — | 本地 |
| 口播转录 | whisper medium（本地）+ MiMo 纠错 | — | 本地 |

### 11.2 三条编排铁律
1. **白标·不露模型**（= §10.1）:对外只显 `BUNDLED_*_LABEL`;系统提示加 anti-reveal。换底层模型只改 env、前端/提示不动。
2. **可扩展 > 降级链**（owner 2026-07-06 校准）:本轮**只把现有几家 key 接好**即可，**别急着建复杂降级链**。跨模型自动降级（MiMo→豆包 / 豆包→智谱 / 视频备胎）是**以后想加再加**的 nice-to-have——现在结构上留个 fallback 钩子即可，**不必现在选型、不必现在做**。重点是下面铁律 4 的"加模型很简单"。
3. **模型 id 全 env 可配、别硬编码**:`doubao-seedance-2-0-260128` 这类带日期后缀的 id 全走 env 默认值（火山改版本号且无日期=NotFound，别写死代码）。
4. **⭐加模型 = 小改、不动核心**（owner 2026-07-06 主诉求）:模型层做成**清爽的 provider 注册 / 适配器模式**——加一个新模型 = 加一个小 adapter + 一行注册 + env 配 key/label，**不碰主循环 / 工具 / 前端**。现有几家（MiMo/豆包/Seedream/Seedance/GPT/bge/whisper）照此接好;后期加别家直接照葫芦画瓢、几分钟的事。

### 11.3 顺手清理（TS 重写不搬这些死码/冗余）
- 生图注册表 `register_image("openai",…)` = 死码（实际全走 `build_image_provider(base_url)`），不搬。
- BYOK 生图目录里 **MiniMax / 腾讯混元只登记未实现（调到直接报错）**，不搬（要么实现要么删）。
- `orchestration_*` 空配置（留了切 GLM-4.6 的口子没接线），TS 里要么接线做编排大脑降级、要么删。
- `deepseek` / `DEEPSEEK_*` 命名是历史遗留（实际跑 MiMo），TS 里正名（如 `text_*`），别再叫 deepseek 误导。

### 11.4 并发（接 §10.2）
50 人并发靠网关三层阀门（限流+每人配额+排队背压），**TS 客户端不重写网关、指过去即可**;图/视频紧口子加模型账号或排队 UX。

---

## 附录 · cc-haha harness 参考文件地图(照着重写时的索引)

| 部件 | cc-haha 位置(`src/`) |
|---|---|
| 主循环 + 压缩栈 | `query.ts`(`:399-471` 压缩) |
| 系统提示装配 | `constants/prompts.ts`(`getSystemPrompt :444-577`) |
| `<env>` 环境块 | `constants/prompts.ts`(`computeSimpleEnvInfo :651`) |
| git 快照 / CLAUDE.md 注入 | `context.ts`(`:96-189`) |
| OS 真沙箱适配 | `utils/sandbox/sandbox-adapter.ts`(`:172-381`) |
| 沙箱说明给模型 | `tools/BashTool/prompt.ts`(`:172-273`) |
| 应用层路径沙箱 + TOCTOU | `utils/permissions/pathValidation.ts`(`:141-489`) |
| 审批 / 权限 | `utils/permissions/`(整个目录) |
| plan 模式 | `utils/messages.ts`(`:3324-3409`)+ `utils/planModeV2.ts` |
| todo / reminder 注入 | `utils/attachments.ts`(`:3262-3313`)+ `utils/todo/` |
| 子代理 / 工具框架 | `tools/AgentTool/` · `Tool.ts` · `tools.ts` |
| 记忆 | `utils/context.ts`(注入)+ `src/memdir/`(逻辑) |

> ⚠️ 附录只作"照着重写"的定位索引,**不得把 cc-haha 源码文件搬进本仓库**(见 §1 铁律 2)。

---

## 附录 B · 全量重写盘点（前端 / 后端业务 / 桌面壳 / 打包 · 供逐窗施工）

> 全 TS 重写，除 harness（附录顶部那张地图）外，下面这些都要重建/翻译。规模是估工底数。**harness ~1.35 万行照 cc-haha；下面 B.2 的 ~5.7 万行业务无 cc-haha 参考、是 Python→TS 翻译主战场。**

### B.1 前端 `web/src`（~12.2K 行 / 57 文件 · 用我们自己的小白设计重写）
- 单窗口:`/` → `/dashboard/chat` → 只渲染一个 `DesktopChatShell`（SaaS 登录已删、middleware 空穿透）。
- **四个千行级"上帝组件"（重写重点，可顺手拆）**:`chat-shell.tsx`(1187,总编排:侧栏+对话流+输入+所有抽屉) · `chat-thread.tsx`(1137,对话流展示) · `preview-panel.tsx`(1042,右侧画布 Artifacts/Canvas) · `lib/api.ts`(966,**承重契约**)。
- **承重契约 = 任务式 SSE 12 事件**:token / reasoning / tool_call / tool_result / tool_progress / approval_request / ask_question / steering / context_note / todo_update / final / done / error——新前端必须对齐这 12 个。
- 其余组件:`desktop-composer`(输入框+**权限三档**+语音门控+知识包挂载开关) · `settings-drawer`(797) · `welcome-screen` · `briefing-card` · `store-memory-panel`(店脑CRUD) · `store-docs-panel` · `scheduled-tasks-panel`(426) · `studio/video/workbench` 三个创作工作台 · `studio-mask-canvas`(konva 圈选 mask) · `app/quick`(全局热键悬浮窗)。
- 状态:**无 Zustand/Redux**,全在 `use-agent-chat.ts`(625:send→SSE→审批→5次指数退避重连→steering) + 两个 Context（`auth`本地owner免登录 / `toast`）。
- 桌面 IPC 契约:`window.electron`（files/captureScreen/quickInput/notification/tts/models(whisper)/publish/video/newWindow）——**无后端端点、纯 IPC，新壳必重做**。
- 依赖:next14/react18 · react-markdown+remark-gfm（**无代码高亮库**）· lucide · konva · **无组件库（全手写，重写可考虑补齐 shadcn 类）**。

### B.2 后端业务（非 harness · ~57K 行 · 全 TS 翻译主战场、无 cc-haha 参考）
- **生图**:`poster_service`(1367) + `image_tools` + `ai/providers/{siliconflow,dashscope,seedream,openai}_image`。
- **视频**:`video_service` + **`services/video_edit/`(3566:assemble/vlm/director/footage_qc/planners/template_render/render/edit_agent/timeline/transcribe)** + `scene_plan`(310) + `ai/providers/ark_video`。
- **改文件**:`canvas_service` / `canvas_docedit` / `canvas_io`。
- **领域服务**:`content_service`(1166) · `dashboard_service`(901) · `store_profile_service`(727) · `memory_service`(661) · `report_reader`(427) · `brand_voice/behavior/diagnosis/games/workbench_fewshot_service` · `rag/` · `scenario_catalog/role_map`。
- **模型出口**:`ai/factory`(内置key/网关/BYOK 硬规则"绝不静默回退平台key") + providers + `prompt_engine`(171 模板单例) + `prompt_pack`(Fernet 解密)。
- **数据层**:`db/init_local`(`create_all` **无 Alembic** + `_reconcile_columns` 老库加列 + `_seed_local_owner` 免登录seed) · `db/types`(GUID/JSON 方言兜底) · `db/session`(SQLite WAL) · **12 表 / 11 model**。
- **基础设施**:`data_sync/`(collector/uploader/machine_id 上行管子) · `db_backup`(SQLite 在线备份) · `shadow_git`(改文件前快照回滚) · `config`(pydantic-settings) · `core/tenant`(多租户 contextvar，**fail-safe 无租户=空，仅盖 generations/usage_quotas，其它表靠手写 where——移植隐患**) · `api/deps`(免登录返回 seed owner/店)。
- **API 路由 ~2850 行**(agent.py 2185 归 harness):studio(481)/video_edit(482)/canvas(407)/stores(350)/store_memory(205)/scheduled_tasks(191)/store_docs/checkpoints/dashboard/quota/backup/voice/notifications。
- ⚠️ **PG 专属 SQL**(jsonb/make_interval/advisory_lock)按方言兜底散在 quota/memory/collector——翻 TS 时逐个核，SQLite 兼容别丢。

### B.3 桌面壳 `desktop/`（~80 JS · 照 cc-haha plumbing 重搭，见 Phase 3）
- `main.js`(50KB):窗口体系(mac hiddenInset红绿灯 / win titleBarOverlay·Mica 需 Win11) + 全部 IPC + splash/快捷输入窗(热键 Cmd/Ctrl+Shift+Space)/workbench 单例窗/离屏渲染窗。
- `backend.js`:拉后端（换 TS 后=Bun 二进制 sidecar，**照 cc-haha**）+ 端口(换 cc-haha 的 固定→sticky→随机) + 启动超时 180s + tree-kill 防孤儿 + **注入全环境变量**(DATABASE_URL=userData/billiards.db / DESKTOP_LOCAL=1 / SECRET_KEY / BYOK_ENCRYPT_KEY / UPLOAD_DIR / WHISPER_MODEL_DIR / FFMPEG_BIN / DATA_SYNC + merge bundled.env)。
- `frontend.js`:Next standalone 用 Electron 自带 Node 跑 server.js:3100 + **内置反代**(API_PROXY_URL 打包烤进 server.js)转 8077，同源零 CORS。
- 其余:`preload`(contextBridge 白名单) · `publish`(RPA 发布) · `video`(ffmpeg) · `tts` · `model-downloader`(whisper 按需下载 Range 续传 sha256) · `render-worker`(离屏 Chromium 逐帧渲染) · `updater`。
- IPC 通道(全要重做):publish/video/files/desktop(captureScreen/newWindow/openWorkbench/openStudio)/quickinput/notification/tts/app/model。
- **首启**:单实例锁 + 建 `~/Documents/台球助手` 作品夹 + UPLOAD_DIR 指 userData + 三密文件(secret.key/byok.key/billiards.db 持久化 userData) + **免登录 seed 在后端 `init_local._seed_local_owner`（壳只注 DESKTOP_LOCAL=1，这是壳与后端唯一耦合点）**。

### B.4 打包 / 分发
- **照 cc-haha plumbing**:Bun 编译后端单文件 + electron-builder(dmg/nsis) + electron-updater + CI 矩阵 + 未签名兜底。⚠️ 全 TS 必踩:mac Bun 二进制坏签名要 `codesign --remove-signature`+ad-hoc 重签 · win 用 `bun-windows-x64-baseline` 目标(兼容老 CPU)。
- **内置/下载资产(命根子·体积 owner 已放开无所谓)**:whisper 权重 ~1.42G（**按需下载** QF_MODEL_BASE_URL CN 网关 /models/，续传+sha256）· bge ~90M（打包，换 **bge-m3 ONNX**）· 中文字体（打包，视频字幕 CJK）· **prompts.enc 加密知识库（只发密文、Fernet、永不发明文）** · ffmpeg/ffprobe（打包）· 离屏渲染复用 Electron 自带 Chromium · MCP SDK · tzdata/rapidocr/qrcode（易漏）。
- **自动更新**:私服 zzyppz.cn/desktop/（US 机 47.77.237.250 nginx alias）· 发版=bump 版本+`git tag v*`→CI 出包+scp · ⚠️ **三台服务器别混**（更新 US / whisper 下载 CN / 数据回传 CN）。
- **签名**:Win 未签名（计划买 signing）· **Mac 卡 $99/年 Apple 账号（owner 行动项；不办则 Mac 自动更新静默跳过）**。

### B.5 服务端（不进包，但"直接可用"依赖它在线 · 重写别改漂契约）
网关 `gateway/`（qfgw CN 39.106.214.21:8799 藏 key+配额）· 数据接收 `dataeye/`（CN data.zzyppz.cn）· whisper 下载主机（CN）· 更新私服（US）。**重写时别把客户端对它们的对接契约（app 令牌 / /models 下载 / /ingest 回传）改漂了。**
