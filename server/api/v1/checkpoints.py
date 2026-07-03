# -*- coding: utf-8 -*-
"""F-12 影子 git 检查点·回滚 API。

配合 `services/shadow_git.py`（工作区级快照）+ `services/agent/checkpoint_index.py`
（会话→检查点旁路索引）：列出某会话打过的检查点、按三选一模式恢复。

签名/权限：跟现有 `/agent/execute` 审批闸同一套机制（`services/agent/approval.py` 的
HMAC 签名，防"篡改参数后裸调"）——`GET /checkpoints` 列表时给每条记录签一个绑定
(conversation_id, sha) 的 token，`POST /checkpoints/restore` 强制校验 token 匹配才执行，
不接受没有合法 token 的直接调用。

恢复是**近破坏性操作**：
- `files_only`——只恢复工作文件夹的文件内容（见 `shadow_git.restore_files`：恢复前自动留一条
  "恢复前"检查点、只覆盖/找回目标提交里存在的文件，绝不删除任何文件）；
- `chat_only`——只把聊天时间线【逻辑截断】回到该检查点所在轮开始前（见
  `checkpoint_index.truncate_chat_to_checkpoint`：先备份完整轨迹副本，不是真删）；
- `both`——两者都做。
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel

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
    每条记录带一个签过名的 token——发起恢复时必须原样带回，防篡改。"""
    from services.agent.approval import sign_approval
    from services.agent.checkpoint_index import list_checkpoints

    rows = list_checkpoints(conversation_id)
    out = []
    for r in rows:
        sha = r.get("sha") or ""
        token = sign_approval("checkpoint_restore", {"conversation_id": conversation_id, "sha": sha})
        out.append({**r, "token": token})
    return {"conversation_id": conversation_id, "checkpoints": out}


class CheckpointRestoreRequest(BaseModel):
    conversation_id: str
    sha: str
    mode: str  # "files_only" | "chat_only" | "both"
    working_dir: str | None = None  # 仅当索引里查不到该检查点的 working_dir 时才用它兜底
    token: str


@router.post("/restore")
async def restore_checkpoint(
    body: CheckpointRestoreRequest,
    user: User = Depends(get_current_user),
):
    from services.agent.approval import verify_approval

    if not verify_approval(
        "checkpoint_restore", {"conversation_id": body.conversation_id, "sha": body.sha}, body.token
    ):
        raise AIServiceError("确认信息缺失或已变化，请重新发起这次恢复")
    if body.mode not in _VALID_MODES:
        raise AIServiceError("恢复模式不对", status_code=400)

    from services.agent.checkpoint_index import get_checkpoint, truncate_chat_to_checkpoint

    record = get_checkpoint(body.conversation_id, body.sha)
    if record is None:
        raise AIServiceError("找不到这个检查点，可能已经过期或者传错了", status_code=400)

    result: dict = {"ok": True, "mode": body.mode, "sha": record.get("sha")}

    if body.mode in ("files_only", "both"):
        from services.agent.context import AgentContext
        from services.shadow_git import restore_files

        working_dir = record.get("working_dir") or body.working_dir
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
