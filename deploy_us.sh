#!/bin/bash
set -e
echo "=== 球房 AI 运营助手 - 部署脚本 ==="
cd /var/www/billiards-ai
echo "[1/4] git pull..."
git pull origin main
echo "[2/4] 安装后端依赖..."
cd server && /root/.local/bin/uv sync && cd ..
echo "[3/4] 重启后端..."
systemctl restart billiards-backend
echo "[4/4] 构建前端..."
cd web && cp -r .next/static .next/standalone/.next/static && cd ..
systemctl restart billiards-frontend
echo "=== 部署完成 ==="
