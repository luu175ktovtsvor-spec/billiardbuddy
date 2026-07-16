#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-full}"

if [[ "$MODE" != "full" && "$MODE" != "--quick" ]]; then
  echo "用法: bash scripts/quality_gate.sh [--quick]" >&2
  exit 2
fi

# ts/ 已整体是导入的 CC-Haha 内核,其真实验证入口是自带的 check:* 命令(cc-haha CI 也用它们),
# 而非旧台球产品的 typecheck/ui:build/desktop:build。这里的 ts 步骤统一指向 cc-haha 的真实命令。
echo "[1/8] 工程 Skill"
bun "$ROOT/scripts/quality/validate-skills.ts"

echo "[2/8] GitHub 工作流"
bun "$ROOT/scripts/quality/check-workflows.ts"

echo "[3/8] 密钥误提交"
bun "$ROOT/scripts/quality/check-secrets.ts"

echo "[4/8] 模块边界"
bun "$ROOT/scripts/quality/check-architecture.ts"

echo "[5/8] 后端 server/tools/utils 测试 (check:server)"
(cd "$ROOT/ts" && bun run check:server)

echo "[6/8] Electron 桌面宿主检查:tsc + 测试 + 主进程构建 (check:electron)"
(cd "$ROOT/ts" && bun run check:electron)

echo "[7/8] gateway / relay / dataeye 测试"
(cd "$ROOT" && bun test gateway/*.test.ts relay/*.test.ts dataeye/tests/receiver.test.ts dataeye/tests/board.test.ts)

if [[ "$MODE" == "full" ]]; then
  echo "[8/8] React renderer 生产构建 (check:desktop)"
  (cd "$ROOT/ts" && bun run check:desktop)
else
  echo "[8/8] --quick: 跳过 React renderer 构建"
fi

git -C "$ROOT" diff --check
echo "质量门通过"
