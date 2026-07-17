#!/usr/bin/env bash
set -euo pipefail

# BilliardBuddy 顶层质量门。三档：
#   --quick    结构 + 产品外层离线检查（秒级，单模块开发/中间提交自检）
#   (默认)     集成门：叠加 CC-Haha 原生离线 lane（check:server/electron/desktop），干净基线稳定 exit 0
#   --release  发布门：叠加原生打包 + package smoke；live 冒烟必须 --allow-live 显式开启
#
# 原则：默认完全离线、确定性、可重复；顶层只组合调用 CC-Haha 原生入口(bun run check:*) 与
# BilliardBuddy 外层检查(scripts/quality/*)，不重复实现原生 runner；付费/live 请求只在显式开启时发生。

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

MODE="full"
ALLOW_LIVE=0
for arg in "$@"; do
  case "$arg" in
    --quick) MODE="quick" ;;
    --release) MODE="release" ;;
    full) MODE="full" ;;
    --allow-live) ALLOW_LIVE=1 ;;
    *) echo "用法: bash scripts/quality_gate.sh [--quick|--release] [--allow-live]" >&2; exit 2 ;;
  esac
done

echo "==== 质量门 mode=$MODE allow-live=$ALLOW_LIVE ===="

# ---- 所有档位共有：BilliardBuddy 外层静态检查（快、离线、只读）----
echo "[gate:$MODE] 工程 Skill 语义校验"
bun "$ROOT/scripts/quality/validate-skills.ts"
echo "[gate:$MODE] GitHub 工作流引用校验（package script 必须真实存在）"
bun "$ROOT/scripts/quality/check-workflows.ts"
echo "[gate:$MODE] 密钥误提交扫描"
bun "$ROOT/scripts/quality/check-secrets.ts"
echo "[gate:$MODE] 架构边界（真实 renderer ts/desktop/src）"
bun "$ROOT/scripts/quality/check-architecture.ts"

# ---- 所有档位共有：产品外层服务测试（离线，注入 fake upstream，确定性）----
echo "[gate:$MODE] gateway / relay 测试"
(cd "$ROOT" && bun test gateway/*.test.ts relay/*.test.ts)

if [[ "$MODE" == "quick" ]]; then
  git -C "$ROOT" diff --check
  echo "[gate:quick] 通过：结构 + 产品外层离线检查。单模块聚焦回归请直接跑 check:server / check:desktop / check:electron。"
  exit 0
fi

# ---- 集成 / 发布档：叠加 CC-Haha 原生离线 lane ----
echo "[gate:$MODE] CC-Haha 后端离线测试 (check:server)"
(cd "$ROOT/ts" && bun run check:server)
echo "[gate:$MODE] CC-Haha Electron 宿主检查 (check:electron)"
(cd "$ROOT/ts" && bun run check:electron)
echo "[gate:$MODE] React renderer 生产构建 (check:desktop)"
(cd "$ROOT/ts" && bun run check:desktop)
if [[ -d "$ROOT/ts/adapters/node_modules" ]]; then
  echo "[gate:$MODE] IM 适配器测试 (check:adapters)"
  (cd "$ROOT/ts" && bun run check:adapters)
else
  echo "[gate:$MODE] 跳过 check:adapters（ts/adapters/node_modules 未安装；触碰适配器时先 cd ts/adapters && bun install）"
fi

git -C "$ROOT" diff --check

if [[ "$MODE" == "full" ]]; then
  echo "[gate:full] 集成质量门通过（全部离线、确定性）。"
  exit 0
fi

# ---- 发布档：叠加原生打包 + package smoke（离线）；live 冒烟必须显式开启 ----
echo "[gate:release] CC-Haha 原生打包与 package smoke (check:native)"
(cd "$ROOT/ts" && bun run check:native)

if [[ "$ALLOW_LIVE" == "1" ]]; then
  echo "[gate:release] live 冒烟（已显式开启）：CC-Haha provider/desktop smoke"
  (cd "$ROOT/ts" && bun run quality:smoke)
  echo "[gate:release] 提示：网关/语音/图片与真机 Agent 工具循环 live 冒烟、服务器健康/部署/回滚验证需各自凭据与真机，按 docs/工程质量标准.md 手动执行。"
else
  echo "[gate:release] 跳过 live 冒烟（默认离线）；加 --allow-live 且配置凭据后才产生付费请求。"
fi

echo "[gate:release] 发布质量门通过（离线打包 + package smoke$([[ "$ALLOW_LIVE" == "1" ]] && echo " + live smoke")）。"
