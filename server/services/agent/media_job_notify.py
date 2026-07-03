# -*- coding: utf-8 -*-
"""长任务(media_jobs)完成回灌 —— F-10：给挂在聊天里的慢视频工具用。

背景:generate_video(tools.py)/render_video(video_edit_tools.py) 这类工具改成"提交 media job
就立即返回任务号"之后，老板只在提交那一刻听到"在后台做"——真正做完(成功/失败/超时统统会走到
`media_jobs_runner._run` 的 try/except 兜底)时，得靠这里把结果补上：

① 落 transcript 持久层：append_transcript 挂到该 job 的 conversation_id → 【继续对话】续接模型
   上下文时(`_load_agent_history`)能读到完整轨迹，不依赖当时连没连着(重启即丢的内存态不能作为
   唯一真相源)。
② 落一条 Generation 完成行：`get_agent_conversation`(桌面「打开历史会话」唯一走的那条 UI 路径)
   只读 Generation 表(`type=="agent"`)、根本不读 transcript JSONL——F-10 审查发现的 Important：
   不补这行，老板点开会话历史，看到的永远是提交时落库的那条占位文案("已经在后台开始做…")，
   真正的完成/失败结果对这条 UI 路径来说"查无此消息"。字段照抄 `agent.py::_persist_agent_chat`
   现有 Generation 写法（type/sub_type/conversation_id/model_used），只是这条没有对应的用户消息
   (`input_params` 不带 `"message"` 键，`get_agent_conversation` 就不会把它误配成一条用户回声)。
③ 弹系统通知：notify_service.push 走统一通知层"叫一声"(尽力而为)。

成功/失败都要回灌 —— 失败也要说清"没做成、原因是什么"，别让老板对着一个永远不会来的结果干等。
故障安全：三步各自独立 try/except，任何一环出错只记日志、不连累另外两环——这是
media_jobs_runner 的完成回调，没人等它抛错，抛出去只会打日志变噪音、不会被任何人处理。
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from services import notify_service
from services.agent.transcript import append_transcript

logger = logging.getLogger(__name__)

FormatSuccess = Callable[["dict | None"], str]
FormatFail = Callable[["str | None"], str]


def _default_format_success(title: str) -> FormatSuccess:
    def _fmt(result: dict | None) -> str:
        result = result or {}
        url = result.get("video_url") or next(iter(result.get("urls") or []), None)
        if not url:
            return f"{title}(但没拿到播放链接，去生成历史看看)。"
        return f"{title}！👇\n\n[点击查看视频]({url})"

    return _fmt


def _default_format_fail(title: str) -> FormatFail:
    def _fmt(error: str | None) -> str:
        return f"{title}：{error or '未知原因'}"

    return _fmt


async def _write_completion_generation(
    *, store_id: Any, conversation_id: Any, user_id: Any, sub_type: str, text: str, job_id: str,
) -> None:
    """补一条 Generation(type="agent") 完成行，让 `get_agent_conversation`(打开历史会话)看得到。

    `get_agent_conversation`(api/v1/agent.py)只查 Generation 表(type=="agent")拼历史消息，完全
    不读 transcript JSONL——那条只在【继续对话】重建模型上下文(`_load_agent_history`)时才有人读。
    不写这行，老板点开会话历史，assistant 那条永远停在提交时的占位文案。

    store_id/conversation_id 缺一都没法归属到一条会话下（前者是必填列，后者是历史查询的过滤键），
    这种情况直接跳过——不强行落一条查不到的孤儿行。字段照抄 `_persist_agent_chat` 的现有写法，
    `input_params` 故意不带 `"message"` 键，避免 `get_agent_conversation` 把它误配成一条用户回声。
    """
    if store_id is None or conversation_id is None:
        return
    import uuid as _uuid

    from db.session import async_session  # 延迟导入：拿当下(可能被测试 monkeypatch 过)的 session 工厂
    from models.generation import Generation

    def _to_uuid(v: Any) -> _uuid.UUID:
        return v if isinstance(v, _uuid.UUID) else _uuid.UUID(str(v))

    async with async_session() as db:
        db.add(Generation(
            id=_uuid.uuid4(),
            store_id=_to_uuid(store_id),
            user_id=(_to_uuid(user_id) if user_id else None),
            type="agent", sub_type=sub_type,
            input_params={"job_id": job_id},
            result=text, model_used="agent",
            conversation_id=_to_uuid(conversation_id),
        ))
        await db.commit()


def make_video_job_done_hook(
    *,
    conversation_id: str | None,
    success_title: str = "视频做好了",
    fail_title: str = "视频没做成",
    format_success: FormatSuccess | None = None,
    format_fail: FormatFail | None = None,
    on_release: Callable[[], None] | None = None,
    store_id: Any = None,
    user_id: Any = None,
) -> Callable[[str, str, "dict | None", "str | None"], Any]:
    """造一个给 `media_jobs_runner.submit(on_done=...)` 用的完成回调。

    on_release：不管成功失败都【最先】调一次(如释放生成并发锁)，且排在 append/写 Generation/notify
    之前——即便后面几步意外出错，锁也已经放了，不会被这层旁路问题焊死("以后再也生不了视频")。
    format_success/format_fail：不传就用默认的"抓 video_url/urls[0] 拼成 markdown 视频链接"，
    render_video 想带上时长之类的定制文案时可以自己传一个。
    store_id/user_id：给"落一条 Generation 完成行"用（见 `_write_completion_generation`）；不传
    (如老单测直接构造 hook 不关心这条)就跳过写 Generation，只落 transcript + 弹通知(原有行为)。
    """
    fmt_ok = format_success or _default_format_success(success_title)
    fmt_err = format_fail or _default_format_fail(fail_title)

    async def _on_done(job_id: str, status: str, result: dict | None, error: str | None) -> None:
        # ① 释放锁永远最先做——即便下面几步都意外出错，锁也已经放了。
        if on_release is not None:
            try:
                on_release()
            except Exception:
                logger.warning("job %s 完成回调释放并发锁失败", job_id, exc_info=True)

        ok = status == "done"
        try:
            text = fmt_ok(result) if ok else fmt_err(error)
        except Exception:
            logger.warning("job %s 完成文案格式化失败，退用兜底文案", job_id, exc_info=True)
            text = f"{success_title if ok else fail_title}（结果格式化失败，去生成历史看看）。"

        # ② 落 transcript(续接对话时读)、③ 落 Generation 完成行(打开历史会话时读)、④ 弹通知(叫一声)
        # 各自独立包一层——任一环炸了都不能连累另外两环。
        try:
            append_transcript(conversation_id, [{"role": "assistant", "content": text}])
        except Exception:
            logger.warning("媒体任务 %s 落 transcript 失败(conversation_id=%s)", job_id, conversation_id, exc_info=True)
        try:
            await _write_completion_generation(
                store_id=store_id, conversation_id=conversation_id, user_id=user_id,
                sub_type=("media_job_done" if ok else "media_job_failed"), text=text, job_id=job_id,
            )
        except Exception:
            logger.warning("媒体任务 %s 落完成 Generation 失败(conversation_id=%s)", job_id, conversation_id, exc_info=True)
        try:
            if ok:
                notify_service.push(
                    success_title, "做好啦，点开看看。", kind="media_job_done",
                    task_id=job_id, conversation_id=conversation_id,
                )
            else:
                notify_service.push(
                    fail_title, (error or "未知原因")[:120], kind="media_job_failed",
                    task_id=job_id, conversation_id=conversation_id,
                )
        except Exception:
            logger.warning("媒体任务 %s 弹通知失败(conversation_id=%s)", job_id, conversation_id, exc_info=True)

    return _on_done
