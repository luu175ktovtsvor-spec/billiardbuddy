# -*- coding: utf-8 -*-
"""完整真实场景测试：接 MiMo v2.5，对着项目里的「测试项目的AI Agent功能/物料」真文件夹，
给 AI 布置 10 个真实台球房老板作业，看它会不会【真的用工具去改/建文件】（不是嘴上说改了）。
每步实时写进 测试记录.md，并【重新读文件核实】是否真改。

key 走环境变量 MIMO_KEY（脚本无 key）。跑法：
    MIMO_KEY='sk-...' uv run python evals/agent_full_scenario_test.py
"""
import os
import sys
import asyncio
import hashlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DESKTOP_LOCAL", "1")

from services.ai.providers.deepseek import DeepSeekProvider  # noqa: E402
from services.agent.registry import ToolRegistry  # noqa: E402
from services.agent.local_tools import register_local_tools  # noqa: E402
from services.agent.web_tools import register_web_tools  # noqa: E402
from services.agent.context import AgentContext  # noqa: E402
from services.agent.loop import run_agent_loop  # noqa: E402

MODEL = "mimo-v2.5"
BASE = "https://api.xiaomimimo.com/v1"
PROJ = Path(__file__).resolve().parent.parent.parent  # 仓库根
TESTROOT = PROJ / "测试项目的AI Agent功能"
MAT = TESTROOT / "物料"
DOC = TESTROOT / "测试记录.md"


def _provider():
    return DeepSeekProvider(api_key=os.environ["MIMO_KEY"], base_url=BASE, default_model=MODEL)


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return ""


def _snapshot() -> dict:
    snap = {}
    for p in MAT.rglob("*"):
        if p.is_file():
            snap[str(p.relative_to(TESTROOT))] = hashlib.md5(p.read_bytes()).hexdigest()
    return snap


def _changed(before: dict, after: dict) -> list:
    out = []
    for k, v in after.items():
        if k not in before:
            out.append(f"➕新建 {k}")
        elif before[k] != v:
            out.append(f"✏️改动 {k}")
    return out


SYS = (
    "你是台球房老板的桌面 AI 助手，在老板自己的电脑上运行，已开启「完全访问模式」。"
    "你有一整套工具能直接动老板电脑上的文件：list_files 列目录、find_files 按名字找、search_in_files 按内容搜、"
    "read_file 读、write_file 写新文件、edit_file 改文本某段、edit_excel 改 Excel 单元格、run_command 跑命令、"
    "web_search 上网搜、web_fetch 抓网页、todo_write 列任务清单、run_subagent 把大子任务交分身。"
    "老板让你处理文件时，就【真的去调用工具读和改】，不要只在嘴上说做了。改文件前先 read_file 看清内容。"
    "用大白话回复，简洁。"
)


def _ctx():
    return AgentContext(full_disk_access=True, permission_mode="full", auto_spend_limit=-1,
                        allowed_paths=[str(TESTROOT)])


async def run_job(p, reg, n, title, request, verify):
    before = _snapshot()
    try:
        res = await run_agent_loop(user_message=request, registry=reg, ctx=_ctx(),
                                   system_prompt=SYS, provider=p, model=MODEL, max_turns=8, max_tokens=3000)
        final = res.final_text or ""
        called = [s.tool_name for s in res.steps if s.type == "tool_call"]
    except Exception as e:
        final, called = f"(循环抛错: {e!r})", []
    after = _snapshot()
    changed = _changed(before, after)
    try:
        ok, detail = verify(final, called, changed)
    except Exception as e:
        ok, detail = False, f"验证抛错 {e!r}"
    # 实时追加进文档
    block = (
        f"\n## 作业 {n}：{title}\n\n"
        f"- **给它的任务**：{request}\n"
        f"- **它实际调用的工具**：{' → '.join(called) if called else '（没调工具）'}\n"
        f"- **文件实际变化（重新扫物料夹得出）**：{('、'.join(changed)) if changed else '（无文件变化）'}\n"
        f"- **复核结论**：{'✅ 通过' if ok else '❌ 未达预期'}（{detail}）\n"
        f"- **它的答复**：{final[:200].strip()}\n"
    )
    with open(DOC, "a", encoding="utf-8") as f:
        f.write(block)
    print(f"{'✅' if ok else '❌'} 作业{n} {title} | 工具={called} | 文件变化={changed} | {detail}")
    return ok


