"""场景方案 manifest → 落盘（图片版 / 网页版）。

图片版：复用 `services.video_edit.template_render._render_html_frames`（totalFrames=1，
        走 app 自带 Electron 离屏渲染同款子进程——render-worker.js 不用改一个字）。
网页版：把 manifest 数据内联进 template.html 副本，存成可直接浏览器打开的静态页——
        不用截图/不拉子进程，比图片版更简单（template.html 自身的 window.init/renderFrame
        跟离屏渲染路径共用同一套代码，静态页只是换一种"谁来调用它"的方式）。
"""
from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from services.video_edit.template_render import _asset, _render_html_frames

_ASSETS = Path(__file__).parent / "assets"
# 装机包(PyInstaller frozen)从 sys._MEIPASS/scene_plan_assets 取；dev 用仓库内 assets/ 目录。
# 对应打包接线：desktop/scripts/build_backend.js 的 --add-data（照抄视频 template 的落点）。
TEMPLATE_HTML = _asset("scene_plan_assets/template.html", _ASSETS / "template.html")


def render_image(manifest: dict, out_path: str) -> str:
    """图片版：manifest(totalFrames=1) 走离屏渲染子进程出一帧 jpg，拷到 out_path。"""
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="qf_scene_plan_") as tmp:
        work = Path(tmp)
        manifest_path = work / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        out_frames = work / "frames"
        _render_html_frames(manifest_path, out_frames)
        frame = out_frames / "f_00000.jpg"
        if not frame.exists():
            raise RuntimeError("场景方案图片版没渲出帧（f_00000.jpg 不存在）")
        shutil.copy(frame, out)
    return str(out)


def render_html(manifest: dict, out_path: str) -> str:
    """网页版：读 manifest['template'] 指向的 template.html，追加一段自举 <script>
    （写入 manifest 数据 + 调 window.init/renderFrame(0)），存成独立静态页。"""
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    html = Path(manifest["template"]).read_text(encoding="utf-8")
    # 防御性转义：万一方案文本里恰好出现字面 "</script>"，别提前截断 script 标签。
    manifest_json = json.dumps(manifest, ensure_ascii=False).replace("</script>", "<\\/script>")
    bootstrap = f"\n<script>\nwindow.init({manifest_json});\nwindow.renderFrame(0);\n</script>\n"
    out.write_text(html + bootstrap, encoding="utf-8")
    return str(out)
