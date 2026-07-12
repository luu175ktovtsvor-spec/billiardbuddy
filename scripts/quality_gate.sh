#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-full}"

if [[ "$MODE" != "full" && "$MODE" != "--quick" ]]; then
  echo "用法: bash scripts/quality_gate.sh [--quick]" >&2
  exit 2
fi

echo "[1/8] 工程 Skill"
bun "$ROOT/scripts/quality/validate-skills.ts"

echo "[2/8] GitHub 工作流"
bun "$ROOT/scripts/quality/check-workflows.ts"

echo "[3/8] 密钥误提交"
bun "$ROOT/scripts/quality/check-secrets.ts"

echo "[4/8] 模块边界"
bun "$ROOT/scripts/quality/check-architecture.ts"

echo "[5/8] TypeScript 类型"
(cd "$ROOT/ts" && bun run typecheck)

echo "[6/8] TS 全量测试"
(cd "$ROOT/ts" && bun test)

echo "[7/8] gateway / relay / dataeye 测试"
(cd "$ROOT" && bun test gateway/app.test.ts relay/app.test.ts dataeye/tests/receiver.test.ts dataeye/tests/board.test.ts)

if [[ "$MODE" == "full" ]]; then
  echo "[8/8] React 与 Electron 构建"
  (cd "$ROOT/ts" && bun run ui:build && bun run desktop:build)
else
  echo "[8/8] --quick: 跳过 React 与 Electron 构建"
fi

git -C "$ROOT" diff --check
echo "质量门通过"
