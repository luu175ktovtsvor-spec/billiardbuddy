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
    autocompact_ratio: float = 0.7
    # autocompact 触发时保留原文的"最近消息"条数（更早的才压成摘要）；保护近几轮上下文不被压糊。
    autocompact_keep: int = 12
    # autocompact 连续"真失败"（摘要 LLM 抛错 / 返回空摘要）次数；达 _AUTOCOMPACT_FAIL_MAX 即熔断、不再每轮空烧 LLM。
    # 压成功 → 清零；"较早段太短 / 空 transcript"这类"不值得压"不算失败、不计数。借鉴 CC s08 的连续失败熔断器。
    autocompact_fail_streak: int = 0
    # ── SH-8 连续拒绝自动回退（老板反复拒同一动作 → 别再反复提，自动换法子）──
    # 按【动作 key（工具名|规范化 args）】记的"连续被拒次数"：审批卡老板点拒绝 → +1；
    # 同一动作连续达 _DENIAL_FALLBACK_N 次 → loop 不再提请该动作，改走文本答复/换方案。
    # 成功确认执行该动作 → 该 key 清零（老板改主意了，回到正常审批）。故障安全：取/写都带默认。
    denials_by_action: dict = field(default_factory=dict)
    # 全局累计拒绝次数（跨动作）：达 _DENIAL_FALLBACK_TOTAL 也整体回退到逐项确认观察期，防"换个参数接着烦"。
    denials_total: int = 0
    # ── 第二批真 Agent 工具（对标 Claude Code 的 TodoWrite / Task）──
    # TodoWrite 写进来的多步任务清单：每项 {"task": str, "status": "pending|in_progress|done"}。
    #   让 Agent 把"这次要分几步做"列出来、逐项跟踪进度（复杂任务先列清单再逐项做）。默认空。
    todos: list = field(default_factory=list)
    # run_subagent（子代理）递归跑 run_agent_loop 时复用的【同一个文字 provider / 模型】——
    #   loop 启动时把当次用的 provider/model 写进 ctx，子代理据此复用（同一门店 BYOK key、同模型），
    #   不必再各自去 factory 取。None = 子代理自己回退到编排默认 provider/model。
    provider: Any = None
    model: Any = None
