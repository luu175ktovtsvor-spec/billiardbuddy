# Harness 缺口审计 · 对照 Claude Code(2026-06-26)

> 📌 状态:✅现行 · 最后核对 2026-07-02

> **目的**:系统排查我们的 Agent harness 哪些机制**没对齐 Claude Code**,防"一部分参照了、一部分没"。
> **方法**:5 个子代理并行,逐簇对照**本地 cc-haha 参考实现**(社区复刻)读双边真码给 file:line 证据 → 再用 **Anthropic 官方文档**逐个校准(cc-haha≠官方真相,防它自己有缺漏/或有它自创官方没有的)。
> **背景**:旧审计([[harness-borrow-from-learn-claude-code]] 记忆)结论"只补 4 处缺口"**被证不全**——漏了跨轮完整轨迹记忆(正在做)+ 本审计这批。

## ⚠️ 关键校准:cc-haha 不是真相,官方校准改了结论

- **技能执行**:cc-haha = fork 子代理执行只回结论(`SkillTool.executeForkedSkill`);**但官方 Agent Skills 不 fork 子代理**——三段渐进式(发现名+描述 → 激活把 SKILL.md 指令注入对话 → 执行,可选跑脚本),主模型跟着指令做。**我们"把 SKILL.md 贴回去"反而更接近官方**,只是实现坏了(当可截断的只读 tool_result)。→ **照 cc-haha 去 fork 子代理 = 过度改造,不要。** 修法是把指令"正经注入"(非可截断结果)。
- 教训:**以官方文档为基线,cc-haha 只当一份参考**。下面每条都标了 [官方确认]/[cc-haha特有]/[我们更强]。

## ✅ 已对齐 / 我们更强(别动)

| 机制 | 状态 | 证据 |
|---|---|---|
| 钩子 hooks(PreToolUse/PostToolUse/Stop/UserPromptSubmit/SessionStart) | ✅ 对齐 | `hooks.py` 进程内注册表 + `hooks_config.py` 对标 settings.json(matcher+command+退出码2阻断),已接进 `loop.py:793/820/658/1149`、`agent.py:853-859`;`goal_hook.py` 活案例 |
| 思考块 ThinkingBlock 折叠 | ✅ 对齐 | `chat-thread.tsx:161-184`(注释"抄 cc-haha");reasoning 只展示不进历史 `loop.py:1115` |
| 流式事件协议 | ✅ 对齐 | `loop.py:1066-1077` 事件 ≈ CC `chat.ts`;连 onProgress 边跑边出都抄了 |
| 工具结果截断 | ✅ 我们更强 | `_cap_tool_result` 超阈值**落盘**再回灌路径(`loop.py:838`),比 CC 纯截断省 token |
| 危险命令拦截 | ✅ 我们更强 | `local_tools.py:176-207` 硬 deny + 禁 shell 操作符 + 数据外传防护(CC 多是警告不拦) |
| 权限模式四档 | ✅ 对齐 | ask/auto_files/full/plan ≈ CC default/acceptEdits/bypass/plan |
| 失败切档/模型回退 | ✅ 对齐 | `failover.py` 切 BYOK 档,语义正确(未吐 token 才切) |
| 微压缩 microcompact | ✅ 对齐 | `loop.py:851` 清旧只读结果换占位符、留最近 4 条 |
| 子代理隔离上下文 | ✅ 对齐 | `web_tools.py:508` run_subagent 干净 ctx + 只读工具子集 + 只回 final_text |
| 工具结果折叠展示 | ✅ 对齐 | `ResultDisclosure` `chat-thread.tsx:127`,还按工具类型分流 |
| 拖拽/粘贴文件 | ✅ 我们更强 | `desktop-composer.tsx:169` webUtils.getPathForFile(M6 修的,比 cc-haha 旧 file.path 还对) |
| 会话 resume 入口 | ✅ 对齐 | 侧栏会话列表点击续(比 CLI /resume 更适合老板) |
| reasoning/thinking 处理 | ✅ 对齐 | 不进历史,从源头消灭"旧 thinking 占上下文" |

## 🔴 真缺口(分级 · 已官方校准)

> **进度(2026-07-02)**:✅ **A 重试退避 / K 流式看门狗 / C autocompact 真token+阈值** 已修并合并 main(提交 `85d322c`,见 `模块修复-遗留与注意事项.md` 的「harness 韧性」段)。✅ **F 图片回灌(read_file/edit_image)** 已做(2026-06-27·`60107ed`,`local_tools.py:790-802`);✅ **G 技能正经注入** 已做(2026-06-27·`60107ed`,`skills.py:289-323`)。2026-07-02 又落地(见 `0a9b739`):运行中插话纠偏(steering,`loop.py:571` 起)、`run_command` 输出保头30尾70(`local_tools.py:667`)、生图回灌模型自检(`tools.py:452`/`image_tools.py:318`)。⏳ 待做:**E 工具并行**、**B 长任务后台化+完成回灌**(=交接的 Task5);Tier3(H/I/J)靠后,**别建项不变**(context-editing/memory-tool/前缀缓存/CLI专属)。

