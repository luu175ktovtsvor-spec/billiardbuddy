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
    # E2-4・"要同款":拿一张已出的成品当参考、重新生成一批相似的(不是改这一张)。前端传
    # current.generationId 进来,这里解析成本机图片路径并入 reference_image_paths 一起喂给
    # generate_images(⚠️多租户:只认本店成品,别店/不存在/文件不在 → 跳过不崩，见 _resolve_reference_generation_paths)。
    reference_generation_ids: list[str] | None = None
    image_model: str | None = None    # 选的生图模型(gpt-image-2 / doubao-seedream-4-5-251128…);None=门店/内置默认
    image_prompt: str | None = None   # 优化后的提示词(前端可改后回传);有则当真实 prompt 送模型,无则用 prompt 原文
    conversation_id: str | None = None
    quality: str = "medium"
    # U1・硬要素结构化收集(可选、向后兼容):店名/日期/价格/联系方式等要一字不差出现的硬文字。
    # 未传(现状绝大多数调用)＝完全不影响原行为；传了会在 generate_images 里做扩写后校验兜底。
    poster_text: dict | None = None
    # U5(E3d)・owner §3-4 窄例外:印刷/线下投放场景才传 True(默认 False=现状不变,二维码原图交模型融合)。
    # 前端勾选入口不在本单(E2)——这里先开好后端参数口子。
    print_mode: bool = False


class StudioExpandIn(BaseModel):
    prompt: str                       # 用户的大白话需求
    # U1(同上)：有则连同大白话一起扩写、扩写后校验硬要素不丢；没有则行为与改动前一致。
    poster_text: dict | None = None


class StudioEditIn(BaseModel):
    source_generation_id: str         # 要改的成品 id(= refine_from 底图,也是血缘父)。底图从该成品解析。
    prompt: str                       # 改图指令(一句话说怎么改)
    mask_path: str | None = None      # 局部重绘:同尺寸 alpha mask 的本机路径(透明处=要改);无=整图改
    ratio: str = "3:4"
    count: int = 1                    # 出几版(变体)
    image_model: str | None = None    # 跟随前端选的模型(改图也用同一个);火山 Seedream 不支持 mask,局部重绘前端已禁用
    conversation_id: str | None = None
    quality: str = "medium"
    # U5(E3d)・改图侧独立路由:"text_fix"(改文字/字错)→ Seedream;"content"(改内容)→ GPT edits(高保真)。
    # 不传则从 prompt 文本推断；image_model 显式手选时优先于这个判据(向后兼容)。
    edit_type: str | None = None
    # U5・owner §3-4 窄例外:印刷/线下投放场景才传 True(默认 False=现状不变)。前端勾选入口不在本单(E2)。
    print_mode: bool = False


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


class StudioStoryboardIn(BaseModel):
    theme: str                        # 短片主题(如"咖啡馆日常·清新 vibe")
    shots: int = 3                    # 几个分镜(2-6)
    subject: str = ""                 # 主体/人物描述(如"年轻女生,台球助教"),锁人物用


def _storyboard_prompt(theme: str, n: int, subject: str) -> str:
    subj = f"主体/人物:{subject}(每个分镜都要是同一个人,长相/体态不变)。" if subject else ""
    return (
        f"你是短视频分镜师。主题:{theme}。{subj}"
        f"请写 {n} 个分镜,每个是一句给 AI 视频模型的【画面 + 运镜】描述(具体、可拍、几秒一镜),"
        "再写一条适合发抖音/小红书/朋友圈的配文案(口语、有钩子)。"
        "守安全红线:不露骨色情、不涉及实际性交易、未成年保护、不开赌场/不带赌博。"
        '只输出 JSON,格式:{"shots": ["分镜1","分镜2"], "caption": "配文案"}。不要任何额外说明。'
    )


