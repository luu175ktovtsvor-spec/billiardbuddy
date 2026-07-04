"""D-Task-9 语音输入端点测试:桩 whisper(`transcribe_short_audio`)+ 桩 ffbin,
断言 {text} + "直接喂失败→ffmpeg 兜底转码→重试" 路径 + 转写彻底失败时给友好错误不崩。

同 test_store_docs_api.py 的约定:不用 TestClient,直接 import 端点函数当普通异步函数调用
(传 file=/store= 绕开 Depends),配 in-memory SQLite。

monkeypatch 用字符串路径打在 `services.video_edit.transcribe.transcribe_short_audio` /
`services.video_edit.ffbin.ffmpeg_bin` 上——voice.py 用 `import ... as` 拿模块对象、
调用时走属性查找(而非 from-import 把名字提前拷贝走),所以这样打桩能生效
(同 test_video_edit_tools.py 对 `services.video_edit.transcribe.transcribe` 的打法)。
"""
from __future__ import annotations

import asyncio
import uuid
from io import BytesIO

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import api.v1.voice as api_voice
import models  # noqa: F401
from db.base import Base
from models.store import Store
from models.user import User


async def _make_db():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    return eng, Session


async def _seed_store(db) -> Store:
    u = User(id=uuid.uuid4(), phone=f"1390000{uuid.uuid4().hex[:4]}", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    store = Store(id=uuid.uuid4(), owner_id=u.id, name="店")
    db.add(store)
    await db.flush()
    return store


def _upload(content: bytes = b"fake-audio-bytes", filename: str = "rec.webm") -> UploadFile:
    return UploadFile(file=BytesIO(content), filename=filename)


def test_transcribe_returns_text(monkeypatch):
    monkeypatch.setattr(
        "services.video_edit.transcribe.transcribe_short_audio",
        lambda path, **kw: "你好，我要订晚上八点的球台",
    )

    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            r = await api_voice.voice_transcribe(file=_upload(), store=store)
            assert r == {"text": "你好，我要订晚上八点的球台"}
        await eng.dispose()

    asyncio.run(main())


def test_transcribe_falls_back_to_ffmpeg_on_decode_error(monkeypatch):
    """直接喂 whisper 抛解码错(模拟某些 webm/opus 变体解不出来)→ 用打包的 ffmpeg 转 wav 兜底重试→仍返回文字。"""
    calls = {"n": 0}

    def fake_transcribe(path, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("解码失败(模拟 opus 变体)")
        return "转码后识别出的文字"

    monkeypatch.setattr("services.video_edit.transcribe.transcribe_short_audio", fake_transcribe)
    # 桩 ffbin:用系统自带的 "true"(忽略所有参数、直接成功退出)代替真 ffmpeg——
    # 第二次 transcribe_short_audio 调用本身也是桩、不读文件内容,不需要真转出一个可用 wav。
    monkeypatch.setattr("services.video_edit.ffbin.ffmpeg_bin", lambda: "true")

    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            r = await api_voice.voice_transcribe(file=_upload(), store=store)
            assert r == {"text": "转码后识别出的文字"}
            assert calls["n"] == 2, "应该真走了「直接喂失败→ffmpeg转码→重试」这条路径(调用两次)"
        await eng.dispose()

    asyncio.run(main())


def test_transcribe_friendly_error_when_all_fail(monkeypatch):
    """直接喂 + ffmpeg 兜底都失败 → 友好错误(422),不崩、不 500。"""
    def always_fail(path, **kw):
        raise RuntimeError("彻底解不出来")

    monkeypatch.setattr("services.video_edit.transcribe.transcribe_short_audio", always_fail)
    monkeypatch.setattr("services.video_edit.ffbin.ffmpeg_bin", lambda: "true")

    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            with pytest.raises(HTTPException) as exc_info:
                await api_voice.voice_transcribe(file=_upload(), store=store)
            assert exc_info.value.status_code == 422
        await eng.dispose()

    asyncio.run(main())


def test_transcribe_rejects_empty_upload():
    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            with pytest.raises(HTTPException) as exc_info:
                await api_voice.voice_transcribe(file=_upload(content=b""), store=store)
            assert exc_info.value.status_code == 400
        await eng.dispose()

    asyncio.run(main())
