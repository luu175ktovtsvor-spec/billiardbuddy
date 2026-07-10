# 对齐执行波次台账(2026-07-10 · 17 模块复核后)

## 复核结论 vs 91 条总清单
- 旧 Wave 0 四条全部已闭环:复合命令 deny/ask(dec3057)、use_skill 审批闸(SAFE_SKILL_PROPERTIES 对齐)、MCP elicitation(协议语义 aligned)、入参 strictObject(内建 strict/MCP passthrough 对齐)。
- 旧 Wave 2 存储地基已落(工作树):append-only+uuid/parentUuid、rewind 服务、plan 落盘、记忆(部分)。**但 rewind 有两处 P0 断链(见 A1)。**
- 账面纠正(收尾回写矩阵/清单):同族工具绕过已修(9558aa6·矩阵还写 rework 中);tree-sitter 非缺口(cc 发行版也没开);压缩计数器 cc 也是每回合重置(待办前提错误,关闭);uniqueName 截断前提错误(cc 不截断,我们更严);插件 commands/hooks 已并入(记忆过期);extractMemories"已治"是假的(只是提示词);子命令 50 条硬顶声称已落实测未找到;GPT生图异步化文档是钩子误判应 KEEP。
- "记忆打散 5 处"架构遗留题关闭:cc 自己也拆 5-6 文件,不搬。
- UDS 去留裁决:保留(cc 有 UDS_INBOX 设计残片、独立 sidecar 架构下 socket 是对的原语),修 error 监听 bug;与 bridgePeerRegistry 的重复面收尾登记。

## Wave A(P0/正确性,并行 7 路后端 + 2 路文档)
- A1 rewind 断链:loop 赋值 ctx.messageId + 接线 recordCompaction + getSessionTurnCheckpointDiff 服务层 + 真集成测试。[audit/12]
- A2 UDS error 监听(顺修 flaky)+ teammate 入队断链。[audit/09]
- A3 hooks:PreToolUse allow 决策消费 + 配置加载三级白标路径(废死路径 server/hooks.json)。[audit/07]
- A4 沙箱:fullDiskAccess 联动 buildSandbox + additionalWorkingDirectories→allowWrite + denyWrite 填充。[audit/04]
- A5 AnthropicMessagesModel:流空闲超时 + SSE error 帧识别 + 测试。[audit/11]
- A6 小修对:save_memory 加进只读子代理黑名单 + autoEditSafety 白标倒挂(.billiardbuddy 保护/.claude 字面清除)。[audit/15,14]
- A7 MCP:隐形 Unicode 净化 + image/audio 接 imageResultSink + blob 落盘 + 默认超时对齐 cc。[audit/10]
- A8 sidecar 顶层崩溃兜底 + 最小崩溃日志落盘。[audit/16]
- D1 文档删除+指针修复+索引同步;D2 根 README 重写+口径文档精简+ts 入口死指针。
- 暂缓一档:网络围栏策略(askCallback 恒 true=零拦截,但改 false=默认断网破产品,需 owner 定白名单策略——登记 owner 决策)。

## Wave B(P1 行为对齐,A 波过审后)
- 文件工具:cat-n 行号约定+Edit 剥前缀、CRLF 往返、空 old_string 三语义、PDF pages、notebook 读。[03]
- Bash:timeout 120s、截断写盘可回读、PowerShell 平台门、cwd 持久化、UNC 4 层、子命令 50 硬顶。[02]
- loop:hooks 与并发正交(去串行退化)、中断路径 max_turns 事件、重试参数对齐(10 次/32s/jitter/env)+默认启用。[05,11]
- plan 模式:resolver 硬拒→cc 软审批卡、ExitPlanMode 守卫+prePlanMode 还原。[01,09]
- 压缩:/compact 接真管线、触发单口径、九段第 6 段逐条、续跑提示词三段式、PTL 按差值。[06]
- hooks:并行执行、stop_hook_active、9 缺失事件(PermissionRequest 优先)、continue:false。[07]
- skills:model/effort 覆写消费、context:fork 同步、!内嵌 bash+${SKILL_DIR} 白标变量、命名空间。[08]
- 记忆:extractMemories 轻量真兜底、子代理记忆隔离(F2)+提示词补齐(F3)。[15]
- MCP:断线重连/会话过期、env 展开、roots+instructions 注入、fetch 超时/Accept、插件信任闸、-32042 重试。[10]
- systemPrompt:# Doing tasks/# System/# Tone/# Output efficiency/currentDate/URL 禁猜/MCP instructions/子目录条件规则接线。[14]
- 可观测:debug 日志落盘、错误分类文案、会话 token 汇总。[16]
- server:断连宽限语义(不中止活跃回合)、会话 DELETE/PATCH、逐条中途落盘。[13,12]
- 模型层:context 窗口表补国产变体、DEFAULT_MAX_TOKENS 8000、fallback onDelta 抑制。[11]

