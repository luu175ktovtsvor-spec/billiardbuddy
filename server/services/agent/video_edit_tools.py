"""视频剪辑 Agent 工具(薄适配层)—— 把 video_edit 核心包成 AI 能调的工具。

架构(三段式):AI 不直接出片,只对【时间轴文档(唯一真相源)】发原子操作;渲染器消费文档出片。
  inventory_footage  理解素材(转写+切镜头)→ 候选菜单 + 草稿文档     (只读,不弹审批)
  edit_timeline      对文档发原子操作(挑段/排布/字幕/配乐)→ 校验+回滚 (改文档,不出片)
  auto_caption       把口播自动变成字幕片段                          (改文档)
  render_video       文档 → 成片 mp4(给老板看的成品)                (deliverable,不弹安全审批)

时间轴文档持久化在 UPLOAD_DIR/edits/<project>/timeline.json —— 这就是"真相源"落盘,跨工具调用读写它。
"""
from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path

from services.video_edit.projects import doc_path as _doc_path
from services.video_edit.projects import load_doc as _load_doc
from services.video_edit.projects import project_dir as _project_dir
from services.video_edit.projects import save_doc as _save_doc

from .registry import Tool, default_registry

logger = logging.getLogger(__name__)


def _summarize(doc) -> str:
    """给模型读的紧凑文档摘要(别整份回灌 token)。"""
    vids = doc.video_clips_ordered()
    caps = doc.caption_clips()
    parts = [f"时长≈{doc.duration():.1f}s · {doc.width}x{doc.height}"]
    if vids:
        parts.append("视频段: " + " ".join(
            f"{cid}[源{c.src_in:.1f}-{c.src_out:.1f}]" for cid, c in vids))
    else:
        parts.append("视频段: (空,还没挑片)")
    if caps:
        parts.append("字幕: " + " ".join(f"{cid}「{(c.text or '')[:8]}」@{c.start:.1f}" for cid, c in caps))
    parts.append(f"配乐: {'有' if doc.music else '无'} · 调色: {doc.grade or '无'}")
    return " | ".join(parts)


# ────────────────────────────── 工具 handler ──────────────────────────────

async def inventory_footage(args: dict, ctx) -> str:
    """理解本地视频素材:转写口播 + 切镜头,产出候选菜单 + 草稿文档。只读。"""
    from services.video_edit.assemble import inventory_footage as _inv

    raw = args.get("video_paths") or []
    if isinstance(raw, str):
        raw = [raw]
    paths = [str(p) for p in raw if str(p).strip()]
    if not paths:
        return "没给视频:请把要剪的本地视频路径(一个或多个)放进 video_paths。"
    for p in paths:
        if not Path(p).is_file():
            return f"找不到视频文件:{p}(确认是老板本机的真实路径)。"

    project = Path(str(args.get("project") or "")).name or uuid.uuid4().hex[:10]
    edit_dir = str(_project_dir(project))
    try:
        res = _inv(paths, edit_dir)
    except Exception as e:  # noqa: BLE001
        logger.exception("inventory_footage 失败")
        return f"理解素材时出错:{e}"

    # 把草稿文档(已登记 media/轨道)落盘成真相源
    from services.video_edit.timeline import TimelineDoc
    _save_doc(project, TimelineDoc.model_validate(res["doc"]))

    speech = "有口播(可按说的话挑段)" if res["has_speech"] else "无口播/空镜(按镜头切点和节奏挑段)"
    return (
        f"已看完素材(项目号 {project},{speech})。下面是可选片段,用 edit_timeline 发 add_clip "
        f"按时间戳挑段建片(轨道用 'v'),配字幕用 add_caption(轨道 'sub')或调 auto_caption。\n\n"
        f"{res['packed']}\n\n【项目号】{project}"
    )


