#!/usr/bin/env bash
# 一条命令跑全套测试。
#   bash scripts/test.sh                # 快速门：后端pytest + 前端vitest + tsc（不花钱、不联网AI，dev运行时也安全）
#   bash scripts/test.sh --eval         # 额外跑店脑 LLM 验收（真实内置模型，慢、花钱、需 key）
# 注意：不含 next build（会和 next dev 抢 .next 缓存）；上线构建走 deploy 流程，别在这跑。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

if [ "${1:-}" = "--eval-agent" ]; then
  echo "旧 Python Agent harness 评测已退场。请改跑: cd \"$ROOT/ts\" && bun run smoke:agent-tools"
  exit 2
fi

echo "▶ 后端单测 (pytest · 快 · 无AI)"
( cd "$ROOT/server" && .venv/bin/python -m pytest -q ) || fail=1

echo ""
echo "▶ 前端单测 (vitest)"
( cd "$ROOT/web" && pnpm test ) || fail=1

echo ""
echo "▶ 前端类型检查 (tsc --noEmit)"
( cd "$ROOT/web" && npx tsc --noEmit ) && echo "tsc OK" || fail=1

if [ "${1:-}" = "--eval" ]; then
  echo ""
  echo "▶ 店脑 LLM 验收 (真实 DeepSeek · 慢 · 花钱)"
  ( cd "$ROOT/server" && .venv/bin/python -m pytest tests/eval_store_brain.py -q ) || fail=1
fi

echo ""
if [ "$fail" = "0" ]; then echo "✅ 全部通过"; else echo "❌ 有失败（见上）"; fi
exit $fail