## Wave C(前端 P0/P1,B 后)
- ask_question 渲染(plan 批准+AskUserQuestion)、PermissionModeSelector、上下文用量条、运行中切会话、fork 入口、快捷键。[17]

## owner 决策项 —— 2026-07-10 已拍板 6 条(晚间)
1. 网络围栏:**继续零拦截**(登记 owner 批准分叉,写进对齐笔记,不再当缺口)。
2. **thinking 默认开**(Wave B 实施:默认发 thinking、与 effort 解耦,对齐 cc)。
3. **模型重试默认开**(Wave B 实施:默认启用+参数对齐 cc 10次/32s/jitter/env 覆盖)。
4. **plan 模式 = b 软卡**(Wave B 实施:撤 resolver planSkip 硬拒,写工具走标准审批卡;行为对齐测试)。
5. 签名:**不用管**(分发链路划掉签名项,裸发)。
6. 台球知识:底本= ~/Desktop/球房-PPT底本-本地存档(7 文件,硬规则对照表 A-10 是重策展基准);⚠️两处账:README 列的"第三方名脱敏对照-记录.md"实际缺失、README 引用的正本路径多数已随旧栈删除。task#12 阶段 3 执行。

## owner 2026-07-10 晚·前端+安全方向(确认 360 分析,指派我执行)
- 前端对齐 cc 交互 + WorkBuddy 长相,具体由我拍。三个重点:①右侧预览面板 ②中央对话区布局/展示 ③安全。
- **安全·反揭示重点**:用户会问"你是什么模型/谁造的",要三层防到位。
- 归入:前端三重点 = 阶段 2 前端 parity(audit/17 已产出右侧预览能力规格清单当施工规格);安全反揭示 = **Wave B systemPrompt 头号项**(见下)。

## Wave B 安全·反揭示(三层防御,owner 点名·头号)
现状(audit/14 + 总览§5)与缺口:
- L1 人格/系统提示:⚠️**缺** # System/身份章——模型压根没被告知"你是球房管家、拒绝透露底层模型";还缺 model 身份行。**这是根子**:底座模型常幻觉自称"我是 ChatGPT/OpenAI 造的",不靠强身份注入压不住。→ Wave B 补身份章+"不透露底层模型/供应商,自称球房管家"指令。
- L2 输出流硬清:✅ outputScrub.ts 已在(final/content_delta/thinking 出口过脱敏器,禁词流式切两半有 HOLD 缓冲)。需验:身份类措辞("由X训练""基于X")是否都被 PROSE_NEUTRAL 兜住;scrub 不动用户内容/工具结果(正当写 openai 集成代码不能被改)。
- L3 模型名白标:✅ publicModelNames(前端只见能力档代称)。
- 连带:⚠️**安全红线未无条件注入**(只在挂台球包时 SAFETY_FLOORS)——铁律落差,Wave B 一并把通用红线块设为基座无条件注入。

## R3 裁决(2026-07-10)
- hooks 两 P0 ✅合入;autoEditSafety 白标翻转 ✅合入。
- ⚠️CONFIRMED 记 Wave B:只读子代理(Explore/Plan)守卫测试用空 registry 掩盖了生产泄漏——扩展工具集里 cancel_background_task/TeamCreate 零门禁,只读代理实际可调。修法=cc ALL_AGENT_DISALLOWED_TOOLS + 只读代理正向过滤(isReadOnly 构造),守卫测试改生产形状。**现不动**:taskTools/teamTools 被 teammate 返工代理独占。

## 仍待 owner(不阻塞)
- sameCallGuard/stuckDetector 保留为弱模型适配(建议保留+登记);VerifyPlanExecution 常开(建议保留或门控);agents CRUD REST 是否做;自动更新发布渠道(task#13);当前目标口径文档是否并入总览。

## 文档处置(体检 4/4 结论)
- 删(硬证据 7):harness缺口审计-2026-06-26、W1/W2/W4c/W6 findings、模型名白标、video-use转写引擎;摘孤儿项后删:W3/W4a findings(收尾做)。
- UNCERTAIN 留 owner:竞品拆解05(精简不删)、当前目标与文档口径、记忆机制对齐cc(阶段2并入本台账后可删)。
- 精简:迁移矩阵 3583→600 上下(收尾做)、SDK 参考 793→450、AI-harness全景 §4 删老 Python 表、Windows清单压缩、记忆两份合并。
- 指针修复:设计规范+竞品拆解02(globals.css 新路径)、05(Python 死路径)、服务器拓扑(dataeye=TS)、签名分发(desktop/→ts/)、助教规则库(YAML→knowledge.ts)、ts/CLAUDE.md+AGENTS.md(主开发文档死链)、docs/README(摘 harness缺口审计行)、竞品拆解README(补05行)。
- KEEP 翻案:GPT生图异步化(功能已落地,开关默认关是有意设计)。
