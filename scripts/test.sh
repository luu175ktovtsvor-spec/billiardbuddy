#!/usr/bin/env bash
# 一条命令跑 TS 内核快速门(不花钱、不联网 AI):bun test + typecheck。
# 老 Python 线(server/)与老 web/ 前端已退役,当前唯一的代码栈是 ts/。
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

echo "▶ TS 内核单测 (cd ts && bun test)"
( cd "$ROOT/ts" && bun test ) || fail=1

echo ""
echo "▶ TS 类型检查 (bun run typecheck)"
( cd "$ROOT/ts" && bun run typecheck ) && echo "typecheck OK" || fail=1

echo ""
if [ "$fail" = "0" ]; then echo "✅ 全部通过"; else echo "❌ 有失败（见上）"; fi
exit $fail
