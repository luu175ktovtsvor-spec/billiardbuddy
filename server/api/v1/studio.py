"""生成工作室直连接口(/studio):绕开 ReAct 对话循环、点按即出活。复用 poster_service + media_jobs。

每个生成入口出图【之前】:
  ① check_generation_safety 红线预检(H1,堵"直连绕过 LLM 就没人守红线"的后门)
  ② count clamp ≤4(H3,变体张数护栏,防变体+反复改烧 paid API);DB 海报额度由 generate_images
     内部 check_poster_quota 管。
出图是长任务(gpt-image-2 单张 5-10 分)→ 一律走 media_jobs 异步:提交即返 job_id,前端轮询
GET /agent/media-jobs/{id} 看进度/结果。不假装秒回(H2)。
"""
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from api.deps import get_current_user, get_current_store, get_db
from core.exceptions import AIServiceError
from core.safety import check_generation_safety
from db.session import async_session
from models.store import Store
from models.user import User
from services import media_jobs_runner, poster_service, video_service
from services.agent.poster_styles import resolve_style_prompt

router = APIRouter()

_MAX_VARIANTS = 4  # H3:每次最多 4 张(和 ReAct 工具层 ≤4 一致)


class StudioGenerateIn(BaseModel):
    prompt: str
    ratio: str = "3:4"
    style: str | None = None
    count: int = 1
    reference_image_paths: list[str] | None = None
    conversation_id: str | None = None
    quality: str = "medium"


class StudioEditIn(BaseModel):
    source_generation_id: str         # 要改的成品 id(= refine_from 底图,也是血缘父)。底图从该成品解析。
    prompt: str                       # 改图指令(一句话说怎么改)
    mask_path: str | None = None      # 局部重绘:同尺寸 alpha mask 的本机路径(透明处=要改);无=整图改
    ratio: str = "3:4"
    count: int = 1                    # 出几版(变体)
    conversation_id: str | None = None
    quality: str = "medium"


class StudioI2vIn(BaseModel):
    first_frame: str                  # 首帧图(/uploads/...):把这张图动起来
    prompt: str = ""                  # 运镜/画面描述(可空=让它自然动)
    source_generation_id: str | None = None  # 血缘父(由哪张图做的视频)
    ratio: str = "9:16"               # 视频默认竖屏(发社媒)
    duration: int = 5                 # 时长(秒,4-15)
    generate_audio: bool = False      # 音画同生
    image_refs: list[str] | None = None  # 多图参考(锁人物·助教多生活照,/uploads 内)
    last_frame: str | None = None     # 尾帧承接
    conversation_id: str | None = None


class StudioComposeIn(BaseModel):
    generation_ids: list[str]         # 要拼成一条的视频成品(按顺序)


def _clamp_count(n) -> int:
    try:
        n = int(n or 1)
    except (TypeError, ValueError):
        n = 1
    return max(1, min(n, _MAX_VARIANTS))


def _compose_prompt(prompt: str, style: str | None) -> str:
    frag = resolve_style_prompt(style) if style else None
    return f"{prompt}。整体风格：{frag}" if frag else prompt


def _result_payload(res) -> dict:
    imgs = res.get("images", []) if isinstance(res, dict) else []
    return {
        "urls": [i.get("poster_url") for i in imgs if i.get("poster_url")],
        "generation_ids": [str(i.get("generation_id")) for i in imgs if i.get("generation_id")],
        "ratio": imgs[0].get("ratio") if imgs else None,
    }


async def _backfill_parent(wdb, images, parent_id, store_id) -> None:
    """给新出的成品回填 parent_generation_id(血缘:图→改图可追溯)。"""
    if not parent_id:
        return
    try:
        parent_uuid = uuid.UUID(str(parent_id))
    except (ValueError, TypeError):
        return
    gen_ids = [i.get("generation_id") for i in (images or []) if i.get("generation_id")]
    if not gen_ids:
        return
    from sqlalchemy import update as _upd
    from models.generation import Generation as _G
    await wdb.execute(
        _upd(_G).where(_G.id.in_(gen_ids), _G.store_id == store_id).values(parent_generation_id=parent_uuid)
    )
    await wdb.commit()


