"""阶段2 /studio 直连路由:H1 红线预检 + H3 张数护栏 + 异步出图(runner)+ 改图血缘回填。

generate_images 用 fake 顶掉(不真打生图 API);runner/studio 的 async_session 换 in-memory。
"""
import asyncio
import uuid
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401
from core.exceptions import AIServiceError
from core.tenant import set_tenant
from db.base import Base
from models.generation import Generation
from models.store import Store
from models.user import User
from services import media_jobs_service as mj
from services import media_jobs_runner as runner
import api.v1.studio as studio


async def _seed(db, sid):
    u = User(id=uuid.uuid4(), phone="13800000000", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    db.add(Store(id=sid, owner_id=u.id, name="店"))
    await db.commit()  # 提交,后台 work_fn 的独立 session 才读得到 store
    return u.id


# ── 纯同步守卫:不需要 DB/runner ──

def test_clamp_count_h3():
    assert studio._clamp_count(10) == 4      # 超上限砍到 4
    assert studio._clamp_count(0) == 1       # 兜底至少 1
    assert studio._clamp_count(3) == 3
    assert studio._clamp_count("x") == 1     # 非法兜底


def test_studio_generate_blocks_redline():
    async def main():
        body = studio.StudioGenerateIn(prompt="性交易上门服务海报")
        try:
            await studio.studio_generate(body, user=SimpleNamespace(id=uuid.uuid4()),
                                         store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "红线内容应被拦"
        except AIServiceError:
            pass
    asyncio.run(main())


def test_studio_expand_uses_unified_expand_and_reports_missing_elements(monkeypatch):
    """U1：/expand 改走 poster_service.expand_poster_text_with_llm(共享函数)，
    并把 detect_missing_hard_elements 的信号一起报给前端(不阻断)。"""
    async def main():
        captured = {}

        async def fake_expand(provider, raw, poster_text=None):
            captured["raw"] = raw
            captured["poster_text"] = poster_text
            return "扩写后的提示词"

        monkeypatch.setattr(studio.poster_service, "expand_poster_text_with_llm", fake_expand)
        monkeypatch.setattr("services.ai.factory.ProviderFactory.get_text_provider_for_store",
                            classmethod(lambda cls, store: object()))

        body = studio.StudioExpandIn(prompt="周末台球活动海报", poster_text={"title": "老王台球", "price": None})
        out = await studio.studio_expand(body, user=SimpleNamespace(id=uuid.uuid4()),
                                         store=SimpleNamespace(id=uuid.uuid4()), db=None)
        assert out["image_prompt"] == "扩写后的提示词"
        assert out["missing_elements"] == ["price"]
        assert captured["raw"] == "周末台球活动海报"
        assert captured["poster_text"] == {"title": "老王台球", "price": None}
    asyncio.run(main())


def test_studio_expand_backward_compatible_without_poster_text(monkeypatch):
    """不传 poster_text(旧调用/旧前端) → missing_elements 恒为空，行为与改动前一致。"""
    async def main():
        async def fake_expand(provider, raw, poster_text=None):
            return raw + "（已扩写）"

        monkeypatch.setattr(studio.poster_service, "expand_poster_text_with_llm", fake_expand)
        monkeypatch.setattr("services.ai.factory.ProviderFactory.get_text_provider_for_store",
                            classmethod(lambda cls, store: object()))

        body = studio.StudioExpandIn(prompt="周末台球活动海报")
        out = await studio.studio_expand(body, user=SimpleNamespace(id=uuid.uuid4()),
                                         store=SimpleNamespace(id=uuid.uuid4()), db=None)
        assert out["image_prompt"] == "周末台球活动海报（已扩写）"
        assert out["missing_elements"] == []
    asyncio.run(main())


def test_studio_generate_threads_poster_text_and_reports_missing(monkeypatch):
    """U1：/generate 把 poster_text 透传给 generate_images，且 missing_elements 出现在最终结果里
    （studio 是非对话直连页面，没法现场追问——只能把信号交给前端）。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

        captured = {}

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4", count=1, **kw):
            captured.update(kw)
            return {
                "images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/a.png", "ratio": ratio}],
                "missing_elements": ["price"],
            }
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioGenerateIn(prompt="周末台球活动海报", poster_text={"title": "老王台球", "price": None})
        out = await studio.studio_generate(body, user=SimpleNamespace(id=uid),
                                           store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]

        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)
        assert captured.get("poster_text") == {"title": "老王台球", "price": None}
        assert got.result["missing_elements"] == ["price"]
    asyncio.run(main())


def test_result_payload_carries_model_switched_marker_aligned_with_urls():
    """U2：_result_payload 必须把降级安全网标记(model_switched)透传出去、且与 urls 同下标对齐——
    前端(下一批)据此提示"这张用了备用模型"，不能让这个标记在 poster_service 出来后就被丢在半路。"""
    res = {
        "images": [
            {"poster_url": "/uploads/a.png", "generation_id": uuid.uuid4(), "ratio": "3:4", "model_switched": True},
            {"poster_url": "/uploads/b.png", "generation_id": uuid.uuid4(), "ratio": "3:4", "model_switched": False},
        ],
    }
    out = studio._result_payload(res)
    assert out["model_switched"] == [True, False]
    assert len(out["urls"]) == len(out["model_switched"])


def test_result_payload_model_switched_defaults_false_when_missing():
    """旧调用方/未来某条路径没带 model_switched 字段时，安全默认 False，不炸。"""
    res = {"images": [{"poster_url": "/uploads/a.png", "generation_id": uuid.uuid4(), "ratio": "3:4"}]}
    out = studio._result_payload(res)
    assert out["model_switched"] == [False]


def test_result_payload_carries_text_quality_warning_when_any_image_flagged():
    """E2-4(收 U5 遗留)：poster_service 已把 OCR 重出后仍未对上的软警告放进每张图的 outcome，
    但 _result_payload 白名单此前没带这两个字段、前端收不到——这里补上。整批"有一张就标"
    (选简单方案，不做 per-image 精细展示)，message 取第一张触发警告的那句。"""
    res = {
        "images": [
            {"poster_url": "/uploads/a.png", "generation_id": uuid.uuid4(), "ratio": "3:4",
             "text_quality_warning": False, "text_quality_warning_message": None},
            {"poster_url": "/uploads/b.png", "generation_id": uuid.uuid4(), "ratio": "3:4",
             "text_quality_warning": True, "text_quality_warning_message": "文字可能有点偏差，可以再改一版"},
        ],
    }
    out = studio._result_payload(res)
    assert out["text_quality_warning"] is True
    assert out["text_quality_warning_message"] == "文字可能有点偏差，可以再改一版"


def test_result_payload_text_quality_warning_defaults_false_when_missing():
    """旧调用方/没有触发软警告的正常一批 → 恒 False + None，不误报。"""
    res = {"images": [{"poster_url": "/uploads/a.png", "generation_id": uuid.uuid4(), "ratio": "3:4"}]}
    out = studio._result_payload(res)
    assert out["text_quality_warning"] is False
    assert out["text_quality_warning_message"] is None


def test_studio_edit_requires_source_generation():
    async def main():
        body = studio.StudioEditIn(prompt="改亮一点", source_generation_id="")
        try:
            await studio.studio_edit(body, user=SimpleNamespace(id=uuid.uuid4()),
                                     store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "没指定要改的成品应报错"
        except AIServiceError:
            pass
    asyncio.run(main())


# ── 集成:runner + work_fn + session 接线 ──

def test_studio_generate_submits_job_and_completes(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4", count=1, **kw):
            assert count == 4  # H3:count=9 被砍到 4
            return {"images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/a.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioGenerateIn(prompt="台球周赛海报", ratio="9:16", count=9)
        out = await studio.studio_generate(body, user=SimpleNamespace(id=uid),
                                           store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]
        assert jid

        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)
        assert got.result["urls"] == ["/uploads/a.png"]
    asyncio.run(main())


# ── E2-4:要同款(reference_generation_ids → 本机路径,并进 reference_image_paths) ──

def test_studio_generate_resolves_reference_generation_ids_to_local_paths(monkeypatch, tmp_path):
    """本店成品 id → 解析成本机图片路径、并入 reference_image_paths 一起喂给 generate_images。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        import config as _cfg
        monkeypatch.setattr(_cfg.settings, "upload_dir", str(tmp_path))
        (tmp_path / "posters").mkdir(parents=True)
        (tmp_path / "posters" / "ref.png").write_bytes(b"REF")

        sid = uuid.uuid4()
        ref_gid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
            db.add(Generation(id=ref_gid, store_id=sid, type="poster",
                              result="/uploads/posters/ref.png", model_used="m"))
            await db.commit()

        captured = {}

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4", count=1, **kw):
            captured.update(kw)
            return {"images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/a.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioGenerateIn(prompt="要同款", reference_generation_ids=[str(ref_gid)])
        out = await studio.studio_generate(body, user=SimpleNamespace(id=uid),
                                           store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]
        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)
        # Finding 2 修复(全仓审查)：解析结果按 "/uploads/..."-相对路径返回(跟 poster_service 参考图
        # 循环实际期望的契约一致)，不再是"绝对路径恰好落在 uploads 内"的 pathlib 巧合。
        assert captured.get("reference_image_paths") == ["/uploads/posters/ref.png"]
    asyncio.run(main())


def test_studio_generate_merges_reference_generation_ids_with_explicit_refs(monkeypatch, tmp_path):
    """要同款不是"替换"，是"并入"：用户自己带的参考图 + 要同款解析出的路径要一起喂，且顺序保持
    "用户传的在前、要同款解析的在后"(实现细节，但要能验证真的是拼接不是覆盖)。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        import config as _cfg
        monkeypatch.setattr(_cfg.settings, "upload_dir", str(tmp_path))
        (tmp_path / "posters").mkdir(parents=True)
        (tmp_path / "posters" / "ref.png").write_bytes(b"REF")

        sid = uuid.uuid4()
        ref_gid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
            db.add(Generation(id=ref_gid, store_id=sid, type="poster",
                              result="/uploads/posters/ref.png", model_used="m"))
            await db.commit()

        captured = {}

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4", count=1, **kw):
            captured.update(kw)
            return {"images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/a.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioGenerateIn(
            prompt="要同款+自己带的参考图",
            reference_image_paths=["/tmp/user_picked.png"],
            reference_generation_ids=[str(ref_gid)],
        )
        out = await studio.studio_generate(body, user=SimpleNamespace(id=uid),
                                           store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]
        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)
        # Finding 2 修复:要同款解析出的路径是 "/uploads/..."-相对格式，不是绝对路径。
        assert captured.get("reference_image_paths") == ["/tmp/user_picked.png", "/uploads/posters/ref.png"]
    asyncio.run(main())


def test_studio_generate_skips_cross_store_reference_generation_id(monkeypatch, tmp_path):
    """⚠️多租户铁律:别店的成品 id 绝不能被读进来当参考图(跨店读=泄露)——跳过、不崩、正常出图。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        import config as _cfg
        monkeypatch.setattr(_cfg.settings, "upload_dir", str(tmp_path))
        (tmp_path / "posters").mkdir(parents=True)
        (tmp_path / "posters" / "other.png").write_bytes(b"OTHER")

        sid, other_sid = uuid.uuid4(), uuid.uuid4()
        other_gid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
            # 别的店:同一个 owner 开两家店也合法，这里只是为了避免 _seed 重复插入同手机号撞唯一约束——
            # 测试要的是"店 id 不同"，owner 是不是同一人不影响本用例要验证的"跨店读不到"。
            db.add(Store(id=other_sid, owner_id=uid, name="别的店"))
            db.add(Generation(id=other_gid, store_id=other_sid, type="poster",
                              result="/uploads/posters/other.png", model_used="m"))
            await db.commit()

        captured = {}

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4", count=1, **kw):
            captured.update(kw)
            return {"images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/a.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioGenerateIn(prompt="要同款", reference_generation_ids=[str(other_gid)])
        out = await studio.studio_generate(body, user=SimpleNamespace(id=uid),
                                           store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]
        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)  # 没崩,照常出图
        assert captured.get("reference_image_paths") is None   # 跨店 id 被过滤,没混进参考图
    asyncio.run(main())


def test_studio_generate_skips_invalid_reference_generation_id(monkeypatch):
    """格式不对的 id / 格式对但压根不存在的 id：都该被跳过、不崩，不是抛 500。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

        captured = {}

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4", count=1, **kw):
            captured.update(kw)
            return {"images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/a.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioGenerateIn(prompt="要同款", reference_generation_ids=["not-a-uuid", str(uuid.uuid4())])
        out = await studio.studio_generate(body, user=SimpleNamespace(id=uid),
                                           store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]
        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)
        assert captured.get("reference_image_paths") is None
    asyncio.run(main())


def test_studio_generate_reference_generation_ids_none_leaves_refs_unchanged(monkeypatch):
    """不传 reference_generation_ids(旧调用/绝大多数场景) → reference_image_paths 行为与改动前完全一致。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

        captured = {}

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4", count=1, **kw):
            captured.update(kw)
            return {"images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/a.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioGenerateIn(prompt="普通生成，不带要同款")
        out = await studio.studio_generate(body, user=SimpleNamespace(id=uid),
                                           store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]
        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)
        assert captured.get("reference_image_paths") is None
    asyncio.run(main())


def test_studio_reference_generation_id_real_load_into_generate_images(monkeypatch, tmp_path):
    """Finding 2(全仓审查)真集成回归:不 mock poster_service.generate_images 本体——只顶掉最外层的
    ProviderFactory.build_image_provider(避免真打生图 API)，让 _resolve_reference_generation_paths
    产出的路径真的流进 generate_images 内部的参考图循环(reference_image_paths → ref_bytes →
    input_images)，断言参考图字节确实被读出来喂给了 provider.generate_image。
    这条要证的是"格式对了所以真能工作"，不是"格式对了、但 generate_images 是假的所以什么都测不出"
    (旧覆盖只 mock 到 generate_images 这层，测不出 ref-loop 内部的路径格式契约)。"""
    import io

    from PIL import Image, ImageDraw

    def _striped_png(w, h, color=(120, 60, 200)) -> bytes:
        # U4 出图质检会拒绝"疑似纯色/空白图"——画几条条纹给足内容方差，让假 provider 的产出能过质检
        # (同 tests/test_edit_routing_brand_qr.py::_png_bytes 的写法)。
        img = Image.new("RGB", (w, h), color)
        d = ImageDraw.Draw(img)
        for y in range(0, h, 60):
            d.rectangle([0, y, w, y + 20], fill=(255, 255, 255))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return buf.getvalue()

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)

        import config as _cfg
        monkeypatch.setenv("DESKTOP_LOCAL", "1")
        monkeypatch.setattr(_cfg.settings, "upload_dir", str(tmp_path))
        monkeypatch.setattr(_cfg.settings, "openai_api_key", "sk-test")
        monkeypatch.setattr(_cfg.settings, "ark_api_key", "ark-test-key")
        monkeypatch.setattr(_cfg.settings, "image_model_name", "")

        (tmp_path / "posters").mkdir(parents=True)

        # 参考图本身随便什么内容都行(只从磁盘读字节，不过质检)，落盘一张简单纯色图即可。
        ref_bytes_on_disk = _striped_png(200, 200, color=(10, 200, 10))
        (tmp_path / "posters" / "ref.png").write_bytes(ref_bytes_on_disk)

        sid = uuid.uuid4()
        ref_gid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
            store = await db.get(Store, sid)
            db.add(Generation(id=ref_gid, store_id=sid, type="poster",
                              result="/uploads/posters/ref.png", model_used="m"))
            await db.commit()

            resolved = await studio._resolve_reference_generation_paths(db, [str(ref_gid)], sid)
            assert resolved == ["/uploads/posters/ref.png"], resolved  # 按契约格式，不是绝对路径巧合

            captured = {}

            class _FakeProvider:
                async def generate_image(self, **kwargs) -> bytes:
                    captured.update(kwargs)
                    return _striped_png(1152, 1536)  # 生成的"产出图"要过质检，必须有内容方差

            from services.ai.factory import ProviderFactory
            monkeypatch.setattr(ProviderFactory, "build_image_provider",
                                staticmethod(lambda api_key, base_url, model=None: _FakeProvider()))

            result = await studio.poster_service.generate_images(
                db=db, store=store, user_id=uid, prompt="要同款氛围图",
                image_model=None, ratio="3:4", count=1,
                reference_image_paths=resolved,
            )
            assert result["count"] == 1
            images_arg = captured.get("image") or []
            assert ref_bytes_on_disk in images_arg, "要同款解析出的参考图字节没有真正流进 input_images"
    asyncio.run(main())


def test_studio_edit_backfills_parent_lineage(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
        parent_gid = uuid.uuid4()

        new_gid = uuid.uuid4()

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4",
                           refine_from=None, mask_path=None, count=1, **kw):
            assert refine_from == str(parent_gid)        # 源成品 id 当 refine_from 底图(不是 URL)
            assert mask_path == "/tmp/mask.png"          # mask 透传(局部重绘)
            db.add(Generation(id=new_gid, store_id=store.id, type="poster",
                              result="/uploads/edited.png", model_used="gpt-image-2"))
            await db.flush()
            return {"images": [{"generation_id": new_gid, "poster_url": "/uploads/edited.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioEditIn(prompt="把这块改成夜晚", source_generation_id=str(parent_gid),
                                   mask_path="/tmp/mask.png")
        out = await studio.studio_edit(body, user=SimpleNamespace(id=uid),
                                       store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]

        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)

        set_tenant(sid)
        async with Session() as db:
            g = await db.get(Generation, new_gid)
            assert g is not None and g.parent_generation_id == parent_gid  # 血缘已回填
        set_tenant(None)
    asyncio.run(main())


# ── U5(E3d)：edit_type / print_mode 参数入口透传（studio 层不做判断，只负责把请求体字段递给 generate_images）──

def test_studio_edit_threads_edit_type_and_print_mode(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
        parent_gid = uuid.uuid4()
        captured = {}

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4",
                           refine_from=None, mask_path=None, count=1, **kw):
            captured.update(kw)
            return {"images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/edited.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioEditIn(prompt="字打错了", source_generation_id=str(parent_gid),
                                   edit_type="text_fix", print_mode=True)
        out = await studio.studio_edit(body, user=SimpleNamespace(id=uid),
                                       store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]

        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)
        assert captured.get("edit_type") == "text_fix"
        assert captured.get("print_mode") is True
    asyncio.run(main())


def test_studio_edit_default_print_mode_is_false(monkeypatch):
    """请求体不传 print_mode → 默认 False，现状不变(owner 铁律：默认不做程序叠层)。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
        captured = {}

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4",
                           refine_from=None, mask_path=None, count=1, **kw):
            captured.update(kw)
            return {"images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/edited.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioEditIn(prompt="改一下", source_generation_id=str(uuid.uuid4()))
        out = await studio.studio_edit(body, user=SimpleNamespace(id=uid),
                                       store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert captured.get("edit_type") is None
        assert captured.get("print_mode") is False
    asyncio.run(main())


def test_studio_generate_threads_print_mode(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
        captured = {}

        async def fake_gen(db, store, user_id, prompt, image_model=None, ratio="3:4", count=1, **kw):
            captured.update(kw)
            return {"images": [{"generation_id": uuid.uuid4(), "poster_url": "/uploads/a.png", "ratio": ratio}]}
        monkeypatch.setattr(studio.poster_service, "generate_images", fake_gen)

        body = studio.StudioGenerateIn(prompt="要拿去印刷的海报", print_mode=True)
        out = await studio.studio_generate(body, user=SimpleNamespace(id=uid),
                                           store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert captured.get("print_mode") is True
    asyncio.run(main())


# ── 阶段4 /studio/i2v 图生视频 ──

def test_studio_i2v_requires_first_frame():
    async def main():
        body = studio.StudioI2vIn(first_frame="")
        try:
            await studio.studio_i2v(body, user=SimpleNamespace(id=uuid.uuid4()),
                                    store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "没首帧图应报错"
        except AIServiceError:
            pass
    asyncio.run(main())


def test_studio_i2v_blocks_redline():
    async def main():
        body = studio.StudioI2vIn(first_frame="/uploads/posters/x.jpg", prompt="加上性交易上门服务字样")
        try:
            await studio.studio_i2v(body, user=SimpleNamespace(id=uuid.uuid4()),
                                    store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "红线内容应被拦"
        except AIServiceError:
            pass
    asyncio.run(main())


def test_studio_i2v_submits_video_job(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr(studio, "async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

        async def fake_video(*, db, store, user_id, prompt, ratio="9:16", duration=5,
                             first_frame=None, generate_audio=False, image_refs=None, **kw):
            assert first_frame == "/uploads/posters/x.jpg"      # 把这张图动起来
            assert generate_audio is True                       # 配音透传
            assert image_refs == ["/uploads/a.jpg"]             # 多图锁人物透传
            return {"video_url": "/uploads/videos/v.mp4", "generation_id": uuid.uuid4(), "conversation_id": "c1"}
        monkeypatch.setattr(studio.video_service, "generate_video", fake_video)

        body = studio.StudioI2vIn(first_frame="/uploads/posters/x.jpg", prompt="自然地动起来",
                                  generate_audio=True, image_refs=["/uploads/a.jpg"])
        out = await studio.studio_i2v(body, user=SimpleNamespace(id=uid),
                                      store=SimpleNamespace(id=sid), db=None)
        jid = out["job_id"]
        got = None
        for _ in range(100):
            await asyncio.sleep(0.01)
            async with Session() as db:
                got = await mj.get_job(db, jid, sid)
            if got and got.status in ("done", "error"):
                break
        assert got is not None and got.status == "done", (got.status, got.error)
        assert got.result["urls"] == ["/uploads/videos/v.mp4"]
        assert got.result["is_video"] is True
    asyncio.run(main())


# ── 阶段5 /studio/compose 多镜合成(路径解析,真 ffmpeg 在前端 Electron) ──

def test_studio_compose_resolves_ordered_paths(monkeypatch, tmp_path):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid = uuid.uuid4()
        set_tenant(sid)
        vdir = tmp_path / "videos"; vdir.mkdir(parents=True)
        (vdir / "a.mp4").write_bytes(b"AAAA"); (vdir / "b.mp4").write_bytes(b"BBBB")
        import config as _cfg
        monkeypatch.setattr(_cfg.settings, "upload_dir", str(tmp_path))

        g1, g2 = uuid.uuid4(), uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
            db.add(Generation(id=g1, store_id=sid, type="video", result="/uploads/videos/a.mp4", model_used="m"))
            db.add(Generation(id=g2, store_id=sid, type="video", result="/uploads/videos/b.mp4", model_used="m"))
            await db.commit()

            # 给的顺序 [g2,g1] → inputs 必须是 [b.mp4, a.mp4](拼接顺序就是给的顺序)
            body = studio.StudioComposeIn(generation_ids=[str(g2), str(g1)])
            out = await studio.studio_compose(body, user=SimpleNamespace(id=uid),
                                              store=SimpleNamespace(id=sid), db=db)
            assert out["inputs"] == [str((vdir / "b.mp4").resolve()), str((vdir / "a.mp4").resolve())]
            assert out["output_url"].startswith("/uploads/videos/composed_") and out["output_url"].endswith(".mp4")
        set_tenant(None)
    asyncio.run(main())


def test_studio_compose_needs_two():
    async def main():
        body = studio.StudioComposeIn(generation_ids=["only-one"])
        try:
            await studio.studio_compose(body, user=SimpleNamespace(id=uuid.uuid4()),
                                        store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "少于两段应报错"
        except AIServiceError:
            pass
    asyncio.run(main())


def test_studio_compose_blocks_missing_or_cross_store(monkeypatch, tmp_path):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid = uuid.uuid4()
        set_tenant(sid)
        import config as _cfg
        monkeypatch.setattr(_cfg.settings, "upload_dir", str(tmp_path))
        (tmp_path / "videos").mkdir(parents=True)
        async with Session() as db:
            uid = await _seed(db, sid)
            # 两个 id 都不存在 → 报错(找不到)
            body = studio.StudioComposeIn(generation_ids=[str(uuid.uuid4()), str(uuid.uuid4())])
            try:
                await studio.studio_compose(body, user=SimpleNamespace(id=uid),
                                            store=SimpleNamespace(id=sid), db=db)
                assert False, "找不到的视频应报错"
            except AIServiceError:
                pass
        set_tenant(None)
    asyncio.run(main())


# ── 阶段5 助教一条龙:/studio/storyboard(LLM 分镜+文案) ──

def test_studio_storyboard_parses_shots_and_caption(monkeypatch):
    async def main():
        class FakeProvider:
            async def generate(self, req):
                return SimpleNamespace(content='好的。{"shots":["镜头1:缓缓推进台球桌","镜头2:黑八入袋特写","镜头3:全景欢呼"],"caption":"今晚台球之夜，来战！"}')
        monkeypatch.setattr("services.ai.factory.ProviderFactory.get_text_provider_for_store",
                            classmethod(lambda cls, store: FakeProvider()))
        body = studio.StudioStoryboardIn(theme="台球之夜", shots=3, subject="台球助教")
        out = await studio.studio_storyboard(body, user=SimpleNamespace(id=uuid.uuid4()),
                                             store=SimpleNamespace(id=uuid.uuid4()), db=None)
        assert out["shots"] == ["镜头1:缓缓推进台球桌", "镜头2:黑八入袋特写", "镜头3:全景欢呼"]
        assert "台球之夜" in out["caption"]
    asyncio.run(main())


def test_studio_storyboard_blocks_redline_theme():
    async def main():
        body = studio.StudioStoryboardIn(theme="性交易上门服务短片")
        try:
            await studio.studio_storyboard(body, user=SimpleNamespace(id=uuid.uuid4()),
                                           store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "红线主题应被拦"
        except AIServiceError:
            pass
    asyncio.run(main())


def test_studio_storyboard_fallback_line_split(monkeypatch):
    async def main():
        class FakeProvider:
            async def generate(self, req):
                return SimpleNamespace(content="1. 推镜头到台球桌全景\n2. 特写黑八稳稳入袋\n3. 全场起立欢呼")
        monkeypatch.setattr("services.ai.factory.ProviderFactory.get_text_provider_for_store",
                            classmethod(lambda cls, store: FakeProvider()))
        body = studio.StudioStoryboardIn(theme="台球", shots=3)
        out = await studio.studio_storyboard(body, user=SimpleNamespace(id=uuid.uuid4()),
                                             store=SimpleNamespace(id=uuid.uuid4()), db=None)
        assert len(out["shots"]) == 3 and "台球桌" in out["shots"][0]  # 非 JSON → 按行兜底
    asyncio.run(main())


# ── E1-C2 修复(review Finding 1)：GET /studio/generation/{id} 做成视频 handoff 用的只读端点 ──
#
# ⚠️ generations 表受 core/tenant.py 的自动租户过滤保护(无租户上下文 fail-safe 清空结果)——真实
# HTTP 请求里租户上下文由 `get_current_store` 依赖(api/deps.py:50 `set_tenant(store.id)`)在进
# endpoint 前设好；这里绕开 FastAPI DI 直调函数，必须手动 set_tenant 模拟同样的请求前置条件，
# 否则 db.get() 会被 fail-safe 清空、测出假阴性(这不是 studio_get_generation 本身的 bug)。

def test_studio_get_generation_returns_own_store_generation():
    """本店的成品：按 id 查得到 {url, ratio, is_video}，url/ratio 就是这张成品自己的字段
    （不是别的成品、也不是拼出来的默认值）。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid = uuid.uuid4()
        gid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
            db.add(Generation(id=gid, store_id=sid, type="poster", sub_type="9:16",
                              result="/uploads/posters/mine.png", model_used="m"))
            await db.commit()

            set_tenant(sid)  # 模拟 get_current_store 依赖已设好的请求前置条件
            try:
                out = await studio.studio_get_generation(
                    str(gid), user=SimpleNamespace(id=uid), store=SimpleNamespace(id=sid), db=db)
            finally:
                set_tenant(None)
            assert out == {"url": "/uploads/posters/mine.png", "ratio": "9:16", "is_video": False}
    asyncio.run(main())


def test_studio_get_generation_marks_video_type():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid = uuid.uuid4()
        gid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
            db.add(Generation(id=gid, store_id=sid, type="video", sub_type="9:16",
                              result="/uploads/videos/mine.mp4", model_used="m"))
            await db.commit()

            set_tenant(sid)
            try:
                out = await studio.studio_get_generation(
                    str(gid), user=SimpleNamespace(id=uid), store=SimpleNamespace(id=sid), db=db)
            finally:
                set_tenant(None)
            assert out["is_video"] is True
    asyncio.run(main())


def test_studio_get_generation_rejects_cross_store():
    """⚠️多租户铁律:别店的成品 id 不能被这个只读端点读出来(跨店泄露)。当前请求的租户上下文
    是"我自己的店"(sid)，去查另一家店(other_sid)的成品 id——两道防线都该拦住(租户过滤先在
    DB 层就查不到 + 端点自己的 store_id 显式校验)。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid, other_sid = uuid.uuid4(), uuid.uuid4()
        other_gid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
            db.add(Store(id=other_sid, owner_id=uid, name="别的店"))
            db.add(Generation(id=other_gid, store_id=other_sid, type="poster",
                              result="/uploads/posters/other.png", model_used="m"))
            await db.commit()

            set_tenant(sid)  # 当前请求的门店是 sid，不是 other_sid
            try:
                try:
                    await studio.studio_get_generation(
                        str(other_gid), user=SimpleNamespace(id=uid), store=SimpleNamespace(id=sid), db=db)
                    assert False, "别店的成品不应被读到"
                except AIServiceError:
                    pass
            finally:
                set_tenant(None)
    asyncio.run(main())


def test_studio_get_generation_rejects_nonexistent_id():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)

            set_tenant(sid)
            try:
                try:
                    await studio.studio_get_generation(
                        str(uuid.uuid4()), user=SimpleNamespace(id=uid), store=SimpleNamespace(id=sid), db=db)
                    assert False, "不存在的 id 不应返回成品"
                except AIServiceError:
                    pass
            finally:
                set_tenant(None)
    asyncio.run(main())


def test_studio_get_generation_rejects_malformed_id():
    async def main():
        try:
            await studio.studio_get_generation(
                "not-a-uuid", user=SimpleNamespace(id=uuid.uuid4()),
                store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "格式不对的 id 不应被当成合法请求处理"
        except AIServiceError:
            pass
    asyncio.run(main())


def test_studio_get_generation_rejects_deleted_generation():
    """软删的成品(is_deleted)不该再被这个端点读出来当作有效素材。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        sid = uuid.uuid4()
        gid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed(db, sid)
            db.add(Generation(id=gid, store_id=sid, type="poster", is_deleted=True,
                              result="/uploads/posters/gone.png", model_used="m"))
            await db.commit()

            set_tenant(sid)
            try:
                try:
                    await studio.studio_get_generation(
                        str(gid), user=SimpleNamespace(id=uid), store=SimpleNamespace(id=sid), db=db)
                    assert False, "已删的成品不应被读到"
                except AIServiceError:
                    pass
            finally:
                set_tenant(None)
    asyncio.run(main())
