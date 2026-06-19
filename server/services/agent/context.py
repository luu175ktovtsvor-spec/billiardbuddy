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
    #   "ask"        每次写/改/花钱都弹确认（默认，最稳）；
    #   "auto_files" 信任模式：本机文件读改免确认直接动手（仍自动备份），花钱/对外仍弹确认；
    #   "full"       最高权限：所有动作（含花钱/对外）都免确认自动执行。
    permission_mode: str = "ask"
    # 范围越界开关：True = 文件工具不再限于"内容库+选定文件"，可碰任意路径（高级·带风险）。
    full_disk_access: bool = False
    # 防打转计数：同一工具+完全相同参数的调用次数（_execute_tool 跨轮维护），超阈值拦下逼模型换思路。
    call_counts: dict = field(default_factory=dict)
    # full(跳过确认)模式下，本轮 Agent 运行内已「免确认自动放行的花钱动作」次数；
    # 超上限即使 full 也强制弹确认——防批量出图静默扣 BYOK 余额(B-5/C-1)。
    auto_spend_count: int = 0
    # 花钱上限闸的「本店上限值」：老板可在 UI 调高/调低/关闭（这是他自己的 BYOK 生图 key 和钱，应由他掌控）。
    #   None = 用 DESKTOP_AGENT_AUTO_SPEND_LIMIT 环境默认；
    #   N>=0 = 一轮内自动花钱上限（0 = 花钱永远先确认）；
    #   N<0（如 -1）= 老板主动关闭上限闸，full 下花钱也全自动放行。
    auto_spend_limit: int | None = None
    # B-2 本轮 deliverable 注入的知识名：deliverable 工具执行完把 gen.input_params["knowledge_used"]
    # 写进这里，loop 取后挂到该工具的 tool_result（step.meta / 流式事件），完即复位 None（防串到下一个工具）。
    last_knowledge_used: list | None = None
    # ── SH-2 token 预算递减早停（防 BYOK 发散打转烧光钱 + 真实编排消耗可观测）──
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
