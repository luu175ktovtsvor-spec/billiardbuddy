#!/usr/bin/env bash
# 桌面版本地试用一键启动（Mac/本地 dev）。
# 自动配好桌面必需的环境变量（DESKTOP_LOCAL / BYOK_ENCRYPT_KEY / SQLite），起后端 + 前端。
#
# 用法：
#   bash scripts/dev-desktop.sh
# 然后：
#   · 快速试核心功能（聊天/写文案/诊断/成本/BYOK 配置）→ 浏览器开 http://localhost:3000
#   · 试完整桌面功能（改文件/发布等，需 Electron）→ 另开一个终端：cd desktop && npm install && npm run dev
#
# 退出：Ctrl+C（会一并关掉后端）。

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 本机 BYOK 主密钥（加密老板自带的大模型 key，只在你这台机器用；首次生成后存下复用，不进 git）
KEY_FILE="$ROOT/.dev-byok-key"
if [ ! -f "$KEY_FILE" ]; then
  ( cd server && uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" ) > "$KEY_FILE"
  echo "已生成本机 BYOK 主密钥 → $KEY_FILE（仅本机用、不进 git）"
fi
BYOK_KEY="$(cat "$KEY_FILE")"

# 关后端：脚本退出时一并关
cleanup() { [ -n "$BACK_PID" ] && kill "$BACK_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "▶ 启动后端（桌面本地模式 · SQLite）…"
(
  cd server
  DESKTOP_LOCAL=1 \
  BYOK_ENCRYPT_KEY="$BYOK_KEY" \
  SECRET_KEY="dev-local-secret-change-in-prod" \
  DATABASE_URL="sqlite+aiosqlite:///$ROOT/server/billiards_local.db" \
  uv run uvicorn main:app --host 127.0.0.1 --port 8000
) &
BACK_PID=$!

# 等后端就绪
echo "  等后端起来…"
until curl -s http://127.0.0.1:8000/api/v1/health >/dev/null 2>&1; do sleep 1; done
echo "  ✓ 后端就绪 http://127.0.0.1:8000"

echo "▶ 启动前端（localhost:3000）…"
echo ""
echo "  ┌────────────────────────────────────────────────┐"
echo "  │ 浏览器试核心功能： http://localhost:3000          │"
echo "  │ 试完整桌面（改文件/发布）：另开终端 cd desktop && npm run dev │"
echo "  └────────────────────────────────────────────────┘"
echo ""
cd web
NEXT_PUBLIC_API_URL=http://localhost:8000 pnpm dev
