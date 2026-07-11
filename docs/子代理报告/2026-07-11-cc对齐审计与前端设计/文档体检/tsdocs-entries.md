# 文档体检报告 · ts/docs 7份 findings + 4份入口文件

> 生成时间:2026-07-10 · 只读审计,未删改任何文件

## 任务A:ts/docs/ 7 份 findings 判定

| 文件 | 判定 | 依据 |
|---|---|---|
| W1-native-plugin-findings.md | **DELETE** | 纯 2026-07-06 spike 报告(验证 sharp/transformers.js/smart-whisper/bun:sqlite 能否在 Bun 下跑)。结论已消化:①`smart-whisper` 现是 `ts/package.json` 真依赖(`ts/src/media/transcribe.ts`、`ts/src/server/services/voiceTranscription.ts` 已用),口播走"whisper子进程"决策已落地。②`sharp`/`@huggingface/transformers` 未再引回(全仓 `grep` 0 命中)——因为记忆系统后来改走 cc 风格 AutoMem(纯文件+grep,见 git `a00d84e`），本就不需要本地向量嵌入,W1 关于 embedding 的分析已被架构变更淘汰而非"没做"。③"bun:sqlite 主力/W5 建表"结论已被后续架构决定明确作废(`ts/CLAUDE.md` 铁律5 写明"原 drizzle+bun:sqlite 已作废,内核不用 SQLite,纯 JSONL/JSON")。全文没有仍待人接手的活项,只是历史 spike 记录。 |
| W2-harness-core-findings.md | **DELETE** | 2026-07-06 W2 建成记录(消息类型/工具框架/循环骨架)。其核心技术决策"消息用 OpenAI 兼容格式(非 Anthropic content-block)"已被同一批次里更晚的 `W6-proxy-findings.md`(标题就叫"W2 返工 + W6 proxy 层")显式推翻重做:现在 `ts/src/types/message.ts` 是 `content: ContentBlock[]`,`role:'tool'` 全仓 0 命中。文件末尾"给后面窗口的硬约束"等指引也已被 `W3/W4a/W4c` 及后续 6 波对齐清单接续完成。无独立未覆盖遗留项。 |
| W3-sandbox-findings.md | **UNCERTAIN** | 双层沙箱(应用层 TOCTOU + Mac/Linux OS 沙箱)主体已建成且被后续工作确认使用(`ts/src/sandbox/{osSandbox,sandbox,windowsLauncher}.ts`)。但文件"§W3 明确没做"列的几项里,有 **3 项经代码核实仍未做、且不在 `内核A线对齐-差异总清单-波次-2026-07-10.md` 或 `后端对齐-第三批-枝叶+架构剩余-P1-P7.md` 任一份里出现**(两份文件全文 grep "sandbox/沙箱/Job Object/网络围栏/危险命令分类器" 零命中):<br>① **网络围栏**——`osSandbox.ts` 网络策略仍是 `allowedDomains: []` + `askCallback` 恒放行(`initialize` 时无条件 allow),等于网络完全不设防,全仓/全文档搜不到任何后续跟踪计划(唯一命中是一份无关的 WorkBuddy 逆向笔记)。<br>② **shouldUseSandbox 逐命令决策**——`sandbox.ts` 现在是"整体 enabled 开关"(`this.enabled ?? false`,由 `QF_OS_SANDBOX` env 或调用方一次性传入),并非"按命令决定要不要沙箱"，代码注释自己也承认"按命令决定沙箱 = W4"但至今没做,且无任何文档在跟踪。<br>③ **Windows 原生 Job Object(W3b)**——`windowsLauncher.ts` 仍是占位桩(`available()`/`wrap()` 恒 false/null)。这项**有**被跟踪,只是跟踪在 `docs/plans/Windows平台对等-审计与补齐清单.md`(不在题目指定的两份文件里),视口径严格与否可算"仍未被指定两份文档覆盖"。<br>另一项"OS 沙箱默认开"已经 DONE(`server/index.ts:975` 现在默认 `sandboxEnabled=true`,);"完整危险命令分类器(可逆性/爆炸半径)"基本 DONE(`dangerousCommand.ts` 已有 `classifyCommandRisk` 四级分类 read/file/outreach/destructive,被 `runCommandTool.ts`/`backgroundCommandTool.ts` 消费接入审批闸)。 |
| W4a-approval-permissions-findings.md | **UNCERTAIN(轻)** | 审批闸/权限三档/HMAC/anti-reveal 主体已完全建成并被后续工作依赖。"§W4a 明确没做"列的项目里:HTTP `/agent/execute`·`/agent/reject` 端点已建成(`server/index.ts:4065,4071`);plan enter/exit 工具已建成(`ts/src/harness/plans.ts`、`agentInteractionTools.ts`)。**唯一仍确认未做且未被两份新文档覆盖的活项**:"oob 越界写 → 审批卡"——现在仍是硬抛错(`workspace.ts:39` `throw new WorkspaceBoundaryError`),不是转成 approval_request;`内核A线对齐` 和 `第三批` 两份文档全文搜"oob/越界写/full_disk_access"均 0 命中。这是个真实的小遗留,但严重度低(现状是"更保守地拒绝"而非"更危险地放行"),不构成阻断级缺口。 |
| W4c-context-resilience-findings.md | **DELETE** | "§W4c 明确没做"列的 5 项经代码核实**全部已经做完**:①"大工具结果落盘/artifact store"→`toolResultStoreDir` 机制已接入 `loop.ts`(多处消费,`server/index.ts` 已传 `join(stateRoot,'tool-results',conversationId)`)。②"9 节 cc-haha 结构化摘要 prompt"→`compaction.ts` 的 `COMPACTION_SYSTEM_PROMPT` 现在就是 1-9 编号的结构化摘要模板(目标/技术概念/文件状态/错误修复/已完成/用户原话/待办/当前现场/下一步),不再是"短摘要打通机制"。③"真实 token 计量"→`compaction.ts` 已用"上一轮响应回报的真实 input tokens"判压缩,`AnthropicMessagesModel.ts` 已透传 `cache_read_input_tokens`/`cache_creation_input_tokens`。④"HTTP 会话恢复与 transcript 装配"→`server/index.ts` 已把 `transcript`/`conversationId` 接入 `runAgentLoop`,`sessions.loadTranscript`/`loadTranscriptPage` 支持按 id 续读。⑤"W4d/W4e(skills/hooks/subagents)"→git log 大量后续提交证实已落地(`f46fa5c` 插件hooks/commands接进会话、`d5a2660` use_skill权限修复、`ab6757c` MCP elicitation、`d02637f` 定时调度、`316444c` Computer Use、`a00d84e` AutoMem记忆等)。全部活项已被后续工作消化,无遗留。 |
| W6-proxy-findings.md | **DELETE** | W2 返工(Anthropic content-block)+ proxy 双向翻译层的建成记录,"移交项"经核实均已接手完成:①"压缩失败连续3次熔断"→`compaction.ts:17` `MAX_COMPACTION_FAILURES=3` 已实现。②"W10 模型出口+网关+failover"→`ts/src/model/FallbackModel.ts` 已建成(且在 `内核A线对齐` 清单里作为"需继续行为对齐"的条目被跟踪,即已建成、仍在打磨,不是"没做")。③"W5 审批恢复流"已随 W4a 的 execute/reject 端点建成。④"W16 前端 token 级流式"是前端窗口的活,不属本审计范围但也有独立任务号跟踪(task#17起)。文件自身也标注"方向修正(晚于本窗施工)"说明其内容已知会被后续覆盖,是纯历史记录。 |
| alignment-notes.md | **KEEP** | 题目已定性:2026-07-10 当天新写,记录的是"故意分叉"(rewind/checkpoint 存储机制、checkpoint 数据源推导方式、中断等待有界超时、路由双前缀)而非过程记录,且带明确的风险/测试覆盖章节(§已知风险与测试覆盖),是活文档性质的决策备忘,应保留。 |

**DELETE 名单**:W1-native-plugin-findings.md、W2-harness-core-findings.md、W4c-context-resilience-findings.md、W6-proxy-findings.md(4 份)
**UNCERTAIN 名单**:W3-sandbox-findings.md(3 个真实孤儿缺口:网络围栏、shouldUseSandbox 逐命令决策、Windows Job Object 真实现)、W4a-approval-permissions-findings.md(1 个真实孤儿缺口:oob 越界写→审批卡,低严重度)
**KEEP**:alignment-notes.md

> 若要处理 UNCERTAIN 项,建议做法:把 W3/W4a 两份文件里"仍未做"的条目摘出来,并入 `内核A线对齐-差异总清单-波次-2026-07-10.md`(它就是当前活的缺口台账,已有 P1/P2/P3 分级机制),然后把这两份 findings 整份删除——这样"没人接手"的风险归零,又不需要保留整份历史 spike。

---

## 任务B:4 份入口文件一致性 + 肥瘦审查

### 1. 根 `CLAUDE.md`

- **路径有效性**:文中引用的路径(`docs/当前架构与状态-总览.md`、`docs/服务器与部署-当前拓扑.md`、`ts/CLAUDE.md`、`ts/AGENTS.md`、`docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md`、`docs/README.md`、`docs/plans/强-coding-agent-桌面外壳-阶段目标.md`、`docs/当前目标与文档口径-2026-07-07.md`、`docs/references/*`、`docs/design/*`、`docs/plans/GPT生图异步化-根治方案-2026-07-09.md`)**全部真实存在**,无失效指针。
- **内容矛盾/滞后**(真实发现):"现状与待办(最新:2026-07-10)"与"在建/待办"两节列的是 2026-07-09~07-10 的旧一批工作(记忆注入/PPT策展/斜杠技能/桌面基建/前端批1-2/权限过滤/技能基建/GPT生图/文档重写),**完全没提到 `git log` 显示的、同一天之内已经成为主线的"内核 A 线对齐 6 波次"工作**(`docs/plans/内核A线对齐-差异总清单-波次-2026-07-10.md` 91 条差异 + Wave0-2 已有 ~15 个commit 落地,如 `fce9910`/`ad90b69`/`d5a2660`/`ab6757c` 等)。全文 grep "内核A线/波次/架构对齐第一批" 0 命中。这是当前最大的一处"文档落后于代码"的口径缺口。
- **冗余**:核心架构原则 §1(通用Agent为默认)与"项目简介"段落重复表述"默认通用/挂载台球包"同一件事;"关键约束"§4(审批闸只卡三类)与核心架构原则 §6 内容重叠(两处都写了"对外/不可逆/花钱"三类+生图不弹审批+不设消费上限)。建议:核心架构原则改成一句话+指向"关键约束"细则,省掉约 8-10 行重复。

### 2. 根 `README.md`

- **路径有效性**:`docs/桌面版AI-Agent-产品形态/README.md` **已不存在**(该文件已被 `docs/当前架构与状态-总览.md` 取代并删除,commit `79f54af`);`docs/归档/` **已不存在**(同一 commit 里连同 19 份旧文档一起删除、且 owner 2026-07-09 已定"过时文档直接删不归档",目录本身也没了)。README 第 48/49 行两处引用均失效。
- **内容矛盾(最严重的一份)**:
  1. 顶部虽有一行"2026-07-09:老 Python 后端(server/)已整体退役删除"的警示,但下面"这是什么"一节仍原样写着"**全本地:Electron 壳 + 本地 FastAPI + 本地 SQLite + 加密知识库**"——这是被警示行自己否定的老栈描述,自相矛盾。
  2. "代码在哪"一节把 `web/`、`desktop/` 标成"(退役中)"——但实际上这两个目录已经**彻底删除**(`git log` commit `cd7945c`:"删老 Python 线残留 server/web/desktop —— 唯一栈=ts/"),`ls` 验证根目录下已无 `server/`、`web/`、`desktop/`。"退役中"应改成"已删除(历史见 `cd7945c`)"。
  3. "当前状态(2026-07-02)"整节描述的是老 Python 栈的里程碑(视频工作区/生图编辑台GPT+火山双模型/后端1377测试/Windows+macOS双平台打包/口播whisper抽离到500M安装包)——这套指标是已删除的 Python 系统的,和当前 `ts/` 栈完全对不上,极具误导性,应整节删除或重写成 `ts/` 的当前实测状态。
  4. "怎么跑"一节已经是对的(`cd ts && bun install/test/typecheck/...`),这部分不需要动。
- **建议**:README 是四份里最需要重写的一份。删掉/重写"当前状态(2026-07-02)"整节(约 3 行但信息密度高、误导性强);"代码在哪"节 `web/`/`desktop/` 两行改措辞(2 行);顶部警示行可以直接并入"这是什么"节而不是单独浮在banner里自相矛盾。

### 3. `ts/CLAUDE.md`

- **路径有效性**:第 3 行"权威入口"列了三份文档,其中 **`docs/plans/TS-harness-重构-主开发文档-2026-07-05.md` 已被删除**(commit `5f42d96`:"docs: rewrite around 全方位对标 cc-haha 方向...delete superseded"),是一个**真实失效指针**,且此文件仍在被当作"权威入口"之一引用,误导新会话去找一份不存在的主 spec。其余引用(`docs/当前目标与文档口径-2026-07-07.md`、`docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md`)都存在。
- **内容矛盾**:未发现——铁律5"存储=文件式,无SQL数据库"、铁律8"原生插件当sidecar文件"等描述与代码现状(`grep` 验证无 SQL/drizzle 依赖,`ts/package.json` 有 `smart-whisper`)一致,是准确的。
- **冗余**:铁律1(可直接抄cc-haha)与铁律2(每个窗先确认行为再写计划,同样在讲"可参考cc-haha")内容有重叠,可以合并成一条。
- **建议**:删掉/替换第 3 行里那个死链接(改成指向现存的 `docs/plans/内核A线对齐-差异总清单-波次-2026-07-10.md`,它现在才是真正的"当前活跃工作清单")。

### 4. `ts/AGENTS.md`

- **路径有效性**:定位为 `ts/CLAUDE.md` 的镜像/精简版,第 3 行同样引用了**已删除的** `docs/plans/TS-harness-重构-主开发文档-2026-07-05.md`(与 ts/CLAUDE.md 犯的是**同一个**死链接,说明这处失效是从 CLAUDE.md 复制过来的、没有同步修过)。其余引用有效。
- **内容矛盾**:未发现,内容与 ts/CLAUDE.md 一致(纯文件式存储/Bun版本/SSE写法/产品红线等描述都对得上代码现状)。
- **冗余(设计如此,非缺陷)**:本文件本身就是"给非 Claude Code 工具读的镜像",与 ts/CLAUDE.md 内容大量重复是有意为之(文件开头已声明"权威版在 ts/CLAUDE.md"),不建议改成引用式避免重复(会破坏 AGENTS.md 独立可读的目的)。
- **建议**:只需和 ts/CLAUDE.md 一起同步修那处死链接,不需要其它改动。

### 入口文件问题 Top 5(汇总)

1. **根 README.md 内容整体过时**——仍描述已删除的 FastAPI+SQLite+server/web/desktop 老栈("当前状态2026-07-02"整节、"这是什么"一节的存储描述),是四份里最需要重写的。
2. **`ts/CLAUDE.md` + `ts/AGENTS.md` 同时指向一份已删除的文档**(`docs/plans/TS-harness-重构-主开发文档-2026-07-05.md`,commit `5f42d96` 已删),两处"权威入口"引用同时失效。
3. **根 README.md 两处死链接**:`docs/桌面版AI-Agent-产品形态/README.md`、`docs/归档/` 均已不存在(commit `79f54af`)。
4. **根 CLAUDE.md 的"现状与待办"落后于当前 git 主线**——完全没提"内核A线对齐 6 波次"这个当前最大的在建工作流(`docs/plans/内核A线对齐-差异总清单-波次-2026-07-10.md`,91条差异,已有多个commit在推进)。
5. **根 README.md 自相矛盾**:顶部警示"老Python已删除",但正文"代码在哪"仍把已彻底删除的 `web/`/`desktop/` 标注成"退役中"(应为"已删除")。
