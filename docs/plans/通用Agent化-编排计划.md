# 通用 AI Agent 化 · 编排计划（2026-06-21）

> 本轮核心方向（用户拍板）：**盒子本体 = 通用 AI Agent**（装老板本机的通用电脑执行器：跑命令/读写改文件/上网/子代理/生图/看图）。
> **台球 = 可 @ 挂载的知识库**（@ 进来，接入的大模型按知识做针对性回答）——**台球业务后面再接，本轮先做通用 Agent**。
> **生图 = 盒子里接入的通用生图模型能力**，海报只是它的一种用法。
> 规则：不扒别人后端替换（现有 Python+React 栈完全够），只补缺口；不删台球代码（留作 @ 层）；安全红线永远常驻、独立于知识库。

## 一、通用 Agent 全功能清单 × 我们的覆盖度（摸底结论）

| # | 通用 Agent 该有的能力 | 我们现状 | 缺口 |
|---|---|---|---|
| 1 | ReAct 循环（想→调工具→回灌→再想） | ✅ loop.py（含 microcompact/anti-spin/Stop hook/max_turns） | — |
| 2 | 读/写/改文件 | ✅ read_file/write_file/edit_file/edit_excel | — |
| 3 | 列目录/找文件/搜内容（ls/glob/grep） | ✅ list_files/find_files/search_in_files | — |
| 4 | 跑命令（bash） | ✅ run_command（沙箱+黑名单+超时） | 展示弱 |
| 5 | 上网（抓网页/搜索） | ✅ web_fetch/web_search | — |
| 6 | 多步任务清单 | ✅ todo_write | — |
| 7 | 子代理 | ✅ run_subagent | — |
| 8 | 多模态看图 | ✅ multimodal.py（模型无关，按 image_url 塞 messages） | — |
| 9 | 生图 | ⚠️ 有，但包成 `make_poster`（台球海报框死） | **升级为通用 generate_image** |
| 10 | 执行过程展示（命令/工具实时、完整） | ⚠️ 后端把完整命令+输出+退出码已送到前端 | **前端只渲染"跑命令"标签、没展开 → 要做终端式块** |
| 11 | 权限/审批分级（标准/自动编辑/完全自主 + 强制确认） | ✅ context.permission_mode + registry 能力位 | 文案要去"风险/钱"味 |
| 12 | 上下文压缩（microcompact/autocompact/token 预算） | ✅ | — |
| 13 | 持久记忆 | ✅ 店脑（memory_service） | 后续可泛化成通用记忆 |
| 14 | @ 引用（文件/知识库/url） | ❌ | **要建 @ 入口** |
| 15 | 知识/技能按需挂载 | ⚠️ RAG（bge-zh look_up_knowledge）已有 | @ 入口缺；@ 后注入纲领+scoped 检索 |
| 16 | Hook（pre/post/stop） | ✅ hooks.py | — |
| 17 | 通用身份（非写死台球） | ❌ agent.py:46 第一句写死台球 | **改成通用默认** |
| 18 | MCP/扩展 | ❌ | 暂不做（YAGNI，无业务驱动） |

**一句话**：~80% 已具备，缺口集中在 **9/10/14/15/17**（生图通用化、执行展示、@ 引用、通用身份）。不需要换语言/扒源码。

## 二、编排（按此顺序执行）

### A. 通用化核心 —— 让盒子真正是通用 Agent
- **A1 系统提示拆分**：`_AGENT_BASE_PROMPT` 拆成
  - `_GENERIC_BASE_PROMPT`（通用电脑助手身份 + 工作风格，**默认注入**）
  - `_SAFETY_REDLINE`（性交易/赌博/未成年/法律文书/绝对化广告——**永远注入，独立于知识库**）
  - `_BILLIARDS_PERSONA`（台球术语翻译/店规矩校准/擦边照帮/把方向带正——**抽出保留，待 @ 时注入**，本轮不挂）
  - `compose_agent_system_prompt(..., billiards_mode=False)`：默认通用；门店画像/店脑也仅 billiards_mode 注入。
- **A2 工具集分层**：新增 `general_tool_registry()`（默认表减去台球专用工具）。agent_chat/agent_execute 默认用通用集；台球生成工具留作 @ 层。
- **A3 生图通用化**：新增通用 `generate_image(prompt, ratio)` 工具（复用 poster_service 的 BYOK 路由），进通用集；make_poster 留作台球层。
- **A4 多模态看图**：确认 multimodal.build_user_content 已接进对话入口（看图属模型自身能力，壳子只塞 image_url）。

### B. 执行展示对齐顶级 Agent（你最看重的工程质感）
- **B1 前端终端式命令块**：渲染 run_command 完整命令 + stdout/stderr + 退出码，等宽字体、可折叠（chat-thread.tsx 新增组件，用已存在的 `ToolStep.result`）。
- **B2 所有工具结果可见**：file/web/search 等非成品工具也展示结果摘要/可展开（不再只显示标签）。
- **B3 后端结构化字段**：tool_result 事件 + execute 响应带 command/stdout/stderr/exit_code（local_tools + loop + agent.py，同步两路径）。
- **B4（进阶）实时流式 stdout**：run_command 改 async Popen 逐行推 + loop 支持工具中途 yield → 边跑边滚字。

