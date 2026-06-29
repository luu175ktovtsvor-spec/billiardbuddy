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
from services import media_jobs_runner, poster_service
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
