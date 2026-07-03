"""Agent 运行时上下文：跨工具共享的 db / 门店 / 用户等。

P0 先放最小骨架，字段用 Any 避免与 models/db 的硬耦合；
P1 接真实工具时各 handler 自行按需取用。
"""
from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentContext:
    db: Any = None     # AsyncSession
    store: Any = None  # 当前门店 Store
    user: Any = None   # 当前用户 User
    # 用户本次经【OS 文件选择器】当场选定、显式授权 Agent 可读/改的文件或目录绝对路径。
    # 本地文件工具的沙箱 = 内容库 + 这些路径；空 = 只能动内容库（桌面默认）。云端 web 版恒为空。
    allowed_paths: list[str] = field(default_factory=list)
    # 审批/自主级别（老板在桌面设的"权限"）：
    #   "ask"        每次写/改/对外动作都弹确认（默认，最稳）；
    #   "auto_files" 信任模式：本机文件读改免确认直接动手（仍自动备份），对外/写入仍弹确认；
    #   "full"       最高权限：所有动作（含对外/写入）都免确认自动执行。
    permission_mode: str = "ask"
    # 本会话工作目录(用户选/新建的文件夹绝对路径):相对路径默认落这 + 自动接受编辑的主范围。
    # 空 = 无工作目录(行为同今天:相对路径落内容库)。可达范围不受它影响(对标 CC,全盘可达靠权限档把关)。
    working_dir: str | None = None
    # 当前会话 id：让生图/生视频的 Generation 落在同一会话里(海报→视频可追溯、最近作品按会话归并)；
    # None = 新会话还没拿到 id，服务层会自建一个。
    conversation_id: str | None = None
    # /goal 目标驱动：设了目标 → 收尾前 Stop hook 回灌"对照目标自检"，没完成就继续（受 max_turns 兜底）。
    goal: str = ""
    # 范围越界开关：True = 文件工具不再限于"内容库+选定文件"，可碰任意路径（高级·带风险）。
    full_disk_access: bool = False
    # 防打转计数：同一工具+完全相同参数的调用次数（_execute_tool 跨轮维护），超阈值拦下逼模型换思路。
    call_counts: dict = field(default_factory=dict)
    # full(跳过确认)模式下，本轮 Agent 运行内已「免确认自动放行的对外/写入动作」次数；
    # 幕后静默兜底：超上限即使 full 也强制弹确认——防批量自动对外/写入失控(B-5/C-1)。
    auto_spend_count: int = 0
    # 自动放行上限闸的「本店上限值」：老板可在 UI 调高/调低/关闭（这是他自己机器上的对外动作，应由他掌控）。
    #   None = 用 DESKTOP_AGENT_AUTO_SPEND_LIMIT 环境默认；
    #   N>=0 = 一轮内自动放行上限（0 = 对外/写入永远先确认）；
    #   N<0（如 -1）= 老板主动关闭上限闸，full 下对外/写入也全自动放行。
    auto_spend_limit: int | None = None
    # B-2 本轮 deliverable 注入的知识名：deliverable 工具执行完把 gen.input_params["knowledge_used"]
    # 写进这里，loop 取后挂到该工具的 tool_result（step.meta / 流式事件），完即复位 None（防串到下一个工具）。
    last_knowledge_used: list | None = None
    # ── SH-2 token 预算递减早停（防发散打转空转不收尾 + 真实编排消耗可观测）──
    # token_budget：本次 Agent 任务允许消耗的 token 上限。
    #   None = 交互式不限（默认，对话场景行为零变化）；N>0 = 到 90% 或连续多轮增量极小就停/推动。
    token_budget: int | None = None
    # 累计已消耗 token（loop 每轮把 provider usage 累加进来；端点没返回则 len//4 粗估）。
    tokens_used: int = 0
    # 上一轮累计总量（算本轮增量 delta = tokens_used - last_total 用）。
    last_total: int = 0
    # 上一轮的增量（diminishing 判定：连续多轮 delta 都极小 = 在空转）。
    last_delta: int = 0
    # 预算推动语已下发次数（continuations>=3 且增量极小才算 diminishing；防一两轮误判早停）。
    budget_continuations: int = 0
    # ── SH-6 三级上下文压缩 · autocompact（第三级：临近窗口顶满时的语义兜底）──
    # 模型上下文窗口（token）。autocompact 阈值 = 这个 * autocompact_ratio。
    #   None = 不启用 autocompact（交互式默认，只靠 snip/microcompact 前两级；对现有行为零影响）。
    #   N>0  = 估算上下文 token 超过 N*ratio 时，把较早的非近 N 轮消息压成一段摘要（花一次 LLM）。
    model_ctx_window: int | None = None
    # autocompact 触发比例（窗口的百分之多少算"临近顶满"）；默认 0.7。
    # ⚠️ Gap C：现在阈值 = max(窗口−autocompact_buffer, 窗口×ratio)——大窗(如 1M)由固定 buffer 主导(接近满才压、
    #    不再 700k 就压)，小窗仍由 ratio 兜底(不回归)。ratio 仅作小窗下限。
    autocompact_ratio: float = 0.7
    # autocompact 固定余量(token)：阈值留这么多给"本轮输出+下一轮输入"。None = 用 loop 的 _AUTOCOMPACT_BUFFER_TOKENS。
    # 大窗(1M)留几万即可确保接近满才压；官方留 13k，我们大窗放宽。
    autocompact_buffer: int | None = None
    # autocompact 触发判据的【真实输入 token 数】信号：每轮 provider 返回后由 loop 写入(prompt_tokens)。
    # 触发判据 effective = max(估算, last_prompt_tokens)——有真值兜住估算误差。压缩成功后复位 0(防旧真值致双重压缩)。
    last_prompt_tokens: int = 0
    # autocompact 触发时保留原文的"最近消息"条数（更早的才压成摘要）；保护近几轮上下文不被压糊。
    autocompact_keep: int = 12
    # autocompact 连续"真失败"（摘要 LLM 抛错 / 返回空摘要）次数；达 _AUTOCOMPACT_FAIL_MAX 即熔断、不再每轮空烧 LLM。
    # 压成功 → 清零；"较早段太短 / 空 transcript"这类"不值得压"不算失败、不计数。借鉴 CC s08 的连续失败熔断器。
    autocompact_fail_streak: int = 0
    # F9 快满大白话提示：`_autocompact` 每次【真的重建了 messages】（不管是常规每轮压缩流水线触发的，
    # 还是 F8甲 结构性超限安全网强制触发的）都会把这里置 True。流式循环在每轮调完 `_compact_pipeline`
    # 后检查这个标记，命中就吐一次 context_note 事件给前端（大白话告诉老板"刚归纳了前文"）、随即清零，
    # 绝不刷屏。同步入口没有事件通道，不检查也不清这个标记（对它零影响）。
    just_autocompacted: bool = False
    # ── SH-8 连续拒绝自动回退（老板反复拒同一动作 → 别再反复提，自动换法子）──
    # 按【动作 key（工具名|规范化 args）】记的"连续被拒次数"：审批卡老板点拒绝 → +1；
    # 同一动作连续达 _DENIAL_FALLBACK_N 次 → loop 不再提请该动作，改走文本答复/换方案。
    # 成功确认执行该动作 → 该 key 清零（老板改主意了，回到正常审批）。故障安全：取/写都带默认。
    denials_by_action: dict = field(default_factory=dict)
    # 全局累计拒绝次数（跨动作）：达 _DENIAL_FALLBACK_TOTAL 也整体回退到逐项确认观察期，防"换个参数接着烦"。
    denials_total: int = 0
    # ── 第二批真 Agent 工具（对标 Claude Code 的 TodoWrite / Task）──
    # TodoWrite 写进来的多步任务清单：每项 {"task": str, "status": "pending|in_progress|done"}。
    #   让 Agent 把"这次要分几步做"列出来、逐项跟踪进度（复杂任务先列清单再逐项做）。
    #   F4 Focus Chain：这份清单不再是写了没人读的死状态——task_progress 参数(下方)解析出的清单
    #   也统一写进这里，loop.py 据此渲染 todo_update 事件给前端(原地更新同一张卡)、也据此算提醒用的百分比。
    todos: list = field(default_factory=list)
    # ── F4 Focus Chain（抄 Cline）：模型可在【任意工具调用】里顺手带一个可选 task_progress
    #   参数（markdown 复选清单，如 `- [x] 已做\n- [ ] 待做`）——registry.py 无条件给每个工具
    #   的 schema 注入这个可选属性（与审批闸 2.0 的 security_risk 并存，两者都进 properties）。
    #   loop.py 摘到有效清单就存这里 + 同步解析进 ctx.todos（上面）+ 计数清零；没带就计数 +1。
    task_progress: str | None = None  # 最近一次收到的原始 markdown 文本（供展示原文/调试）
    # 连续多少次工具调用都没更新进度清单（task_progress 参数 / todo_write 工具，两条路径共用这个计数）。
    # 达到 _PROGRESS_REMIND_EVERY（loop.py）时，下一轮调模型前会尾部注入一条带百分比的提醒；
    # 提醒发出后清零，防刷屏。
    requests_since_progress: int = 0
    # run_subagent（子代理）递归跑 run_agent_loop 时复用的【同一个文字 provider / 模型】——
    #   loop 启动时把当次用的 provider/model 写进 ctx，子代理据此复用（同一门店 BYOK key、同模型），
    #   不必再各自去 factory 取。None = 子代理自己回退到编排默认 provider/model。
    provider: Any = None
    model: Any = None
    # 流式工具进度回调（命令边跑边显示）：run_agent_loop_stream 执行工具前挂上它，工具(如 run_command)
    #   执行中把每段输出经它推出去 → 循环 yield tool_progress 事件 → 前端实时渲染。同步入口/无需流式时为 None。
    progress_emit: Any = None
    # ── 非识图模型优雅降级（模型无关·反应式）──
    # 老板随消息带了图、但他自带的文字模型不支持图片（撞 image_url 直接报错），loop 会自动去图、用纯文字重试一次，
    # 并把这个标记置 True；拼最终答复处据此加一句温和提示（"看不了图，这次按文字来的，要看图换个带视觉的模型"）。
    # 不靠任何"识图/非识图模型清单"，纯靠"报错→去图重试"反应式判定（呼应壳子不分识图模型的原则）。默认 False。
    vision_degraded: bool = False
    # ── 工具产出图片回灌（让 computer-use 真能「看见」自己截的屏）──
    # 工具（如 computer screenshot）执行时把产出的本地图片路径 append 这里；loop 在一批 tool 结果
    # 全部追加、配对完整后，把这些图拼成一条 user 图片消息注入（走已验证的 image_url 通道、可被 vision_degrade
    # 接住），让模型在下一轮真看见图。取后清空，防串到下一轮。借 Kimi Code 把工具产出的图当 content 回灌的做法。
    pending_view_images: list = field(default_factory=list)
    # ── 跨轮记忆（照 Claude Code 做对）：流式 loop 收尾时把【完整对话轨迹】（含 tool_calls/结果 + 补上的
    #    最终 assistant 答复）写到这里，供端点整段落盘成 JSONL，下一轮整段读回当 history → 模型真记得住前面。
    #    含 system（落盘由 transcript 层剥）。None = 没跑流式 loop / 未收尾。
    final_messages: list | None = None
    # ── 方向盘 · 跑动中插话纠偏（对标 Claude Code 的 steering）──
    # 任务跑着时用户补发的话（POST /agent/tasks/{id}/message 塞进来的原文，一条一个字符串）。
    # loop 在每批工具执行完、下一次调模型前 drain 出来，按序【追加在消息尾部】成 user 消息
    # （绝不改前面历史 → 保住 prompt-cache 前缀），模型下一轮当场看到、当场改道。
    # 路由侧封顶 10 条防灌爆。同步/流式两个 loop 都会 drain（子代理/审批续接用的是各自新建的 ctx、
    # 队列恒空，不会截胡主循环的插话）。
    steer_inbox: list = field(default_factory=list)
    # ── 取消不丢记忆：loop 一开跑就把【活的 messages 列表引用】挂这——用户点停止（CancelledError）时
    # 端点用它照样落轨迹，"停掉的活"下一轮还接得上，不再失忆。loop 内部对 messages 全是就地变更
    # （append / 切片赋值），这个引用全程有效。None = loop 还没跑起来。
    live_messages: list | None = None