async def main():
    p = _provider()
    reg = ToolRegistry()
    register_local_tools(reg)
    register_web_tools(reg)
    tools = sorted(s["function"]["name"] for s in reg.to_openai_tools())

    # 文档开头
    DOC.write_text(
        "# AI Agent 真实场景测试记录\n\n"
        f"> **模型：MiMo v2.5（真实调用，非模拟）** ｜ 全程对着本项目 `测试项目的AI Agent功能/物料/` 真文件夹操作。\n"
        f"> 已装工具（共{len(tools)}个）：{', '.join(tools)}\n"
        "> 每条作业都：① 给它真实任务 → ② 记它实际调了哪些工具 → ③ 重新扫物料夹看哪些文件真变了 → ④ 复核是否达预期。\n",
        encoding="utf-8")

    md = MAT / "活动想法草稿.md"
    xlsx = MAT / "6月营业额.xlsx"

    jobs = [
        ("列目录看有啥",
         f"看看 {MAT} 这个文件夹里都有哪些文件",
         lambda f, c, ch: ("活动" in f or "营业额" in f or "list_files" in c or "find_files" in c, "答复/调用含列目录")),
        ("读并真改活动草稿",
         f"读一下 {md} 这份活动草稿，里面『充500送200』力度太大，帮我改成『充500送100』",
         lambda f, c, ch: ("充500送100" in _read(md) and "充500送200" not in _read(md), f"草稿现含充500送100={'充500送100' in _read(md)}")),
        ("读Excel写诊断小结",
         f"看一下 {xlsx} 这张营业额表，简单说说这几天生意怎么样，把结论写进一个新文件 {MAT/'诊断小结.md'}",
         lambda f, c, ch: ((MAT/'诊断小结.md').exists() and len(_read(MAT/'诊断小结.md')) > 20, f"诊断小结.md存在={ (MAT/'诊断小结.md').exists() }")),
        ("分析会员名单",
         f"读 {MAT/'会员名单.txt'}，告诉我谁是大客户、谁可能快流失了",
         lambda f, c, ch: ("王五" in f and ("赵六" in f or "流失" in f), "答复点出大客户/流失客")),
        ("真建会员分级Excel",
         f"新建一张 Excel：{MAT/'会员分级.xlsx'}，把 {MAT/'会员名单.txt'} 里的4个人按充值金额分成 高/中/低 三档列进去",
         lambda f, c, ch: ((MAT/'会员分级.xlsx').exists(), f"会员分级.xlsx存在={ (MAT/'会员分级.xlsx').exists() }")),
        ("真改营业额表加一行",
         f"在 {xlsx} 营业额表最后加一行数据：日期6-15，营业额7000，客流95，新增会员6",
         lambda f, c, ch: (any('6月营业额' in x for x in ch), f"6月营业额.xlsx被改={any('6月营业额' in x for x in ch)}")),
        ("跑命令数文件",
         f"用一条命令数一下 {MAT} 文件夹里现在有几个文件",
         lambda f, c, ch: ("run_command" in c, "确实调了run_command")),
        ("上网搜思路",
         "上网搜一下『台球房周末怎么聚人气、搞什么活动』，给我两三条可落地的思路",
         lambda f, c, ch: ("web_search" in c or "web_fetch" in c, "调了网搜/抓网页(联网可能被限)")),
        ("多步任务先列清单",
         f"帮我策划一个周末引流活动：先把要做的几步列成任务清单，然后把完整活动方案写进新文件 {MAT/'周末活动方案.md'}",
         lambda f, c, ch: ((MAT/'周末活动方案.md').exists(), f"周末活动方案.md存在={ (MAT/'周末活动方案.md').exists() }")),
        ("派子代理做独立小任务",
         "把『给我这家台球房想一句抖音引流的爆款标题』这个独立小任务，交给一个分身去专门做，把结果拿回来给我",
         lambda f, c, ch: ("run_subagent" in c or len(f) > 5, "调了子代理或给出标题")),
    ]

    results = []
    for i, (title, req, verify) in enumerate(jobs, 1):
        results.append((title, await run_job(p, reg, i, title, req, verify)))

    passed = sum(1 for _, ok in results if ok)
    summary = (
        f"\n---\n\n## 总结\n\n**{passed}/{len(results)} 项达预期。** 逐项：\n\n"
        + "\n".join(f"- {'✅' if ok else '❌'} 作业{i}：{t}" for i, (t, ok) in enumerate(results, 1))
        + f"\n\n所有改动均为 MiMo v2.5 真实调用工具产生，文件变化经重新扫描物料夹核实（非模型口头声称）。\n"
    )
    with open(DOC, "a", encoding="utf-8") as f:
        f.write(summary)
    print(f"\n===== {passed}/{len(results)} 达预期，记录已写入 {DOC} =====")


if __name__ == "__main__":
    asyncio.run(main())
