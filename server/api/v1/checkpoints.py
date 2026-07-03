# -*- coding: utf-8 -*-
"""F-12 影子 git 检查点·回滚 API。

配合 `services/shadow_git.py`（工作区级快照）+ `services/agent/checkpoint_index.py`
（会话→检查点旁路索引）：列出某会话打过的检查点、按三选一模式恢复。

签名/权限：跟现有 `/agent/execute` 审批闸同一套机制（`services/agent/approval.py` 的
HMAC 签名，防"篡改参数后裸调"）——`GET /checkpoints` 列表时给每条记录**分别**签
files_only/chat_only/both 三个 token（各自的签名负载都含 mode），`POST /checkpoints/restore`
强制校验「token 与 (conversation_id, sha, mode) 三者都匹配」才执行。

F-12 复审 Important #2 修复：原先签名负载只有 (conversation_id, sha)，不含 mode——意味着拿到一个
"只回文件"的合法 token，照样能把请求体里的 mode 改成 "both"（连聊天一起回退）而不被拒绝，因为
verify_approval 从不知道"这个 token 是为哪个 mode 签的"。现在把 mode 并入签名负载，每个
checkpoint 一次性签出三种 mode 各自的 token；服务端按 body.mode 精确验证对应的那个签名，
换 mode 用同一个 token 会因为签名负载变了而验证失败。

working_dir 不再接受客户端传入——`CheckpointRestoreRequest` 已去掉这个字段，文件恢复用的
working_dir 只从检查点索引记录里取（`checkpoint_index.record_checkpoint` 在 PostToolUse 钩子
触发那一刻，用真实会话的 `ctx.working_dir` 写入，是服务端可信数据，不是请求体输入）——彻底堵死
"客户端指定任意目录当作恢复落点"这条破坏面。

恢复是**近破坏性操作**：
- `files_only`——只恢复工作文件夹的文件内容（见 `shadow_git.restore_files`：恢复前自动留一条
  "恢复前"检查点、只覆盖/找回目标提交里存在的文件，绝不删除任何文件）；
- `chat_only`——只把聊天时间线【逻辑截断】回到该检查点所在轮开始前（见
  `checkpoint_index.truncate_chat_to_checkpoint`：先备份完整轨迹副本，不是真删）；
- `both`——两者都做。
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from api.deps import get_current_user
from core.exceptions import AIServiceError
from models.user import User

router = APIRouter(tags=["检查点·影子git回滚"])

_VALID_MODES = {"files_only", "chat_only", "both"}


@router.get("")
async def list_checkpoints_route(
    conversation_id: str,
    user: User = Depends(get_current_user),
):
    """列出某会话打过的检查点（供"回到这一步"入口渲染；F-12b 前端跟进件用）。
    每条记录带 files_only/chat_only/both 三个各自签过名的 token——发起恢复时必须带上跟所选
    mode 对应的那一个，不能拿别的 mode 的 token 混用（换 mode 验签会失败，见 restore_checkpoint）。"""
    from services.agent.approval import sign_approval
    from services.agent.checkpoint_index import list_checkpoints

    rows = list_checkpoints(conversation_id)
    out = []
    for r in rows:
        sha = r.get("sha") or ""
        tokens = {
            mode: sign_approval(
                "checkpoint_restore", {"conversation_id": conversation_id, "sha": sha, "mode": mode}
            )
            for mode in _VALID_MODES
        }
        out.append({**r, "tokens": tokens})
    return {"conversation_id": conversation_id, "checkpoints": out}


class CheckpointRestoreRequest(BaseModel):
    # extra="forbid"：显式拒绝任何声明外的字段——尤其是曾经存在过的 working_dir。不用默认的
    # "静默丢弃未知字段"，是为了让"client 传了 working_dir"这件事本身就是一次硬校验失败（422），
    # 而不是看起来传成功了、实际却被悄悄忽略，容易被误以为"生效了只是没测出来"。
    model_config = ConfigDict(extra="forbid")

    conversation_id: str
    sha: str
    mode: str  # "files_only" | "chat_only" | "both"
    token: str
    # 注意：故意没有 working_dir 字段——文件恢复的落点只能来自服务端检查点索引里记的、
    # PostToolUse 钩子触发那一刻真实的 ctx.working_dir（可信数据），不接受客户端指定任意目录
    # （F-12 复审 Important #2：原先允许请求体传 working_dir 兜底覆盖，是一个可指哪恢复哪的破坏面）。


@router.post("/restore")
async def restore_checkpoint(
    body: CheckpointRestoreRequest,
    user: User = Depends(get_current_user),
):
    from services.agent.approval import verify_approval

    if body.mode not in _VALID_MODES:
        raise AIServiceError("恢复模式不对", status_code=400)
    if not verify_approval(
        "checkpoint_restore",
        {"conversation_id": body.conversation_id, "sha": body.sha, "mode": body.mode},
        body.token,
    ):
        # mode 已并入签名负载：换个 mode 拿同一个 token 提交，这里会因为签名负载对不上而拒绝
        # （而不是像原先那样只绑 (conversation_id, sha)，任何合法 token 换什么 mode 都能通过）。
        raise AIServiceError("确认信息缺失或已变化，请重新发起这次恢复")

    from services.agent.checkpoint_index import get_checkpoint, truncate_chat_to_checkpoint

    record = get_checkpoint(body.conversation_id, body.sha)
    if record is None:
        raise AIServiceError("找不到这个检查点，可能已经过期或者传错了", status_code=400)

    result: dict = {"ok": True, "mode": body.mode, "sha": record.get("sha")}

    if body.mode in ("files_only", "both"):
        from services.agent.context import AgentContext
        from services.shadow_git import restore_files

        working_dir = record.get("working_dir")  # 只信服务端记的，不接受客户端指定
        if not working_dir:
            result["ok"] = False
            result["files"] = {"ok": False, "error": "这个检查点没有记录工作目录，没法恢复文件"}
        else:
            ctx = AgentContext(working_dir=working_dir, conversation_id=body.conversation_id)
            file_result = restore_files(ctx, record.get("sha") or body.sha)
            result["files"] = file_result
            if not file_result.get("ok"):
                result["ok"] = False

    if body.mode in ("chat_only", "both"):
        chat_result = truncate_chat_to_checkpoint(
            body.conversation_id, record.get("transcript_len_at_commit", 0)
        )
        result["chat"] = chat_result
        if not chat_result.get("ok"):
            result["ok"] = False

    return result
