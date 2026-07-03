# -*- coding: utf-8 -*-
"""F-12 影子 git 检查点 · PostToolUse 钩子接线。

写改类工具（write_file/edit_file/edit_excel/delete_file，即 `approval_class=="file"` 那一档）
成功执行后，自动给用户工作文件夹打一个影子 git 快照（见 `services/shadow_git.py`），让"跳过确认"
模式真的有"后悔药"。

钩子机制天然双处生效（`services/agent/hooks.py` 的 `run_post_tool_hooks`，触发点在
`services/agent/loop.py` 主循环 + `api/v1/agent.py` 的 `/agent/execute` 审批执行端），不用改任何
单个工具的代码。只对写改类工具触发——只读工具（read_file/run_command 等）不打快照，省无意义的
空跑（反正 `commit_checkpoint` 内部也会因为"没改动"自动跳过，这里提前按工具名过滤是为了不浪费
一次 `git add -A` + `status` 的子进程开销）。

故障安全：`shadow_git.commit_checkpoint` 自己已经把所有失败路径都收敛成返回 `None`（没有 git /
工作目录太危险 / git 操作本身失败，都不抛异常）；`run_post_tool_hooks` 外层也会吞任何钩子异常。
这里仍然整体包一层 try/except 当第三重保险——**绝不能因为检查点功能而影响主工具的执行结果**。
"""
import logging

from services.agent.hooks import register_post_tool_hook

logger = logging.getLogger(__name__)

# 写改类工具名单：对应 registry.py 里 approval_class=="file" 的那几个（local_tools.py 定义）。
# 直接用名字判断而不是反查 registry——钩子签名拿不到 registry 实例，按名字判断更简单也更明确。
_WRITE_TOOL_NAMES = {"write_file", "edit_file", "edit_excel", "delete_file"}


async def _shadow_git_post_hook(tool_name: str, args: dict, result: str, ctx) -> None:
    if tool_name not in _WRITE_TOOL_NAMES:
        return
    try:
        from services.shadow_git import commit_checkpoint

        target = args.get("path") if isinstance(args, dict) else None
        label = f"{tool_name}:{target}" if target else tool_name
        sha = commit_checkpoint(ctx, label=label)
        if not sha:
            return  # 没 git / 工作目录不合法 / 空改动，都属于正常情况，静默跳过
        conversation_id = getattr(ctx, "conversation_id", None)
        if not conversation_id:
            return  # 全新会话第一轮还没分配 conversation_id，见 checkpoint_index.py 顶部说明
        from services.agent.checkpoint_index import record_checkpoint

        record_checkpoint(
            conversation_id, sha=sha, tool=tool_name, label=label,
            target=target, working_dir=getattr(ctx, "working_dir", None),
        )
    except Exception:
        logger.warning("影子 git 检查点钩子失败（已忽略，不影响工具本身的执行结果）", exc_info=True)


_installed = False


def install_shadow_git_hook() -> None:
    """幂等安装（同 `goal_hook.install_goal_hook` 的写法）：多次调用只注册一次。"""
    global _installed
    if _installed:
        return
    register_post_tool_hook(_shadow_git_post_hook)
    _installed = True


def reset_installed_flag_for_tests() -> None:
    """测试专用：配合 `hooks.clear_hooks()` 用——那个会把注册表整个清空，若不同步复位这里的
    幂等标记，下次 `install_shadow_git_hook()` 会误以为"已经装过"而不再真正注册。"""
    global _installed
    _installed = False