### Tier 1(高价值,建议优先)
| # | 缺口 | 现状 vs 官方 | 来源 |
|---|---|---|---|
| A | **重试退避** | 我们:仅 429+Retry-After 白试一次,5xx/超时/连接**完全不重试**(`deepseek.py:101-142`)。官方:10 次指数退避(1→2→4…)+ **±30% full jitter** + 覆盖 429/5xx/超时/连接 + 429(你的事)vs 529(他的事)分治 + retry+fallback | [官方确认] |
| B | **长任务真后台化 + 完成主动回灌** | 我们:`generate_video` 在**一次工具调用里同步轮询卡几分钟**(`tools.py:659`),loop 干等;`run_background` 只能跑 shell、无管理、无自动回灌(靠模型自己记得 read_file)。官方:子代理可 Ctrl+B 后台、有 TaskList/Output 轮询 + 完成通知回灌 | [官方确认] |
| C | **autocompact 触发用真实 token + 阈值口径 + 摘要提示词** | 我们:纯估算触发(明明 `loop.py:630` 已拿到 `usage.prompt_tokens` 却没喂触发判断);阈值"窗口70%"在1M窗口下700k就压(太早);摘要是一句话提示词。官方:留固定 13k buffer;9 段结构化摘要(含**逐条列用户消息**+下一步带原文引用) | [官方确认 13k] |
| D | **post-compact 文件重读回灌** | 我们:autocompact 只留摘要+最近N条,**不重读文件**(全 server 无 readFileState 等价物)。CC:`createPostCompactFileAttachments` 压缩后重读最近5个文件作附件塞回 | [cc-haha有/官方compaction同理] |

### Tier 2(中,体验/正确性)
| # | 缺口 | 现状 vs 官方 | 来源 |
|---|---|---|---|
| E | **工具并行(只读批)** | 我们:严格串行 `for tc`(`loop.py:688/1170`),`read_only` 标记只用于截断不用于并发。官方:只读工具可并行(asyncio.gather),省 60~80% 墙钟 | [官方确认] |
| F | **图片回灌 read_file/edit_image** | 我们:只 `computer_view` 截屏回灌(`computer_tools.py:76`);`read_file` 见图返回"二进制不便读取"(`local_tools.py:614`)、`edit_image` 产图不自检。官方 FileReadTool:读任意图/PDF 自动转 image/document block 回灌 | [官方确认] |
| G | **技能执行对齐官方(非 fork)** | 我们:`_skill_tool` 把 SKILL.md 原文 dump 回当只读 tool_result→被硬截断(`skills.py:305`)。官方:把指令**正经注入对话**让模型跟着做(非 fork 子代理)。**修法=正经注入,别照 cc-haha fork** | [官方确认·校准] |

### Tier 3(小/可视性,靠后)
| # | 缺口 | 说明 | 来源 |
|---|---|---|---|
| H | 手动 /compact + 上下文占用指示器 | `_autocompact` 函数 + `tokens_used` 都现成,缺端点 + 前端小角标(`tokens_used` 前端拿到了没展示) | [官方有] |
| I | 用户可配 allow/deny 规则表 | 缺"让某命令永久放行/拉黑";`hooks_config` 已读 settings.json,加 permissions 解析即可 | [官方有] |
| J | /memory + /context 真入口 | 完整轨迹记忆落地后配"管家记住了你这些"查看/删除入口;`/context` 现在退化成"约N条消息" | [官方有] |
| K | 流式 idle 看门狗 | 上游建流后卡住不吐 token 只能干等;加逐块 idle 计时(90s 无新 chunk 中断按可重试) | [官方有] |

## 🚫 别建(cc-haha有但官方专属/不适用我们)
- **服务端 context-editing**(`clear_tool_uses_20250919`/`clear_thinking`,beta header `context-management-2025-06-27`):**Anthropic API 专属**,我们走 OpenAI 兼容端点(mimo/DeepSeek/通义)没对等物;已用客户端 microcompact 模拟。等接入支持的 provider 再说。
- **Anthropic Memory Tool**(`memory_20250818`):官方跨会话记忆工具(Sonnet4.5;配 context-editing 内部评测 +39%、100轮省84% token)。是另一种(工具式)记忆设计——我们走"完整轨迹+店脑记忆+RAG",可并存/借鉴,但非必须照搬。
- **Prompt 前缀缓存显式标记**:DeepSeek 系**自动前缀缓存**,缺显式 cache_control 影响有限;仅接 Anthropic 式端点才需要。
- **worktree/tmux 团队子代理、/rewind**:CLI 用户才需要,单窗口老板产品不必。

## 来源(官方)
- [Parallel tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)、[Subagents in the SDK](https://code.claude.com/docs/en/agent-sdk/subagents)、[Run agents in parallel](https://code.claude.com/docs/en/agents)
- [Compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)、[Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)、[Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)、[Equipping agents with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Error reference / retry](https://code.claude.com/docs/en/errors)、[Enabling Claude Code to work autonomously](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)
- 本地参考:`~/Desktop/cc-haha-ref`(withRetry.ts / failover · compact/* · hooks/* · AgentTool / SkillTool · FileReadTool)
