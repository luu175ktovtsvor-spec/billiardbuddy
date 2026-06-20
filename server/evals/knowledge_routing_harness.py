# -*- coding: utf-8 -*-
"""知识路由 harness（带数据库·真 MiMo）：测【运营工具选对没 + 知识抓没抓】这条核心链路。
- 真起 SQLite + 建测试门店 → 运营工具(写文案/平台内容/团购/活动/诊断/玩法)能真跑(走 run_generation 抓知识)。
- 用 MiMo 当编排脑 + 内容生成（monkeypatch ProviderFactory，绕过 BYOK 加密）。
- 每个用例【独立 session】(像真实请求，避免共享 session 导致 Generation refresh 报错)。
- 重点验路由：'写抖音'该去 make_platform_content 而不是被通用文案工具抢走。
key 走环境变量 MIMO_KEY。跑法：MIMO_KEY='sk-...' uv run python evals/knowledge_routing_harness.py
"""
import os
import sys
import asyncio
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{tempfile.mktemp(suffix='.db')}"
os.environ["DESKTOP_LOCAL"] = "1"
os.environ.setdefault("SECRET_KEY", "harness-test-secret")
os.environ.setdefault("BYOK_ENCRYPT_KEY", "aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxkMTI=")

from db.init_local import init_local_db  # noqa: E402
from db.session import async_session  # noqa: E402
from models.user import User  # noqa: E402
from models.store import Store  # noqa: E402
from services.ai import factory  # noqa: E402
from services.ai.providers.deepseek import DeepSeekProvider  # noqa: E402
import services.content_service as cs  # noqa: E402
from services.agent.registry import default_registry  # noqa: E402
from services.agent.context import AgentContext  # noqa: E402
from services.agent.loop import run_agent_loop_stream  # noqa: E402
import api.v1.agent  # noqa: E402,F401
from api.v1.agent import compose_agent_system_prompt  # noqa: E402

MIMO = DeepSeekProvider(api_key=os.environ["MIMO_KEY"], base_url="https://api.xiaomimimo.com/v1", default_model="mimo-v2.5")
factory.ProviderFactory.get_text_provider_for_store = classmethod(lambda cls, store: MIMO)
factory.ProviderFactory.get_orchestration_provider = classmethod(lambda cls: MIMO)


async def _noq(*a, **k):
    return type("Q", (), {})()
async def _noinc(*a, **k):
    return None
cs.check_quota = _noq          # 测路由,不测配额
cs.increment_usage = _noinc

OPS = {"write_operation_content", "make_platform_content", "make_groupbuy_content",
       "plan_activity", "diagnose_operation", "recommend_games"}

CASES = [
    ("写朋友圈", "帮我写条周末双人优惠的朋友圈", "write_operation_content"),
    ("写抖音脚本", "帮我写个发抖音的引流短视频脚本", "make_platform_content"),
    ("写小红书", "写条小红书笔记推荐我们店的环境", "make_platform_content"),
    ("写快手", "发个快手视频的文案，主打便宜", "make_platform_content"),
    ("做团购", "做个美团团购套餐文案，就是2人3小时套餐", "make_groupbuy_content"),
    ("策划活动", "帮我策划一套完整的会员日活动方案", "plan_activity"),
    ("经营诊断", "最近生意冷清营业额上不去，帮我诊断分析下原因和改进", "diagnose_operation"),
    ("推荐玩法", "给3个人推荐几个适合暖场的台球小游戏玩法", "recommend_games"),
    ("刁钻·抖音活动文案", "给我写一条抖音视频文案，宣传周末的充值活动", "make_platform_content"),
]


async def main():
    await init_local_db()
    async with async_session() as setup:
        u = User(id=uuid.uuid4(), phone="13800000000", password_hash="x", name="测试老板")
        setup.add(u)
        await setup.flush()
        s = Store(id=uuid.uuid4(), owner_id=u.id, name="星光台球俱乐部")
        setup.add(s)
        await setup.commit()
        store_id, user_id = s.id, u.id

    sysp = compose_agent_system_prompt("星光台球俱乐部（中八为主，有教练，周末旺）", "", full_disk=False)
    results = []
    for title, msg, expect in CASES:
        tools, final, err = [], "", None
        async with async_session() as session:   # 每个用例独立 session = 真实请求行为
            store = await session.get(Store, store_id)
            user = await session.get(User, user_id)
            ctx = AgentContext(db=session, store=store, user=user, permission_mode="full", auto_spend_limit=-1)
            try:
                async for ev in run_agent_loop_stream(user_message=msg, registry=default_registry, ctx=ctx,
                                                      system_prompt=sysp, provider=MIMO, model="mimo-v2.5", max_turns=6):
                    if ev.get("type") == "tool_call":
                        tools.append(ev.get("tool"))
                    elif ev.get("type") == "final":
                        final = ev.get("content") or ""
                    elif ev.get("type") == "error":
                        err = ev.get("message")
            except Exception as e:
                err = repr(e)
        ops = [t for t in tools if t in OPS]
        first_ops = ops[0] if ops else None
        routed_ok = first_ops == expect            # 第一个运营工具就是该用的 = 路由对
        asked = (not ops) and ("?" in final or "？" in final or "选" in final[:20])  # 没调工具而是先问澄清
        produced = len(final.strip()) > 20
        results.append((title, expect, first_ops, ops, routed_ok, asked, produced, err))
        tag = "✅路由对" if routed_ok else ("🟡先问澄清" if asked else "❌选错/没调")
        print(f"{tag} | {title} | 期望={expect} 实首调={first_ops} 全部运营工具={ops} | 出内容={produced} 错={err}")
        if final:
            print(f"     产出: {final[:70]!r}")

    print("\n===== 知识路由汇总 =====")
    routed = sum(1 for r in results if r[4])
    asked_n = sum(1 for r in results if (not r[4]) and r[5])
    for t, e, fo, ops, ok, ask, prod, err in results:
        mark = "✅" if ok else ("🟡" if ask else "❌")
        print(f"  {mark} {t}: 首调={fo} 期望={e}{'' if not err else ' 错='+str(err)}")
    print(f"\n路由正确 {routed}/{len(results)}；先问澄清(可接受) {asked_n}/{len(results)}")


if __name__ == "__main__":
    asyncio.run(main())
