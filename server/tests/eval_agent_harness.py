# -*- coding: utf-8 -*-
"""Agent harness 评测 / golden eval —— 给"改壳子"一把可复用的尺子。

背景（见 ~/Desktop/球房-验收报告/Harness优化专项-模型不动只优化壳子-2026-07-02.md「配套地基·评测」一节）：
harness（loop.py 里的自救/压缩/落盘/防空转…）改动目前没有任何"变好还是变坏"的衡量手段——107 个 pytest
全是 mock provider，测不出真模型行为；`--eval` 只有 5 个店脑用例。这份补上 Agent 循环这一层的评测。

特点（区别于普通单测，照抄 eval_store_brain.py 的骨架）：
- 调真实内置模型（当前是 MiMo v2.5，走 `settings.deepseek_api_key` 这把内置 key）——慢且花钱，
  **不随默认 pytest 跑**：文件名 eval_* 不被默认收集（pytest 默认只收 test_*.py）；
  显式运行：`pytest tests/eval_agent_harness.py -s`（或 `bash scripts/test.sh --eval-agent`）。
- 无内置 key 自动跳过（CI/他人机器不受阻）。桌面盒子真机是 Electron 的 backend.js 在启动子进程时把
  `server/.env.bundled.local` 解析注入进程 env；直接 `pytest` 跑没有 Electron 那一层，所以这里手动
  复刻同一份"解析 KEY=VALUE 注入 os.environ"的逻辑（`_load_bundled_env`），读的是同一份 key 文件。
- 判分**全部程序化断言**，不用 LLM 当裁判——文件是否真写了 / 内容对不对 / 有没有调对工具 / 有没有收尾，
  都是可复现的客观检查，不依赖"另找一个模型评分"的不稳定环节。

覆盖五类（10~15 个固定任务）：
  A 工具选择正确性 tool_choice   —— 该调工具时调对、不该调时不瞎调。
  B 多步完成度     multi_step    —— 建文件→读回/改→读回 这类多步任务真做完、真做对。
  C 长输出完整性   long_output   —— 长文成品字数够、没被腰斩成半句。
  D 压缩保真       compression   —— 上下文顶满触发 autocompact 语义压缩后，早期关键事实还在不在。
  E 防空转         anti_spin     —— 工具注定失败时循环正常收尾、不无限重试、把问题说清楚给用户。

每个任务记 成功/失败、turns、tokens_used、cached_tokens 四项，汇总写到
`~/Desktop/球房-验收报告/agent-harness-eval-<日期>.json`（改动前后各跑一遍，拿两份 JSON 对比）。

cached_tokens 目前恒为 None：run_agent_loop 走的是 provider.generate()（非流式），TextResponse 只有
tokens_used/prompt_tokens 两个数字字段，不透出 prompt-cache 命中数——那个信息只有 generate_stream 的
usage_sink 里有、且字段名是 DeepSeek 专属（prompt_cache_hit_tokens），MiMo 走 OpenAI 风格字段（这正是
Harness优化专项审计的 1-7 条）。如实记 None，不编一个假数字；等 1-7 修完、loop 把它透出来了再补。
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

# ── 必须在 import 任何项目模块之前设：services/agent/local_tools.py 在【模块导入时】一次性判定
#    `DESKTOP_LOCAL == "1"` 才把 read_file/write_file/edit_file/list_files/... 注册进 default_registry，
#    之后改 env 不会补注册。run_agent_loop（下面会 import）内部就 import 了 local_tools，所以这行必须
#    排在最前面。──
os.environ.setdefault("DESKTOP_LOCAL", "1")


def _load_bundled_env() -> None:
    """复刻 desktop/src/backend.js 的 `_loadBundledEnv`：解析 server/.env.bundled.local 的 KEY=VALUE
    行（# 开头/空行跳过）注入进程 env。真机由 Electron 在 spawn 子进程时做这步；直接 pytest 跑没有那层，
    这里补一次，读的是同一份内置 key 文件（本地已有、gitignored，不进仓库）。
    与 backend.js 同一优先级：内置 key 覆盖已存在的同名 env（backend.js 原话"放最前,下面的基建env仍能
    覆盖它"——即 bundled env 覆盖 process.env，但不影响我们另外单独设的 DESKTOP_LOCAL）。
    文件不存在（未配置内置 key）→ 静默跳过，交给下面的 skipif 友好跳过整份评测。"""
    env_path = Path(__file__).resolve().parent.parent / ".env.bundled.local"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, _, v = s.partition("=")
        k, v = k.strip(), v.strip()
        if k:
            os.environ[k] = v


_load_bundled_env()

import pytest  # noqa: E402

from config import settings  # noqa: E402

pytestmark = pytest.mark.skipif(
    not settings.deepseek_api_key,
    reason="无内置模型 key（server/.env.bundled.local 缺失或未配置 DEEPSEEK_API_KEY），跳过 Agent harness 评测",
)

import services.ai  # noqa: E402,F401  触发 text provider 注册（deepseek/mock/openai）
from api.v1.agent import compose_agent_system_prompt, _selected_files_note  # noqa: E402
from services.agent.context import AgentContext  # noqa: E402
from services.agent.loop import (  # noqa: E402
    run_agent_loop,
    _AUTOCOMPACT_SUMMARY_MARK,
    _MAX_SAME_CALL,
)
from services.agent.registry import general_registry  # noqa: E402

# ══════════════════════════════════════════════════════════════════════════
# 公共小工具
# ══════════════════════════════════════════════════════════════════════════

_RESULTS: list[dict] = []  # 每个任务跑完 append 一条，模块级 fixture 收尾时整体落盘成 JSON


def _system_prompt(working_dir: str = "", selected: list[str] | None = None) -> str:
    """照 api/v1/agent.py 里 /agent 端点真实拼装 system prompt 的路径来（profile/brain 留空 = 通用模式、
    不挂台球知识库——这份评测测的是"通用 Agent 默认"这条主线）。"""
    sp = compose_agent_system_prompt("", "", full_disk=False, billiards_mode=False, working_dir=working_dir)
    if selected:
        note = _selected_files_note(selected)
        if note:
            sp = sp + "\n\n" + note
    return sp


async def _do(name: str, category: str, coro) -> bool:
    """跑一个任务并记一条结果；任何意外异常都兜底记为失败，不让单个任务的报错打断整批评测、
    也不让报告写不出来（异常本身就是一种"变坏了"的信号，值得记进 JSON 而不是让 pytest 直接崩）。"""
    try:
        ok, turns, tokens_used, stopped_reason, detail = await coro
    except Exception as e:  # noqa: BLE001 — 评测容错，见上方注释
        ok, turns, tokens_used, stopped_reason, detail = False, -1, 0, "error", f"异常：{e!r}"
    _RESULTS.append({
        "name": name,
        "category": category,
        "success": ok,
        "turns": turns,
        "tokens_used": tokens_used,
        "cached_tokens": None,  # 见文件头注释：现状拿不到，如实记 None
        "stopped_reason": stopped_reason,
        "detail": detail,
    })
    return ok


@pytest.fixture(scope="module", autouse=True)
def _dump_report():
    """整个文件的测试跑完后（无论通过/失败），把 _RESULTS 汇总写到仓库外的验收报告目录。
    无 key 被 skipif 跳过时，_RESULTS 始终为空，这里直接不写文件（没什么可报的）。"""
    yield
    if not _RESULTS:
        return
    out_dir = Path.home() / "Desktop" / "球房-验收报告"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"agent-harness-eval-{datetime.now():%Y-%m-%d}.json"
    by_category: dict[str, dict] = {}
    for r in _RESULTS:
        agg = by_category.setdefault(r["category"], {"total": 0, "success": 0})
        agg["total"] += 1
        agg["success"] += int(r["success"])
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "provider": settings.effective_orchestration_provider,
        "model": settings.effective_orchestration_model,
        "total": len(_RESULTS),
        "success": sum(1 for r in _RESULTS if r["success"]),
        "by_category": by_category,
        "tasks": _RESULTS,
    }
    out_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[eval_agent_harness] 报告已写到 {out_path}")


# ══════════════════════════════════════════════════════════════════════════
# A · 工具选择正确性
# ══════════════════════════════════════════════════════════════════════════

async def _task_tool_choice_read(tmp_dir: Path):
    f = tmp_dir / "记录.txt"
    f.write_text("今天营业额是8600元，明天有个包场。", encoding="utf-8")
    ctx = AgentContext(permission_mode="auto_files", working_dir=str(tmp_dir), allowed_paths=[str(f)])
    sp = _system_prompt(working_dir=str(tmp_dir), selected=[str(f)])
    res = await run_agent_loop(
        user_message="帮我看看这个文件写了什么", registry=general_registry(), ctx=ctx,
        system_prompt=sp, max_turns=4,
    )
    calls = [s for s in res.steps if s.type == "tool_call" and s.tool_name == "read_file"]
    hit_path = any(f.name in (c.tool_args or {}).get("path", "") for c in calls)
    ok = bool(calls) and hit_path
    detail = f"read_file 调用次数={len(calls)}，路径命中={hit_path}；final前80字={res.final_text[:80]!r}"
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def _task_tool_choice_list(tmp_dir: Path):
    (tmp_dir / "menu.txt").write_text("金腿台68元", encoding="utf-8")
    (tmp_dir / "note.txt").write_text("周末满减", encoding="utf-8")
    ctx = AgentContext(permission_mode="auto_files", working_dir=str(tmp_dir))
    sp = _system_prompt(working_dir=str(tmp_dir))
    res = await run_agent_loop(
        user_message=f"帮我看看 {tmp_dir} 这个文件夹里都有哪些文件",
        registry=general_registry(), ctx=ctx, system_prompt=sp, max_turns=4,
    )
    calls = [s for s in res.steps if s.type == "tool_call" and s.tool_name == "list_files"]
    mentioned = ("menu.txt" in res.final_text) or ("note.txt" in res.final_text)
    ok = bool(calls) and mentioned
    detail = f"list_files 调用次数={len(calls)}，final 提到文件名={mentioned}；final前80字={res.final_text[:80]!r}"
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def _task_tool_choice_chitchat():
    ctx = AgentContext()
    sp = _system_prompt()
    res = await run_agent_loop(
        user_message="今天心情不错", registry=general_registry(), ctx=ctx,
        system_prompt=sp, max_turns=4,
    )
    tool_calls = [s for s in res.steps if s.type == "tool_call"]
    ok = (len(tool_calls) == 0) and (res.stopped_reason == "final")
    detail = f"工具调用数={len(tool_calls)}（应为0）；final前60字={res.final_text[:60]!r}"
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def test_tool_choice(tmp_path):
    """工具选择正确性：该调时调对（含路径对）、不该调时不瞎调。"""
    fails = []
    if not await _do("A1-读文件该调read_file", "tool_choice", _task_tool_choice_read(tmp_path / "a")):
        fails.append("A1：读文件任务没调对 read_file / 路径不对")
    if not await _do("A2-列目录该调list_files", "tool_choice", _task_tool_choice_list(tmp_path / "b")):
        fails.append("A2：列目录任务没调用 list_files / 没提到文件名")
    if not await _do("A3-纯闲聊零工具", "tool_choice", _task_tool_choice_chitchat()):
        fails.append("A3：纯闲聊却调用了工具，或没能正常收尾")
    assert not fails, "\n".join(fails)


# ══════════════════════════════════════════════════════════════════════════
# B · 多步完成度
# ══════════════════════════════════════════════════════════════════════════

async def _task_multi_step_note(tmp_dir: Path):
    ctx = AgentContext(permission_mode="auto_files", working_dir=str(tmp_dir))
    sp = _system_prompt(working_dir=str(tmp_dir))
    msg = (
        f"在 {tmp_dir} 新建一个 note.md 文件，写入三行内容：\n"
        "第一行：今天开业\n第二行：满100送10\n第三行：晚8点前有优惠\n"
        "写完之后读一遍这个文件，告诉我第二行写的是什么。"
    )
    res = await run_agent_loop(user_message=msg, registry=general_registry(), ctx=ctx,
                               system_prompt=sp, max_turns=6)
    f = tmp_dir / "note.md"
    file_ok = f.exists() and ("满100送10" in f.read_text(encoding="utf-8"))
    final_ok = "满100送10" in res.final_text
    ok = file_ok and final_ok and res.turns <= 6
    detail = f"文件存在且含第二行={file_ok}；final含第二行={final_ok}；turns={res.turns}"
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def _task_multi_step_todo(tmp_dir: Path):
    ctx = AgentContext(permission_mode="auto_files", working_dir=str(tmp_dir))
    sp = _system_prompt(working_dir=str(tmp_dir))
    phrase = "周五请助教归位"
    msg = (f"在 {tmp_dir} 建一个 todo.txt，写入一句话：'{phrase}'。"
           "写完后读一遍这个文件，告诉我写的是不是这句话，如果是就把这句话原样回给我确认。")
    res = await run_agent_loop(user_message=msg, registry=general_registry(), ctx=ctx,
                               system_prompt=sp, max_turns=6)
    f = tmp_dir / "todo.txt"
    file_ok = f.exists() and (phrase in f.read_text(encoding="utf-8"))
    final_ok = phrase in res.final_text
    ok = file_ok and final_ok and res.turns <= 6
    detail = f"文件写对={file_ok}；final原样复述={final_ok}；turns={res.turns}"
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def _task_multi_step_edit_chain(tmp_dir: Path):
    """比 note/todo 深一级：写→改→读 三个工具串联，测更长的多步链路。"""
    ctx = AgentContext(permission_mode="auto_files", working_dir=str(tmp_dir))
    sp = _system_prompt(working_dir=str(tmp_dir))
    msg = (
        f"请在 {tmp_dir} 新建一个文件 draft.txt，内容写'价格88元一小时'。"
        "写完后，把里面的『88』改成『98』。改完之后重新读一遍这个文件，告诉我现在写的是多少钱一小时。"
    )
    res = await run_agent_loop(user_message=msg, registry=general_registry(), ctx=ctx,
                               system_prompt=sp, max_turns=8)
    f = tmp_dir / "draft.txt"
    content = f.read_text(encoding="utf-8") if f.exists() else ""
    file_ok = ("98" in content) and ("88" not in content)
    final_ok = "98" in res.final_text
    ok = file_ok and final_ok and res.turns <= 8
    detail = f"文件已改成98且无88残留={file_ok}；final提到98={final_ok}；turns={res.turns}"
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def test_multi_step(tmp_path):
    """多步完成度：建文件→读回 / 建文件→改→读回 这类任务，真做完 + 真做对，且轮数不离谱。"""
    fails = []
    if not await _do("B1-新建三行读第二行", "multi_step", _task_multi_step_note(tmp_path / "a")):
        fails.append("B1：note.md 多步任务没做完/做对")
    if not await _do("B2-新建单句读回确认", "multi_step", _task_multi_step_todo(tmp_path / "b")):
        fails.append("B2：todo.txt 多步任务没做完/做对")
    if not await _do("B3-写改读三步链", "multi_step", _task_multi_step_edit_chain(tmp_path / "c")):
        fails.append("B3：写→改→读 三步链没做完/做对")
    assert not fails, "\n".join(fails)


# ══════════════════════════════════════════════════════════════════════════
# C · 长输出完整性
# ══════════════════════════════════════════════════════════════════════════

# 常见句末标点（中英文）；结尾落在这些字符上，基本可判"这段话说完了"而非硬截断的半句。
# 注：极少数长文合理地以列表项/口号收尾、不落句末标点，会被本启发式误判——评测脚本用启发式够了，
#   真触发时人肉看一眼 JSON 里的 detail 字段即可，不必做成完美的自然语言完整性判定器。
_END_PUNCT = "。！？…”’」』)>》】.!?"


def _ends_properly(text: str) -> bool:
    t = (text or "").rstrip()
    return bool(t) and t[-1] in _END_PUNCT


async def _task_long_output_activity():
    ctx = AgentContext()
    sp = _system_prompt()
    res = await run_agent_loop(
        user_message="写一份不少于2000字的开业活动方案", registry=general_registry(), ctx=ctx,
        system_prompt=sp, max_turns=6,
    )
    n = len(res.final_text)
    ok = (n >= 1500) and _ends_properly(res.final_text) and (res.stopped_reason == "final")
    detail = f"字数={n}（要求≥1500）；结尾片段={res.final_text[-20:]!r}；stopped_reason={res.stopped_reason}"
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def _task_long_output_club():
    ctx = AgentContext()
    sp = _system_prompt()
    res = await run_agent_loop(
        user_message="写一份不少于1800字的社区读书俱乐部招募与运营方案",
        registry=general_registry(), ctx=ctx, system_prompt=sp, max_turns=6,
    )
    n = len(res.final_text)
    ok = (n >= 1300) and _ends_properly(res.final_text) and (res.stopped_reason == "final")
    detail = f"字数={n}（要求≥1300）；结尾片段={res.final_text[-20:]!r}；stopped_reason={res.stopped_reason}"
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def test_long_output():
    """长输出完整性：字数够、没被 max_tokens 腰斩成半句（SH-4 续写机制该兜住的场景）。"""
    fails = []
    if not await _do("C1-开业活动方案2000字", "long_output", _task_long_output_activity()):
        fails.append("C1：长文没达标（字数不够 / 疑似被截断 / 没正常收尾）")
    if not await _do("C2-读书俱乐部方案1800字", "long_output", _task_long_output_club()):
        fails.append("C2：长文没达标（字数不够 / 疑似被截断 / 没正常收尾）")
    assert not fails, "\n".join(fails)


# ══════════════════════════════════════════════════════════════════════════
# D · 压缩保真（autocompact 语义压缩后，早期关键事实还在不在）
# ══════════════════════════════════════════════════════════════════════════

def _long_history_with_fact(fact_user: str, fact_ack: str, filler_pairs: int = 18) -> list[dict]:
    """造一段几十条的历史，把一个关键事实埋在很早的位置，后面跟一堆无关闲聊——
    真实对话被顶到窗口边缘、autocompact 把"早期这段"压成摘要时，这个事实必须活下来。"""
    history = [
        {"role": "user", "content": "你好，我想跟你聊聊我们店最近的运营情况。"},
        {"role": "assistant", "content": "好的，你说，我随时可以帮你分析或者写点东西。"},
        {"role": "user", "content": fact_user},
        {"role": "assistant", "content": fact_ack},
    ]
    for i in range(filler_pairs):
        history.append({"role": "user", "content": f"再聊聊别的，第{i}件事：今天客流怎么样、要不要搞点活动。"})
        history.append({"role": "assistant", "content": f"关于第{i}件事，建议你再观察两天、别急着下结论。"})
    return history


# 故意把窗口设得很小，逼 autocompact 在第一轮就必然触发（不指望"几十条闲聊"自然堆到 MiMo 真实 1M 窗口——
# 那要几百条才够、评测成本太高）。这是在孤立测"压缩机制本身保不保真"，不是测"真窗口下多久触发"。
_TINY_WINDOW = dict(model_ctx_window=300, autocompact_buffer=50, autocompact_ratio=0.3, autocompact_keep=4)


async def _task_compression_store_name():
    ctx = AgentContext(**_TINY_WINDOW)
    history = _long_history_with_fact(
        "对了，我们店名字叫「老张台球俱乐部」，以后你都记住这个名字。",
        "记住了，你们店叫老张台球俱乐部。",
    )
    sp = _system_prompt()
    res = await run_agent_loop(
        user_message="提醒一下，我刚才说我们店叫什么名字？", registry=general_registry(),
        ctx=ctx, system_prompt=sp, history=history, max_turns=4,
    )
    compacted = any(_AUTOCOMPACT_SUMMARY_MARK in (m.get("content") or "") for m in res.messages)
    fact_ok = ("老张" in res.final_text) and ("台球" in res.final_text)
    ok = compacted and fact_ok
    detail = f"确实触发了autocompact={compacted}；答对店名={fact_ok}；final={res.final_text[:80]!r}"
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def _task_compression_phone():
    ctx = AgentContext(**_TINY_WINDOW)
    history = _long_history_with_fact(
        "另外记一下，我的手机号是13912345678，出啥急事直接打这个。",
        "记住了，你的手机号是13912345678。",
    )
    sp = _system_prompt()
    res = await run_agent_loop(
        user_message="麻烦提醒我一下，我前面说的手机号是多少？", registry=general_registry(),
        ctx=ctx, system_prompt=sp, history=history, max_turns=4,
    )
    compacted = any(_AUTOCOMPACT_SUMMARY_MARK in (m.get("content") or "") for m in res.messages)
    fact_ok = "13912345678" in res.final_text
    ok = compacted and fact_ok
    detail = f"确实触发了autocompact={compacted}；答对手机号={fact_ok}；final={res.final_text[:80]!r}"
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def test_compression():
    """压缩保真：故意逼 autocompact 触发，早期埋的关键事实经语义压缩摘要后还答得对。"""
    fails = []
    if not await _do("D1-压缩后记得店名", "compression", _task_compression_store_name()):
        fails.append("D1：压缩后没答对店名（要么没真触发压缩，要么摘要把事实丢了）")
    if not await _do("D2-压缩后记得手机号", "compression", _task_compression_phone()):
        fails.append("D2：压缩后没答对手机号（要么没真触发压缩，要么摘要把事实丢了）")
    assert not fails, "\n".join(fails)


# ══════════════════════════════════════════════════════════════════════════
# E · 防空转（工具注定失败时，循环正常收尾、不无限重试、把问题讲清楚）
# ══════════════════════════════════════════════════════════════════════════

async def _task_anti_spin_missing_file(tmp_dir: Path):
    missing = tmp_dir / "不存在的文件.txt"  # 故意不创建
    ctx = AgentContext(permission_mode="auto_files", working_dir=str(tmp_dir), allowed_paths=[str(missing)])
    sp = _system_prompt(working_dir=str(tmp_dir), selected=[str(missing)])
    res = await run_agent_loop(
        user_message="帮我看看这个文件里写了什么", registry=general_registry(), ctx=ctx,
        system_prompt=sp, max_turns=6,
    )
    read_calls = [s for s in res.steps if s.type == "tool_call" and s.tool_name == "read_file"]
    not_spun = len(read_calls) <= _MAX_SAME_CALL
    converged = res.stopped_reason == "final"  # 不是被 max_turns 兜底强制收尾的
    keywords = ("不存在", "没找到", "没有找到", "无法读取", "找不到")
    explained = any(k in res.final_text for k in keywords)
    ok = not_spun and converged and explained
    detail = (f"read_file 调用次数={len(read_calls)}（上限{_MAX_SAME_CALL}）；收尾方式={res.stopped_reason}；"
              f"跟用户说清了问题={explained}；final={res.final_text[:100]!r}")
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def _task_anti_spin_edit_not_found(tmp_dir: Path):
    f = tmp_dir / "价格表.txt"
    original = "金腿台 68元/小时\n"
    f.write_text(original, encoding="utf-8")
    ctx = AgentContext(permission_mode="auto_files", working_dir=str(tmp_dir), allowed_paths=[str(f)])
    sp = _system_prompt(working_dir=str(tmp_dir), selected=[str(f)])
    res = await run_agent_loop(
        user_message=f"把 {f.name} 里的『银腿台 45元/小时』改成『银腿台 50元/小时』",
        registry=general_registry(), ctx=ctx, system_prompt=sp, max_turns=6,
    )
    edit_calls = [s for s in res.steps if s.type == "tool_call" and s.tool_name == "edit_file"]
    not_spun = len(edit_calls) <= _MAX_SAME_CALL
    converged = res.stopped_reason == "final"
    unchanged = f.read_text(encoding="utf-8") == original  # 找不到要替换的内容时绝不能误改
    keywords = ("没找到", "找不到", "没有这句", "不存在", "未改动", "没有找到")
    explained = any(k in res.final_text for k in keywords)
    ok = not_spun and converged and unchanged and explained
    detail = (f"edit_file 调用次数={len(edit_calls)}（上限{_MAX_SAME_CALL}）；收尾方式={res.stopped_reason}；"
              f"文件未被误改={unchanged}；跟用户说清了问题={explained}；final={res.final_text[:100]!r}")
    return ok, res.turns, ctx.tokens_used, res.stopped_reason, detail


async def test_anti_spin(tmp_path):
    """防空转：工具注定失败（文件不存在 / 要替换的内容不存在）时，循环该收就收，不无限重试瞎打转。"""
    fails = []
    if not await _do("E1-读不存在的文件", "anti_spin", _task_anti_spin_missing_file(tmp_path / "a")):
        fails.append("E1：读不存在文件时没能正常收尾/说明白问题")
    if not await _do("E2-改不存在的文本片段", "anti_spin", _task_anti_spin_edit_not_found(tmp_path / "b")):
        fails.append("E2：编辑找不到目标文本时没能正常收尾/说明白问题/可能误改了文件")
    assert not fails, "\n".join(fails)
