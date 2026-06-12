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
# standalone 模式必须手动拷贝 static 与 public(manifest.json 等),否则 404
cd web && npx next build --no-lint && cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public && cd ..
systemctl restart billiards-frontend
echo "=== 部署完成 ==="
