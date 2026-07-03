# -*- coding: utf-8 -*-
"""F-12 影子 git 检查点 · PostToolUse 钩子接线。

写改类工具（`approval_class=="file"` 那一档，如 write_file/edit_file/edit_excel/delete_file/
edit_image——动态查 registry 判定，见 `_is_write_tool`，不是手抄名单）成功执行后，自动给用户
工作文件夹打一个影子 git 快照（见 `services/shadow_git.py`），让"跳过确认"模式真的有"后悔药"。

钩子机制天然双处生效（`services/agent/hooks.py` 的 `run_post_tool_hooks`，触发点在
`services/agent/loop.py` 主循环 + `api/v1/agent.py` 的 `/agent/execute` 审批执行端），不用改任何
单个工具的代码。只对写改类工具触发——只读工具（read_file/run_command 等）不打快照，省无意义的
空跑（反正 `commit_checkpoint` 内部也会因为"没改动"自动跳过，这里提前按工具类别过滤是为了不浪费
一次 `git add -A` + `status` 的子进程开销）。

故障安全：`shadow_git.commit_checkpoint` 自己已经把所有失败路径都收敛成返回 `None`（没有 git /
工作目录太危险 / git 操作本身失败，都不抛异常）；`run_post_tool_hooks` 外层也会吞任何钩子异常。
这里仍然整体包一层 try/except 当第三重保险——**绝不能因为检查点功能而影响主工具的执行结果**。
"""
import logging

from services.agent.hooks import register_post_tool_hook

logger = logging.getLogger(__name__)


def _is_write_tool(tool_name: str) -> bool:
    """写改类判据：动态查 `default_registry`，判 `approval_class == "file"`（跟 `loop.py`
    `_file_target_oob` 同款判据），不再手抄一份工具名单。

    F-12 复审 Important #1 修复：原先硬编码 `{"write_file","edit_file","edit_excel","delete_file"}`
    漏了 `image_tools.py` 里同为 `approval_class=="file"` 的 `edit_image`——用户"把海报裁个方形"
    这类高频操作打不上影子 git 快照。项目之前 `loop.py` 的 `_file_target_oob` 就踩过同一种"手抄
    名单漏登记新工具"的坑，教训是换成反查 registry 的动态判据：以后任何新增的 file 类工具（不管
    叫什么名字）都自动被覆盖，不用再回来改这份名单。

    查不到这个工具（名字打错/还没注册/只读工具本就不在这个判据范围）→ 保守当"不是写改类"，
    不触发检查点——跟原来"名单里没有就跳过"的故障安全语义一致。"""
    from services.agent.registry import default_registry

    t = default_registry.get(tool_name)
    return getattr(t, "approval_class", None) == "file"


async def _shadow_git_post_hook(tool_name: str, args: dict, result: str, ctx) -> None:
    if not _is_write_tool(tool_name):
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
