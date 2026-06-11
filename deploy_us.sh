#!/bin/bash
set -e
echo "=== 球房 AI 运营助手 - 部署脚本 ==="
cd /var/www/billiards-ai
echo "[1/5] git pull..."
git pull origin main
echo "[2/5] 安装后端依赖..."
cd server && /root/.local/bin/uv sync && cd ..
echo "[3/5] 数据库迁移..."
cd server && /root/.local/bin/uv run alembic upgrade head && cd ..
echo "[4/5] 重启后端..."
systemctl restart billiards-backend
echo "[5/5] 构建前端（真实执行 next build，旧版只拷贝旧产物会上线旧前端）..."
cd web && npx next build --no-lint && cp -r .next/static .next/standalone/.next/static && cd ..
systemctl restart billiards-frontend
echo "=== 部署完成 ==="
