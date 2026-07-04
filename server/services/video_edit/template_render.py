"""V2 自研模板渲染器 —— 把挑好的时间轴文档渲成"有包装的竖屏成片"。

流程(对应开发文档 §5.2 / §8):
  时间轴文档(挑好的视频段)+ 每段文案 + 品牌词
    → ① 逐段抽帧(scale-cover 到目标尺寸 + HDR→SDR + 调色,复用 render.py 的链)
    → ② 写镜头清单 manifest.json
    → ③ 浏览器逐帧渲 template.html(标题条/品牌卡/转场/水印/卡拍脉冲)→ PNG 帧
    → ④ ffmpeg 编码 → 程序化卡点 BGM(bgm.py)→ 响度归一化 → 成片 mp4

Phase 1 用 Playwright(assets/render_frames.js);Phase 2 打包改走 Electron 离屏 BrowserWindow。
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import mix
from .bgm import beat_for_mood, synth_beat_bgm
from .ffbin import ffmpeg_bin, probe_video
from .render import _TONEMAP, _grade_filter

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _asset(frozen_rel: str, dev_path: Path) -> Path:
    """装机包(PyInstaller frozen)从 sys._MEIPASS 取资产,否则用 dev 路径(见审查 P0-2)。"""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS) / frozen_rel  # type: ignore[attr-defined]
    return dev_path


_ASSETS = Path(__file__).parent / "assets"
_FONT = _asset("assets_fonts/SmileySans-Oblique.ttf", _REPO_ROOT / "server" / "assets" / "fonts" / "SmileySans-Oblique.ttf")
_RENDER_JS = _asset("video_edit_assets/render_frames.js", _ASSETS / "render_frames.js")
_TEMPLATE_HTML = _asset("video_edit_assets/template.html", _ASSETS / "template.html")


def _electron_bin() -> str | None:
    """本 app 自带的 electron 二进制(装机包里也有,复用它的 Chromium)。env ELECTRON_BIN 可覆盖。"""
    env = os.environ.get("ELECTRON_BIN")
    if env and Path(env).exists():
        return env
    edir = _REPO_ROOT / "desktop" / "node_modules" / "electron"
    ptxt = edir / "path.txt"
    if ptxt.exists():
        b = edir / "dist" / ptxt.read_text().strip()
        if b.exists():
            return str(b)
    return None


def _render_html_frames(manifest_path: Path, out_frames: Path) -> None:
    """逐帧渲染 template.html → PNG/JPEG 帧。优先 Electron 离屏(打包安全·复用自带 Chromium),
    失败/无 electron 回退 node+Playwright(dev)。"""
    # electron 二进制:app 注入的 ELECTRON_BIN(= app 自身,dev/装机包通用) > 项目内置 node_modules electron。
    eb = os.environ.get("ELECTRON_BIN") or _electron_bin()
    # 要传给 electron 的脚本:QF_RENDER_MAIN 由 app 注入(dev=main.js;装机包="" 表示用 baked main 不传参);
    # 直连脚本测试(无 app 父进程)时该 env 缺失 → 用仓库 main.js。
    main_arg = os.environ.get("QF_RENDER_MAIN")
    if main_arg is None:
        default_main = _REPO_ROOT / "desktop" / "src" / "main.js"
        args = [str(default_main)] if default_main.exists() else None
    else:
        args = [] if main_arg == "" else [main_arg]
    if eb and args is not None:
        env = {**os.environ, "QF_RENDER_MANIFEST": str(manifest_path), "QF_RENDER_OUT": str(out_frames),
               "ELECTRON_DISABLE_SECURITY_WARNINGS": "1"}
        try:
            r = subprocess.run([eb, *args], env=env, capture_output=True, text=True, timeout=1200)
            if r.returncode == 0 and any(out_frames.glob("*.jpg")):
                return
            logger.warning("Electron 离屏渲染没出帧,回退 Playwright。stderr尾:%s", (r.stderr or "")[-400:])
        except Exception as e:  # noqa: BLE001
            logger.warning("Electron 渲染异常,回退 Playwright:%s", e)
    subprocess.run(["node", str(_RENDER_JS), str(manifest_path), str(out_frames)], check=True, timeout=1200)


def _extract_shot_frames(src: str, start: float, dur: float, tw: int, th: int, grade: str, out_dir: Path, fps: int) -> int:
    """抽一段的逐帧 PNG(scale-cover 到 tw×th + HDR tonemap + 调色)。返回实际帧数。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    for f in out_dir.glob("*.png"):
        f.unlink()
    vf_parts: list[str] = []
    if probe_video(src)["is_hdr"]:
        vf_parts.append(_TONEMAP)
    vf_parts.append(f"scale={tw}:{th}:force_original_aspect_ratio=increase")
    vf_parts.append(f"crop={tw}:{th}")
    g = _grade_filter(grade)
    if g:
        vf_parts.append(g)
    vf_parts.append(f"fps={fps}")
    subprocess.run(
        [ffmpeg_bin(), "-y", "-loglevel", "error", "-ss", f"{start:.3f}", "-i", src,
         "-t", f"{dur:.3f}", "-vf", ",".join(vf_parts), "-c:v", "png", str(out_dir / "f_%04d.png")],
        check=True,
    )
    return len(list(out_dir.glob("*.png")))


