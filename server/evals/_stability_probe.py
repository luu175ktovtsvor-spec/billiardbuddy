# -*- coding: utf-8 -*-
"""临时稳定性探针：对易偏离场景各跑N次，量化 DeepSeek 对北极星铁律的遵循稳定性。
用完即删（结论存 docs/test-runs）。回答："97.5%是单次快照，真实稳定质量如何？模型违反铁律多频繁？"
"""
import asyncio
import os
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from evals.run_northstar_eval import load_materials, run_scene  # noqa: E402

N = 6
TARGETS = ["activity_009", "diagnosis_012", "customer_pricing_001", "customer_pricing_009"]


async def main():
    from evals.run_northstar_eval import _GEN_MODEL as _GM
    label = _GM or os.environ.get("GEN_MODEL") or "deepseek-v4-flash(默认)"
    _, preds, scenes = load_materials(None)
    tmap = {s["id"]: s for s in scenes}
    sem = asyncio.Semaphore(3)
    print(f"[生成模型] {label}　[裁判固定] deepseek-v4-flash")
    print(f"稳定性探针：每个场景跑 {N} 次\n")
    for sid in TARGETS:
        s = tmap.get(sid)
        if not s:
            print(sid, "NOT FOUND")
            continue
        results = await asyncio.gather(*[run_scene(s, preds, sem, True) for _ in range(N)])
        grades = [r.get("grade") for r in results]
        scores = [r.get("judge_score") for r in results]
        print(f"== {sid} ({s.get('generator')}) ==")
        print(f"   {dict(Counter(grades))}  judge分数={scores}")
        for r in results:
            if r.get("grade") in ("YELLOW", "RED"):
                print(f"   ↳[{r['grade']}/{r.get('judge_score')}] {str(r.get('judge_reason',''))[:110]}")
        print()


if __name__ == "__main__":
    asyncio.run(main())