async def edit_timeline(args: dict, ctx) -> str:
    """对时间轴文档发原子操作(挑段/裁剪/排序/字幕/配乐)。校验不过则整批回滚。"""
    from services.video_edit.operations import apply_operations

    project = Path(str(args.get("project") or "")).name
    doc = _load_doc(project)
    if doc is None:
        return "没找到这个项目的时间轴(先 inventory_footage 看素材拿项目号)。"
    ops = args.get("operations") or []
    if isinstance(ops, dict):
        ops = [ops]
    if not ops:
        return f"没给操作。当前时间轴:{_summarize(doc)}"

    new_doc, errs = apply_operations(doc, ops)
    if errs:
        return "这批改动没生效(已回滚,文档没动)。问题:\n- " + "\n- ".join(errs) + \
               f"\n\n当前时间轴:{_summarize(doc)}"
    _save_doc(project, new_doc)
    return f"改好了 ✅ 当前时间轴:{_summarize(new_doc)}"


async def auto_caption(args: dict, ctx) -> str:
    """把已选片段里的口播,自动变成跟成片对齐的字幕片段。"""
    from services.video_edit.assemble import auto_captions_from_speech
    from services.video_edit.operations import apply_operations

    project = Path(str(args.get("project") or "")).name
    doc = _load_doc(project)
    if doc is None:
        return "没找到这个项目的时间轴(先 inventory_footage)。"
    if not doc.video_clips_ordered():
        return "还没挑视频片段,先用 edit_timeline 加片段再配字幕。"

    edit_dir = str(_project_dir(project))
    cap_ops = auto_captions_from_speech(doc, edit_dir, track=args.get("track") or "sub")
    if not cap_ops:
        return "这些片段里没识别到口播,自动字幕没东西可加(可手动 add_caption 加促销文案)。"
    new_doc, errs = apply_operations(doc, cap_ops)
    if errs:
        return "自动字幕没加成:\n- " + "\n- ".join(errs)
    _save_doc(project, new_doc)
    return f"已按口播配好 {len(cap_ops)} 条字幕 ✅ 当前时间轴:{_summarize(new_doc)}"


async def render_video(args: dict, ctx) -> str:
    """把时间轴文档渲染成成片 mp4(给老板看的成品)。"""
    from services.video_edit.assemble import render_timeline

    project = Path(str(args.get("project") or "")).name
    doc = _load_doc(project)
    if doc is None:
        return "没找到这个项目的时间轴(先 inventory_footage 再 edit_timeline 挑片)。"
    if not doc.video_clips_ordered():
        return "时间轴里还没有视频片段,没法出片。先 edit_timeline 用 add_clip 挑几段。"
    errs = doc.validate_doc()
    if errs:
        return "时间轴有问题、先修:\n- " + "\n- ".join(errs)

    name = Path(str(args.get("output_name") or "成片")).name
    if not name.endswith(".mp4"):
        name += ".mp4"
    out = _project_dir(project) / name
    try:
        render_timeline(doc, str(out), edit_dir=str(_project_dir(project)))
    except Exception as e:  # noqa: BLE001
        logger.exception("render_video 失败")
        return f"出片时出错:{e}"

    url = f"/uploads/edits/{project}/{name}"
    return f"成片做好啦!👇(时长≈{doc.duration():.1f}秒)\n\n[点击查看视频]({url})"


# ────────────────────────────── 工具定义 + 注册 ──────────────────────────────

_OP_HELP = (
    "operations 是一串原子操作(按顺序施加,任一步非法则整批回滚):\n"
    "  add_clip {track:'v', media:'m1', src_in:2.0, src_out:5.0} —— 挑源素材的一段进视频轨\n"
    "  trim_clip {id:'c1', src_in?, src_out?} —— 改某段的截取区间\n"
    "  reorder_clip {id:'c1', order:0} —— 调片段顺序\n"
    "  remove_clip {id:'c1'} —— 删一段\n"
    "  add_caption {track:'sub', text:'新到乔氏台子', start:0.0, end:3.0, style?} —— 加字幕(start/end 是成片时间轴秒)\n"
    "  edit_caption {id:'s1', text?, start?, end?} —— 改字幕\n"
    "  set_music {media:'bgm'} / set_grade {grade:'warm_cinematic'} —— 配乐/调色\n"
    "  add_media {src:'/abs/bgm.mp3', duration:60, kind:'audio'} —— 登记新媒体(如背景乐)"
)

