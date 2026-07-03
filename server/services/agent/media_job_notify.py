# -*- coding: utf-8 -*-
"""长任务(media_jobs)完成回灌 —— F-10：给挂在聊天里的慢视频工具用。

背景:generate_video(tools.py)/render_video(video_edit_tools.py) 这类工具改成"提交 media job
就立即返回任务号"之后，老板只在提交那一刻听到"在后台做"——真正做完(成功/失败/超时统统会走到
`media_jobs_runner._run` 的 try/except 兜底)时，得靠这里把结果补上：

① 落 transcript 持久层：append_transcript 挂到该 job 的 conversation_id → 老板重新打开这个
   会话就能看见，不依赖当时连没连着(重启即丢的内存态不能作为唯一真相源)。
② 弹系统通知：notify_service.push 走统一通知层"叫一声"(尽力而为)。

成功/失败都要回灌 —— 失败也要说清"没做成、原因是什么"，别让老板对着一个永远不会来的结果干等。
故障安全：append/notify 本身已经各自吞异常，这里再包一层，任何环节出错只记日志——这是
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


def make_video_job_done_hook(
    *,
    conversation_id: str | None,
    success_title: str = "视频做好了",
    fail_title: str = "视频没做成",
    format_success: FormatSuccess | None = None,
    format_fail: FormatFail | None = None,
    on_release: Callable[[], None] | None = None,
) -> Callable[[str, str, "dict | None", "str | None"], Any]:
    """造一个给 `media_jobs_runner.submit(on_done=...)` 用的完成回调。

    on_release：不管成功失败都【最先】调一次(如释放生成并发锁)，且排在 append/notify 之前——
    即便通知/落盘这两步意外出错，锁也已经放了，不会被这层旁路问题焊死("以后再也生不了视频")。
    format_success/format_fail：不传就用默认的"抓 video_url/urls[0] 拼成 markdown 视频链接"，
    render_video 想带上时长之类的定制文案时可以自己传一个。
    """
    fmt_ok = format_success or _default_format_success(success_title)
    fmt_err = format_fail or _default_format_fail(fail_title)

    async def _on_done(job_id: str, status: str, result: dict | None, error: str | None) -> None:
        # ① 释放锁永远最先做——即便下面 transcript/notify 两步都意外出错，锁也已经放了。
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

        # ② 落 transcript(durable，是老板打开会话真正看得到的结果)与 ③ 弹通知(尽力而为的"叫一声")
        # 各自独立包一层——通知层炸了不能连累更重要的 transcript 落盘，反之亦然。
        try:
            append_transcript(conversation_id, [{"role": "assistant", "content": text}])
        except Exception:
            logger.warning("媒体任务 %s 落 transcript 失败(conversation_id=%s)", job_id, conversation_id, exc_info=True)
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