### C. 止血 + 体验（界面硬伤）
- **C1 设置页/导航 bug**：提交单窗口改造（已做好未提交）+ 修 not-found.tsx 死链 + 清 api.ts 死接口 + dev/真机验证 + 重打包。
- **C2 删权限风险文案**：desktop-composer.tsx:165-167「群发、平台发布…需你确认」。
- **C3 分隔线可拖拽**：左栏右边界(macos-shell.tsx:45) + 右栏左边界(preview-panel.tsx:37) 加 col-resize 拖拽。
- **C4 UI 文案官方化**：去「老板/管家/派活/跑命令」口语 → 大厂正式腔，术语统一。

### D. 台球知识库 @ 挂载（后面再加）
- **D1** 输入框 @ 选知识源（台球行业知识库 / 文件 / 报表 / 历史）。
- **D2** @ 后注入：一页精华纲领 + 打开 scoped look_up_knowledge（Anthropic 混合式，不灌整库）。
- **D3** 知识库按 PPT 原文核对补漏 + 去任何残留来源名。

## 三、铁律（改造全程守）
纯 BYOK 不内置 key；安全红线永远常驻（不随 @ 开关）；不自动群发/对外走审批闸；SQLite 兼容；不删台球代码（留作 @ 层）；改完跑全量回归（pytest + tsc）。

## 四、进度（2026-06-21）
- ✅ **A 通用化核心**：系统提示拆三段（通用默认/红线永驻/台球人设待@）+ 工具分层（general/billiards registry）+ 通用 `generate_image`。后端 471 passed（含新 `test_agent_general_mode.py`）。
- ✅ **B 执行展示**：前端终端式命令块（完整命令+stdout/stderr+退出码）+ 非成品工具结果可折叠展开（`TerminalBlock`/`ResultDisclosure`）。
- ✅ **C1(码) / C2 / C3 / C4(轻)**：not-found 死链修复；删权限「群发/高风险需确认」文案 + 去模式描述钱味；左栏/右栏分隔线可左右拖拽（`use-resize.ts`，带最小/最大宽 + localStorage 记忆）；去「派活/干了这些活/在想」口语。
- 验证：tsc + `next build` 全绿（路由只剩 chat/login/register/not-found，证实旧设置页是旧包残留）。
- ✅ **D 台球 @ 挂载**：前端输入区「@ 知识库」选择器（chip + localStorage 记忆）→ `knowledge_packs` → 后端 `billiards_mode` → `billiards_registry` + 台球人设。chat + execute 两路径都带。
- ✅ **真机端到端验证**（mock 大模型 `/tmp/mock_llm.py` + 真前后端 + Playwright）：设置抽屉(不跳旧页)/返回工作台(不死循环)/权限文案删除/分隔线拖拽 244→364/**终端块(ls /tmp + exit 0 + 完整输出·深色终端风)**/**不@=通用助手模式跑命令, @台球=台球专家模式**——全过。截图 `verify-0{1,2,3}.png`(仓库根，可删)。
- ✅ 后端 473 passed + 新集成测试 `test_agent_loop_run_command.py`(真跑循环→run_command→完整输出进 tool_result) + tsc + next build 全绿。
- 🔜 **仅剩**：①重打包 dmg(用户跑的是旧包,需重打才在真机生效)；②用户用真 BYOK key 验真实应答质量(mock 只验机制)；③知识内容按 PPT 核对补漏(D3,选"核对补漏"非推倒)；④C4 剩余文案(chat-shell 问候/welcome/settings 抽屉)。
- ⚠️「上下拖」当前布局无对应分隔线，需用户上新版后指明具体区域再做。

## 五、研学 Claude Code(cc-haha-ref) + 桌面 App 测试（2026-06-21 补）
- **研学结论**：cc-haha-ref 是可读 TS 源码。逐项比对后端「衔接」——我们核心循环/工具能力位/省token/防打转/参数校验**已与 CC 高度对齐**（连常量都同）。唯一大缺口=「命令边跑边显示」。
- ✅ **已模仿实现「命令边跑边显示」**：`local_tools.run_command` 由阻塞 `subprocess.run` 改 `asyncio.create_subprocess_exec` 逐行读 + `ctx.progress_emit` 实时推；`loop.run_agent_loop_stream` 用 asyncio.Queue 在工具执行期间 drain 出 `tool_progress` 事件 yield 给前端（借鉴 CC 的 onProgress/pendingProgress 分流）；前端 `chat-thread` 新增 `LiveTerminalBlock` 边跑边滚。后端 474 passed（含新 `test_loop_streams_command_progress`）。
- ✅ **桌面 App E2E 测试**：`desktop/test/desktop-agent.e2e.js`（Playwright `_electron` 驱动**真 Electron 壳**）——真桌面壳/登录/会话页/完全自主/命令终端块(exit 0+ls /tmp)/通用助手模式 **全部通过**。这是「只有桌面 App 测过才放心」那道关。跑法：起 后端8077+前端3000+mock8090 后 `node desktop/test/desktop-agent.e2e.js`。
- 🔎 **研学时发现的待修**：`memory_service.remember`（后台店脑学习）用的是平台 key（`_get_client`），纯 BYOK 桌面下无平台 key → 后台报错（故障安全、不影响对话）。应改用门店 BYOK provider。属真 bug、低优先，单列待修。
- CC 其余可借鉴（未做，列备选）：只读工具并发、工具结果聚合预算、AbortController 取消、State 对象消除同步/流式双路径重复。无业务驱动先不做。