def _mux_bgm_and_loudnorm(base: Path, bgm_path: str, out_path: str, *, work: Path) -> str:
    """把编码好的画面轨(base,无声)跟程序化 BGM 封装到一起 + 响度归一。

    E4④升级:原来是"映射+loudnorm 一步到位"的单遍近似;现拆成两步——先无损混流出 premix,
    再对 premix 的音频跑两遍法(mix.loudnorm_two_pass:第一遍测真实积分响度,第二遍按测量值
    精确校正),TP 目标也从 -1 收紧到 -1.5(见 mix.TARGET_TP),比单遍近似准。
    """
    premix = work / "v2_premix.mp4"
    subprocess.run(
        [ffmpeg_bin(), "-y", "-loglevel", "error", "-i", str(base), "-i", bgm_path,
         "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-shortest", "-movflags", "+faststart", str(premix)],
        check=True,
    )
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    mix.loudnorm_two_pass(premix, out, target_i=mix.TARGET_I, target_tp=mix.TARGET_TP, copy_video=True)
    premix.unlink(missing_ok=True)
    return str(out)


def render_v2(
    doc,
    out_path: str,
    *,
    edit_dir: str,
    brand: str,
    captions: list[str],
    fps: int = 30,
    grade: str = "warm_cinematic",
    reuse_frames: bool = False,
    music_mood: str = "auto",
    music_key: int = 0,
    styles: list | None = None,
    theme: dict | None = None,
    custom_css: str = "",
) -> str:
    """时间轴文档 → V2 包装成片 mp4。captions 与 doc.video_clips_ordered() 等长(缺则空文案)。

    reuse_frames=True:段帧已抽过(如"对话改文案"重渲)则跳过抽帧,只重渲文案层 → 秒级。
    """
    work = Path(edit_dir)
    frames_root = work / "v2frames"
    frames_root.mkdir(parents=True, exist_ok=True)
    tw, th = int(doc.width), int(doc.height)
    out_frames = work / "v2_out"
    base = work / "v2_base.mp4"

    try:
        # ── ① 逐段抽帧 + 建镜头清单 ──
        clips = doc.video_clips_ordered()
        if not clips:
            raise RuntimeError("时间轴里没有视频段,没法渲染。")
        shots: list[dict] = []
        gf = 0
        for i, (_cid, c) in enumerate(clips):
            src = doc.media[c.media].src
            dur = max(0.1, (c.src_out or 0) - (c.src_in or 0))
            sdir = frames_root / f"s{i:02d}"
            cached = len(list(sdir.glob("*.png"))) if sdir.exists() else 0
            if reuse_frames and cached > 0:
                nfr = cached   # 改文案重渲:复用已抽的帧,不重抽
            else:
                nfr = _extract_shot_frames(src, c.src_in or 0, dur, tw, th, grade, sdir, fps)
            if nfr <= 0:
                continue
            cap = captions[i] if i < len(captions) else ""
            st = styles[i] if styles and i < len(styles) and styles[i] else None
            shots.append({"dir": str(sdir), "nFrames": nfr, "startFrame": gf, "endFrame": gf + nfr,
                          "caption": cap, "style": st})
            gf += nfr
        if not shots:
            raise RuntimeError("抽帧失败,没有可渲染的镜头。")
        total = gf

        manifest = {
            "width": tw, "height": th, "fps": fps, "totalFrames": total,
            # 卡点脉冲要跟着这条片子实际的音乐情绪走(chill 慢/hype 快),别用固定拍长——
            # 否则视觉脉冲和 bgm.py 真实合成的鼓点对不上(卡点错拍)。
            "beatFrames": max(1, round(fps * beat_for_mood(music_mood))), "font": str(_FONT), "brand": brand,
            "tag": brand, "template": str(_TEMPLATE_HTML), "shots": shots,  # tag=角标水印(默认=品牌词;传 "" 可隐藏)
            "theme": theme or {"accent": "#12E0C8"}, "customCss": custom_css or "",
        }
        manifest_path = work / "v2_manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False))

        # ── ② 逐帧渲染(Electron 离屏优先,回退 Playwright)──
        logger.info("V2 渲染:%d 帧 (%.1fs)", total, total / fps)
        _render_html_frames(manifest_path, out_frames)

        # ── ③ 编码 + BGM + 响度 ──
        subprocess.run(
            [ffmpeg_bin(), "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(out_frames / "f_%05d.jpg"),
             "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", str(base)],
            check=True,
        )
        bgm = synth_beat_bgm(total / fps, str(work / "v2_bgm.wav"), mood=music_mood, key=music_key)
        return _mux_bgm_and_loudnorm(base, bgm, out_path, work=work)
    finally:
        # 中间帧/临时物清理(逐帧 PNG/JPG 很占地方,内存紧张机器必清;成片已出)。
        # 挪进 finally:哪怕半路抛异常(抽帧/渲染/编码失败),已生成的部分帧也要清掉,不留占地方的垃圾;
        # 清单只含 frames_root/out_frames/base/v2_premix 这几个"过程中间物"(v2_premix 正常路径下
        # _mux_bgm_and_loudnorm 已经自己删了,这里是异常路径的兜底),v2_plan.json/manifest/最终
        # 成片 out 都不在这份清单里,不会被误删。
        for junk in (frames_root, out_frames, base, work / "v2_premix.mp4"):
            try:
                shutil.rmtree(junk) if junk.is_dir() else junk.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass
