#!/bin/bash
set -e
echo "=== 球房 AI 运营助手 - 部署脚本 ==="
cd /var/www/billiards-ai
echo "[1/5] git pull..."
git pull origin main
echo "[2/5] 安装后端依赖..."
cd server && /root/.local/bin/uv sync && cd ..
echo "[3/5] 重启后端..."
systemctl restart billiards-backend
echo "[4/5] 构建前端..."
cd web && npx next build && cd ..
echo "[5/5] 部署前端..."
cd web && mkdir -p .next/standalone/.next && cp -r .next/static .next/standalone/.next/static && cd ..
systemctl restart billiards-frontend
echo "=== 部署完成 ==="