_VIDEO_EDIT_TOOLS = [
    Tool(
        name="inventory_footage",
        description="【理解本地视频素材】剪片第一步:对老板本机的视频转写口播+切镜头,返回'可选片段菜单'和项目号。"
                    "老板说『把这几段视频剪成XX / 帮我剪个探店视频 / 这段录像剪短点发抖音』时先调它看素材。只读、不出片。",
        parameters={"type": "object", "properties": {
            "video_paths": {"type": "array", "items": {"type": "string"},
                            "description": "要剪的本地视频文件路径(一个或多个,老板本机真实路径)"},
            "project": {"type": "string", "description": "项目号(可选,接着改某个已有项目时传;不传=新建)"},
        }, "required": ["video_paths"]},
        handler=inventory_footage,
        read_only=True,
        # F-7 复审：不标 concurrent_safe——虽不碰 ctx.db，但会落盘写自己的项目 timeline.json、且是
        # CPU 重活（转写+切镜头），出于 fail-safe 保守不纳入并发组（并发收益也不是这类慢重活的目标场景）。
    ),
    Tool(
        name="edit_timeline",
        description="【改时间轴】对剪辑项目发原子操作来挑段/排布/裁剪/配字幕/配乐——这是真正在'剪'。"
                    "先 inventory_footage 拿项目号和可选片段,再用本工具按时间戳 add_clip 把片段排进视频轨、"
                    "add_caption 配促销字幕。改完会校验,非法则自动回滚不会改坏。\n" + _OP_HELP,
        parameters={"type": "object", "properties": {
            "project": {"type": "string", "description": "项目号(inventory_footage 返回的)"},
            "operations": {"type": "array", "items": {"type": "object"},
                           "description": "原子操作列表,见说明"},
        }, "required": ["project", "operations"]},
        handler=edit_timeline,
    ),
    Tool(
        name="auto_caption",
        description="【自动配字幕】把已挑视频片段里的口播,自动识别成跟成片对齐的字幕。"
                    "老板要『加字幕/配字幕』且片子有人说话时用。无口播的空镜不用调它(改用 add_caption 手写促销文案)。",
        parameters={"type": "object", "properties": {
            "project": {"type": "string", "description": "项目号"},
            "track": {"type": "string", "description": "字幕轨 id(默认 'sub')"},
        }, "required": ["project"]},
        handler=auto_caption,
    ),
    Tool(
        name="render_video",
        description="【出片】把时间轴渲染成最终竖屏成片 mp4 给老板看。挑好片段、配好字幕后调它。"
                    "出的是给老板看的成品(不是对外发布),直接出、会返回视频链接。出片前最好先把方案讲给老板、他点头再出。",
        parameters={"type": "object", "properties": {
            "project": {"type": "string", "description": "项目号"},
            "output_name": {"type": "string", "description": "成片文件名(可选,默认'成片')"},
        }, "required": ["project"]},
        handler=render_video,
        deliverable=True,          # 给老板看的成品(前端渲染成可播视频)
        requires_approval=False,   # 出成品不弹安全审批(铁律:做成品给老板看≠对外动作)
        timeout=1800,              # 渲染可能几分钟,给足超时
    ),
]


def register_video_edit_tools(registry=None) -> int:
    """注册视频剪辑工具(通用能力,通用模式即可用;仅桌面本地模式调用)。幂等。"""
    reg = registry or default_registry
    for t in _VIDEO_EDIT_TOOLS:
        if reg.get(t.name) is None:
            reg.register(t)
    return len(_VIDEO_EDIT_TOOLS)


if os.environ.get("DESKTOP_LOCAL") == "1":
    register_video_edit_tools()
    logger.info("已注册 %d 个视频剪辑工具(桌面全本地模式)", len(_VIDEO_EDIT_TOOLS))