def _parse_storyboard(text: str, n: int) -> tuple[list[str], str]:
    import json as _json
    import re as _re
    shots: list[str] = []
    caption = ""
    m = _re.search(r"\{.*\}", text or "", _re.S)
    if m:
        try:
            j = _json.loads(m.group(0))
            raw = j.get("shots") or j.get("分镜") or []
            shots = [str(s).strip() for s in raw if str(s).strip()][:n]
            caption = str(j.get("caption") or j.get("文案") or "").strip()
        except Exception:
            pass
    if not shots:  # 兜底:按行/序号切
        lines = [ln.strip(" -·。.0123456789、)）:：") for ln in (text or "").splitlines()]
        shots = [ln for ln in lines if len(ln) > 4][:n]
    if not shots:
        raise AIServiceError("没生成出分镜,换个主题再试。")
    return shots[:n], caption


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
    # E2-4・收 U5 遗留:poster_service 已在每张图的 outcome 里放了 text_quality_warning(OCR 重出后仍
    # 没对上、best-effort 放行的软警告)，但这里此前没透传出去、前端收不到。整批"有一张就标"
    # (选简单方案，不做 per-image 精细展示)：这批里只要有一张触发了，就把警告 + 大白话提示带给前端。
    warned = [i for i in imgs if i.get("text_quality_warning")]
    return {
        "urls": [i.get("poster_url") for i in imgs if i.get("poster_url")],
        "generation_ids": [str(i.get("generation_id")) for i in imgs if i.get("generation_id")],
        "ratio": imgs[0].get("ratio") if imgs else None,
        # U1・"缺就问"信号(不阻断生成)：调用方声明要用但没填值的硬要素，交给前端做缺项提示。
        "missing_elements": (res.get("missing_elements") or []) if isinstance(res, dict) else [],
        # U2・降级安全网标记(与 urls 同下标对齐)：这张是否 GPT 失败后自动切到了 Seedream 重试——
        # 前端可据此提示"这张用了备用模型"（本单只落数据契约，UI 展示留给下一批处理模型选择器的任务接手）。
        "model_switched": [bool(i.get("model_switched")) for i in imgs if i.get("poster_url")],
        "text_quality_warning": bool(warned),
        "text_quality_warning_message": (warned[0].get("text_quality_warning_message") if warned else None),
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


async def _resolve_reference_generation_paths(wdb, generation_ids, store_id) -> list[str]:
    """E2-4・"要同款":成品 id 列表 → 本机图片路径列表(喂进 reference_image_paths 当参考图)。
    复用 studio_compose(studio.py 原 365-367 行)的"成品 id → 本机路径"解析模式，但更宽松:
    找不到 / 不是本店的(⚠️多租户，绝不跨店读) / 结果为空 / 文件已不在 uploads 内或已被删——
    一律静默跳过，不抛错、不崩(要同款是锦上添花，不该因为一个坏 id 拖垮整次生成)。"""
    import uuid as _uuid
    from pathlib import Path as _Path
    from sqlalchemy import select as _sel
    from config import settings as _settings
    from models.generation import Generation as _G

    parsed: list[_uuid.UUID] = []
    for gid in (generation_ids or []):
        try:
            parsed.append(_uuid.UUID(str(gid)))
        except (ValueError, TypeError):
            continue  # 格式不对的 id：跳过不崩
    if not parsed:
        return []

    res = await wdb.execute(
        _sel(_G).where(_G.id.in_(parsed), _G.store_id == store_id, _G.is_deleted == False)  # noqa: E712
    )
    gens = {g.id: g for g in res.scalars().all()}  # 别店/不存在的 id 天然不在这里面(过滤已在查询里做)

    udir = _Path(_settings.upload_dir).resolve()
    paths: list[str] = []
    for u in parsed:
        g = gens.get(u)
        if not g or not g.result:
            continue
        p = (udir / str(g.result).removeprefix("/uploads/")).resolve()
        in_uploads = str(p) == str(udir) or str(p).startswith(str(udir) + "/")
        if in_uploads and p.exists():
            # 按 "/uploads/..."-相对路径返回——这才是 poster_service.generate_images 参考图循环
            # (reference_image_paths)真正按契约期望读的格式:它拿 `ref_str.removeprefix("/uploads/")`
            # 再拼 upload_dir 去读文件，不是按绝对文件系统路径读。之前这里返回 str(p)(绝对路径)能
            # 工作纯属 pathlib 巧合——`Path(upload_dir) / <绝对路径>` 会整个丢弃左操作数，只是凑巧这个
            # 绝对路径本来就落在 uploads 内才蒙对，没有测试覆盖、不该继续依赖这个巧合(全仓审查 Important)。
            paths.append("/uploads/" + str(p.relative_to(udir)))
    return paths


@router.post("/expand")
async def studio_expand(
    body: StudioExpandIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """提示词优化:把大白话改写成优化的文生图提示词,返回前端展示+可改(改后即真实送模型)。同步(LLM 快)。
    U1・统一扩写层:实际调用 poster_service.expand_poster_text_with_llm(studio.py 与 ReAct 工具层
    共用同一套系统提示规则+硬要素 string-match 校验/兜底,见该函数注释)。"""
    raw = (body.prompt or "").strip()
    if not raw:
        raise AIServiceError("先说一句你想做什么图")
    check_generation_safety(raw)                              # H1(输入)
    from services.ai.factory import ProviderFactory
    provider = ProviderFactory.get_text_provider_for_store(store)
    optimized = await poster_service.expand_poster_text_with_llm(provider, raw, poster_text=body.poster_text)
    check_generation_safety(optimized)                        # H1(输出:模型可能跑偏)
    return {
        "image_prompt": optimized,
        # U1・"缺就问"信号(不阻断)：studio 是非对话直连页面，没有 LLM 回合可以现场追问，
        # 只能把"缺哪个"报给前端，由它决定要不要提示老板补充。
        "missing_elements": poster_service.detect_missing_hard_elements(body.poster_text),
    }


@router.post("/generate")
async def studio_generate(
    body: StudioGenerateIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """文生图(可带风格/参考图/变体张数)。异步:返回 {job_id},前端轮询 media-jobs/{id}。"""
    # image_prompt(前端可改的"优化后提示词")才是真送模型的那份，不能只查 body.prompt——
    # 否则 prompt 写安全的话、image_prompt 改成越线的话就绕过了这道红线预检。
    check_generation_safety(body.prompt, body.style or "", body.image_prompt or "")   # H1
    count = _clamp_count(body.count)                          # H3
    prompt = _compose_prompt(body.prompt, body.style)
    store_id, user_id, conv = store.id, user.id, body.conversation_id
    ratio, refs, quality = body.ratio, body.reference_image_paths, body.quality
    img_model, img_prompt, poster_text = body.image_model, body.image_prompt, body.poster_text
    print_mode = body.print_mode
    ref_gen_ids = body.reference_generation_ids   # E2-4・要同款:成品 id → 待解析成本机参考图路径

    async def work_fn(progress):
        from core.tenant import set_tenant
        set_tenant(store_id)  # 后台任务自己带租户上下文(generations/usage_quotas 靠它过滤)
        try:
            await progress(8, "正在出图…")
            async with async_session() as wdb:
                st = await wdb.get(Store, store_id)
                # E2-4・要同款:把"用作参考的成品 id"解析成本机路径、并进用户自己传的参考图一起喂。
                # 空/None(绝大多数调用) → extra_refs=[]，行为与改动前完全一致。
                extra_refs = await _resolve_reference_generation_paths(wdb, ref_gen_ids, store_id)
                all_refs = list(refs or []) + extra_refs
                res = await poster_service.generate_images(
                    wdb, st, user_id, prompt, image_model=img_model, ratio=ratio,
                    reference_image_paths=all_refs or None, count=count, conversation_id=conv, quality=quality,
                    image_prompt=img_prompt, poster_text=poster_text,
                    # studio 页的参考图是用户在本次请求里经系统文件框亲手选的(可信前端直传，
                    # 不是模型自己填的)，原样进白名单——否则沙箱外路径护栏会把它们误拒。
                    # 要同款解析出的路径本就在 uploads 沙箱内(_resolve_reference_generation_paths 已校验)，
                    # 不需要、也不应该额外塞进 allowed_paths(那是给沙箱外路径开的口子)。
                    allowed_paths=list(refs or []),
                    print_mode=print_mode,
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
    img_model = body.image_model
    edit_type, print_mode = body.edit_type, body.print_mode

    async def work_fn(progress):
        from core.tenant import set_tenant
        set_tenant(store_id)
        try:
            await progress(8, "正在按你圈的地方改…" if mask else "正在按你说的改…")
            async with async_session() as wdb:
                st = await wdb.get(Store, store_id)
                res = await poster_service.generate_images(
                    wdb, st, user_id, prompt, image_model=img_model, ratio=ratio,
                    refine_from=src, mask_path=mask, count=count, conversation_id=conv, quality=quality,
                    # mask 是本次请求里前端刚落盘的文件，显式进白名单——现在能过纯靠它恰好
                    # 落在 uploads 沙箱里(隐性巧合)，落点以后一变局部重绘就会静默失效。
                    allowed_paths=[mask] if mask else [],
                    edit_type=edit_type,
                    print_mode=print_mode,
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


@router.get("/generation/{generation_id}")
async def studio_get_generation(
    generation_id: str,
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """E1-C2・按 id 查一张成品的图/视频地址(本店作用域)。openWorkbench handoff 只带轻标识 fromGen
    (generation id)过去,真图从不进那条 IPC 通路——视频面板拿到 id 后靠这个接口换成真实 URL 当
    i2v 首帧喂给 /studio/i2v(同一份底图解析逻辑，不是各自造一份)。"""
    import uuid as _uuid
    from models.generation import Generation as _G

    try:
        gid = _uuid.UUID(str(generation_id))
    except (ValueError, TypeError):
        raise AIServiceError("成品 id 不对")
    g = await db.get(_G, gid)
    if not g or g.store_id != store.id or g.is_deleted or not g.result:
        raise AIServiceError("没找到这张成品（可能已删，或不是本店的）")
    return {"url": g.result, "ratio": g.sub_type or "9:16", "is_video": g.type == "video"}


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


@router.post("/storyboard")
async def studio_storyboard(
    body: StudioStoryboardIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """LLM 分镜 + 配文案:主题 → N 个分镜画面描述 + 一条配文案。助教一条龙的"写脚本/分镜"那步。同步(LLM 快)。"""
    check_generation_safety(body.theme, body.subject)        # H1(输入)
    n = max(2, min(int(body.shots or 3), 6))
    from services.ai.factory import ProviderFactory
    from services.ai.base import TextRequest

    provider = ProviderFactory.get_text_provider_for_store(store)
    # 关思考(dict 非 bool,传 False 不生效):要的是直接的 JSON 输出;开思考(MiMo 默认开)会把额度耗在 reasoning_content、content 反而空。
    resp = await provider.generate(TextRequest(prompt=_storyboard_prompt(body.theme, n, body.subject), max_tokens=1200, thinking={"type": "disabled"}))
    shots, caption = _parse_storyboard(getattr(resp, "content", "") or "", n)
    check_generation_safety(" ".join(shots), caption)        # H1(输出:模型可能跑偏)
    return {"shots": shots, "caption": caption}
