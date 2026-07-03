# -*- coding: utf-8 -*-
"""F-10：长任务完成回灌钩子(media_job_notify)单测。

锁住契约：
- 成功 → transcript 落一条含视频链接的 assistant 消息 + notify_service.push(kind=media_job_done)。
- 失败 → transcript 落一条"没做成、原因 X" + notify_service.push(kind=media_job_failed)，不能让
  老板对着一个永远不会来的结果干等。
- on_release 无论成功/失败都【最先】调一次(释放并发锁)，且排在 append/notify 之前。
- 故障安全：append_transcript/notify_service.push 任一炸了，钩子本身不能向外抛异常。
"""
import asyncio

import services.agent.media_job_notify as mjn
import services.agent.transcript as T


def _use_tmp(monkeypatch, tmp_path):
    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))


def test_success_appends_transcript_and_notifies(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    calls = {}
    monkeypatch.setattr(mjn.notify_service, "push",
                        lambda title, body, kind="info", **m: calls.update(title=title, body=body, kind=kind, meta=m))

    cid = "11111111-1111-1111-1111-111111111111"
    hook = mjn.make_video_job_done_hook(conversation_id=cid)
    asyncio.run(hook("job-1", "done", {"video_url": "/uploads/videos/a.mp4"}, None))

    assert calls["kind"] == "media_job_done"
    assert calls["meta"]["task_id"] == "job-1"
    out = T.load_transcript(cid)
    assert out is not None and len(out) == 1
    assert out[0]["role"] == "assistant"
    assert "/uploads/videos/a.mp4" in out[0]["content"]


def test_failure_appends_transcript_and_notifies(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    calls = {}
    monkeypatch.setattr(mjn.notify_service, "push",
                        lambda title, body, kind="info", **m: calls.update(kind=kind, body=body))

    cid = "22222222-2222-2222-2222-222222222222"
    hook = mjn.make_video_job_done_hook(conversation_id=cid, fail_title="视频没做成")
    asyncio.run(hook("job-2", "error", None, "Ark 超时"))

    assert calls["kind"] == "media_job_failed"
    out = T.load_transcript(cid)
    assert out is not None and len(out) == 1
    assert "视频没做成" in out[0]["content"] and "Ark 超时" in out[0]["content"]


def test_success_missing_url_falls_back_to_friendly_text(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    monkeypatch.setattr(mjn.notify_service, "push", lambda *a, **k: None)
    cid = "33333333-3333-3333-3333-333333333333"
    hook = mjn.make_video_job_done_hook(conversation_id=cid)
    asyncio.run(hook("job-3", "done", {}, None))
    out = T.load_transcript(cid)
    assert "没拿到播放链接" in out[0]["content"]


def test_urls_list_result_shape_supported(monkeypatch, tmp_path):
    """render_video 的默认结果形态是 {"urls": [...]}(不是 video_url)，也要能抓到链接。"""
    _use_tmp(monkeypatch, tmp_path)
    monkeypatch.setattr(mjn.notify_service, "push", lambda *a, **k: None)
    cid = "44444444-4444-4444-4444-444444444444"
    hook = mjn.make_video_job_done_hook(conversation_id=cid)
    asyncio.run(hook("job-4", "done", {"urls": ["/uploads/edits/p1/成片.mp4"]}, None))
    out = T.load_transcript(cid)
    assert "/uploads/edits/p1/成片.mp4" in out[0]["content"]


def test_on_release_called_first_before_success_path(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    monkeypatch.setattr(mjn.notify_service, "push", lambda *a, **k: None)
    order = []
    hook = mjn.make_video_job_done_hook(
        conversation_id="55555555-5555-5555-5555-555555555555",
        on_release=lambda: order.append("release"),
    )
    monkeypatch.setattr(mjn, "append_transcript", lambda *a, **k: order.append("append"))
    asyncio.run(hook("job-5", "done", {"video_url": "/uploads/videos/b.mp4"}, None))
    assert order == ["release", "append"]


def test_on_release_called_first_before_failure_path(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    monkeypatch.setattr(mjn.notify_service, "push", lambda *a, **k: None)
    order = []
    hook = mjn.make_video_job_done_hook(
        conversation_id="66666666-6666-6666-6666-666666666666",
        on_release=lambda: order.append("release"),
    )
    monkeypatch.setattr(mjn, "append_transcript", lambda *a, **k: order.append("append"))
    asyncio.run(hook("job-6", "error", None, "崩了"))
    assert order == ["release", "append"]


def test_on_release_called_even_when_status_is_error():
    """并发锁不管成功失败都要放开——失败路径漏放=下一条视频永远排不上队。"""
    released = []
    hook = mjn.make_video_job_done_hook(
        conversation_id=None,  # 没会话也照样要放锁
        on_release=lambda: released.append(True),
    )
    asyncio.run(hook("job-7", "error", None, "炸了"))
    assert released == [True]


def test_on_release_exception_does_not_break_hook(monkeypatch, tmp_path):
    """释放锁自己炸了(理论不该发生)也不能让后面的 transcript/notify 跟着不执行。"""
    _use_tmp(monkeypatch, tmp_path)
    monkeypatch.setattr(mjn.notify_service, "push", lambda *a, **k: None)
    cid = "77777777-7777-7777-7777-777777777777"
    hook = mjn.make_video_job_done_hook(
        conversation_id=cid,
        on_release=lambda: (_ for _ in ()).throw(RuntimeError("锁释放炸了")),
    )
    asyncio.run(hook("job-8", "done", {"video_url": "/uploads/videos/c.mp4"}, None))  # 不应向外抛
    out = T.load_transcript(cid)
    assert out is not None and "/uploads/videos/c.mp4" in out[0]["content"]


def test_notify_push_exception_does_not_break_hook(monkeypatch, tmp_path):
    """通知层炸了不能拖垮落 transcript(durable 靠 transcript，通知只是"叫一声")。"""
    _use_tmp(monkeypatch, tmp_path)

    def _boom(*a, **k):
        raise RuntimeError("通知队列炸了")
    monkeypatch.setattr(mjn.notify_service, "push", _boom)
    cid = "88888888-8888-8888-8888-888888888888"
    hook = mjn.make_video_job_done_hook(conversation_id=cid)
    asyncio.run(hook("job-9", "done", {"video_url": "/uploads/videos/d.mp4"}, None))  # 不应向外抛