@router.post("/generate")
async def studio_generate(
    body: StudioGenerateIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """文生图(可带风格/参考图/变体张数)。异步:返回 {job_id},前端轮询 media-jobs/{id}。"""
    check_generation_safety(body.prompt, body.style or "")   # H1
    count = _clamp_count(body.count)                          # H3
    prompt = _compose_prompt(body.prompt, body.style)
    store_id, user_id, conv = store.id, user.id, body.conversation_id
    ratio, refs, quality = body.ratio, body.reference_image_paths, body.quality

    async def work_fn(progress):
        from core.tenant import set_tenant
        set_tenant(store_id)  # 后台任务自己带租户上下文(generations/usage_quotas 靠它过滤)
        try:
            await progress(8, "正在出图…")
            async with async_session() as wdb:
                st = await wdb.get(Store, store_id)
                res = await poster_service.generate_images(
                    wdb, st, user_id, prompt, image_model=None, ratio=ratio,
                    reference_image_paths=refs, count=count, conversation_id=conv, quality=quality,
                )
            return _result_payload(res)
        finally:
            set_tenant(None)

    job_id = await media_jobs_runner.submit(
        store_id, "generate", work_fn,
        params={"prompt": body.prompt, "ratio": ratio, "count": count}, conversation_id=conv,
    )
    return {"job_id": job_id}


@router.post("/edit")
async def studio_edit(
    body: StudioEditIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """基于这张改:原成品当底图 + 一句话指令 →（可选 mask 局部重绘）改出新图(治"改不动图、只能跳回输入框")。
    底图由 source_generation_id 解析(refine_from=成品 id,不是 URL)。异步:返回 {job_id}。"""
    if not (body.source_generation_id or "").strip():
        raise AIServiceError("没指定要改的成品")
    check_generation_safety(body.prompt)                     # H1
    count = _clamp_count(body.count)                          # H3
    store_id, user_id, conv = store.id, user.id, body.conversation_id
    prompt, src, ratio, quality, mask = body.prompt, body.source_generation_id, body.ratio, body.quality, body.mask_path

    async def work_fn(progress):
        from core.tenant import set_tenant
        set_tenant(store_id)
        try:
            await progress(8, "正在按你圈的地方改…" if mask else "正在按你说的改…")
            async with async_session() as wdb:
                st = await wdb.get(Store, store_id)
                res = await poster_service.generate_images(
                    wdb, st, user_id, prompt, image_model=None, ratio=ratio,
                    refine_from=src, mask_path=mask, count=count, conversation_id=conv, quality=quality,
                )
                # 血缘父 = 被改的源成品
                await _backfill_parent(wdb, res.get("images", []), src, store_id)
            return _result_payload(res)
        finally:
            set_tenant(None)

    job_id = await media_jobs_runner.submit(
        store_id, "edit", work_fn,
        params={"prompt": body.prompt, "source": src, "count": count, "mask": bool(mask)}, conversation_id=conv,
    )
    return {"job_id": job_id}


@router.post("/i2v")
async def studio_i2v(
    body: StudioI2vIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """图生视频:把一张成品图动起来(可配音 / 多图锁人物 / 首尾帧)。异步:返回 {job_id}。
    视频慢(几分钟)且费——前端在用户【显式点「做成视频」】时才调它,那一下就是人确认(不另弹审批闸)。"""
    if not (body.first_frame or "").strip():
        raise AIServiceError("没给要动起来的图")
    check_generation_safety(body.prompt or "")               # H1:prompt 文本红线(图本身已过生图红线)
    store_id, user_id, conv = store.id, user.id, body.conversation_id
    ff, prompt, ratio, dur = body.first_frame, body.prompt, body.ratio, int(body.duration or 5)
    audio, refs, lf, parent = body.generate_audio, body.image_refs, body.last_frame, body.source_generation_id

    async def work_fn(progress):
        from core.tenant import set_tenant
        set_tenant(store_id)
        try:
            await progress(5, "正在让画面动起来…(视频要等几分钟)")
            async with async_session() as wdb:
                st = await wdb.get(Store, store_id)
                res = await video_service.generate_video(
                    db=wdb, store=st, user_id=user_id,
                    prompt=prompt or "让画面自然地动起来，运镜流畅、主体不变形",
                    ratio=ratio, duration=dur, first_frame=ff, last_frame=lf,
                    image_refs=refs, generate_audio=audio, parent_generation_id=parent,
                    conversation_id=conv,
                )
            return {"urls": [res["video_url"]], "generation_ids": [str(res["generation_id"])],
                    "ratio": ratio, "is_video": True}
        finally:
            set_tenant(None)

    job_id = await media_jobs_runner.submit(
        store_id, "i2v", work_fn,
        params={"first_frame": ff, "duration": dur, "audio": audio, "refs": len(refs or [])},
        conversation_id=conv,
    )
    return {"job_id": job_id}


@router.post("/compose")
async def studio_compose(
    body: StudioComposeIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """多镜合成准备:把多段视频成品按顺序解析成本机路径,交给前端用 Electron ffmpeg(video.js)concat。
    ffmpeg 在 Electron 主进程跑(后端拿不到它),所以这里只做【路径解析+越界校验】,真拼由前端 IPC 调 video.js。
    本店作用域:只认本店 type=video 且文件在 uploads/videos 内的成品(挡跨店/越界)。返回 {inputs(有序), output_path, output_url}。"""
    import uuid as _uuid
    from pathlib import Path as _Path
    from sqlalchemy import select as _sel
    from config import settings as _settings
    from models.generation import Generation as _G

    raw = [g for g in (body.generation_ids or []) if g]
    if len(raw) < 2:
        raise AIServiceError("至少选两段视频才能拼")
    parsed: list = []
    for gid in raw:
        try:
            parsed.append(_uuid.UUID(str(gid)))
        except (ValueError, TypeError):
            raise AIServiceError("视频 id 不对")
    res = await db.execute(
        _sel(_G).where(_G.id.in_(parsed), _G.store_id == store.id,
                       _G.type == "video", _G.is_deleted == False)  # noqa: E712
    )
    gens = {g.id: g for g in res.scalars().all()}
    udir = _Path(_settings.upload_dir).resolve()
    inputs: list[str] = []
    for u in parsed:  # 保持用户给的顺序(concat 顺序=拼接顺序)
        g = gens.get(u)
        if not g or not g.result:
            raise AIServiceError("有视频找不到（可能已删，或不是本店的）")
        p = (udir / str(g.result).removeprefix("/uploads/")).resolve()
        in_uploads = str(p) == str(udir) or str(p).startswith(str(udir) + "/")
        if not in_uploads or not p.exists():
            raise AIServiceError("视频文件不在本应用目录内")
        inputs.append(str(p))
    out_name = f"composed_{_uuid.uuid4().hex[:8]}.mp4"
    return {
        "inputs": inputs,
        "output_path": str(udir / "videos" / out_name),
        "output_url": f"/uploads/videos/{out_name}",
    }
