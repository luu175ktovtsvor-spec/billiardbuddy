"""语音输入(D-Task-9):浏览器录音(webm/wav)→ 文字,填进输入框(可改可发)。

麦克风按钮走口播同一套"模型就绪门"(Electron IPC `window.electron.models`,纯前端订阅)——
这里不重复造后端就绪端点;前端没就绪就不会调这条,别再加判断。

转写复用 `services/video_edit/transcribe.py` 的 `_get_model()`(省得重复加载模型),薄封装
`transcribe_short_audio()` 不落缓存、不做词级时间戳,只拼句子返回。

格式:MediaRecorder 默认出 audio/webm(opus)。faster-whisper 走 PyAV 解码,理论上能直接吃
webm/opus,但没真机验过——稳妥做法是"先直接喂→解码失败用打包的 ffmpeg 转 16k 单声道 wav 兜底重试"。
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from api.deps import get_current_store
from models.store import Store
from services.video_edit import ffbin as _ffbin
from services.video_edit import transcribe as _transcribe_mod

router = APIRouter()


@router.post("/transcribe")
async def voice_transcribe(
    file: UploadFile = File(...),
    store: Store = Depends(get_current_store),
) -> dict:
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="没收到录音内容，请重新录一次")

    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    with tempfile.TemporaryDirectory(prefix="voice_") as tmp_dir:
        raw_path = Path(tmp_dir) / f"input{suffix}"
        raw_path.write_bytes(content)
        try:
            text = _transcribe_mod.transcribe_short_audio(str(raw_path))
        except Exception:
            # 直接喂解码失败(如某些 webm/opus 变体)→ 用打包的 ffmpeg 转成 16k 单声道 wav 兜底重试。
            wav_path = Path(tmp_dir) / "converted.wav"
            try:
                subprocess.run(
                    [_ffbin.ffmpeg_bin(), "-y", "-i", str(raw_path), "-ar", "16000", "-ac", "1", str(wav_path)],
                    check=True, capture_output=True,
                )
                text = _transcribe_mod.transcribe_short_audio(str(wav_path))
            except Exception as e:
                # 转写彻底失败:友好错误、别崩(故障安全)。
                raise HTTPException(status_code=422, detail="没听清，请再说一次或改用文字输入") from e

    return {"text": text}
