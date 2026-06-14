#!/bin/bash
set -e
echo "=== 球房 AI 运营助手 - 部署脚本 ==="
cd /var/www/billiards-ai

echo "[1/6] git pull..."
git pull origin main

echo "[2/6] 安装后端依赖..."
cd server && /root/.local/bin/uv sync && cd ..

echo "[3/6] 数据库迁移..."
cd server && /root/.local/bin/uv run alembic upgrade head && cd ..

echo "[4/6] 重启后端..."
systemctl restart billiards-backend

echo "[5/6] 构建前端 + 拷贝 standalone 静态资源..."
# ⚠️ standalone 模式坑：next build 不会把 static/public 放进 .next/standalone，且会清掉上次拷进去的。
# 必须重新拷贝，否则 nginx 把 /_next/static 转给 server.js 时找不到文件 → 所有 JS/CSS 返回 HTTP 400 → 整站白屏。
# （2026-06-15 就因手动 build 漏了这步导致生产白屏。所以这条统一进脚本，别再手动分步。）
cd web
npx next build --no-lint
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
cd ..
systemctl restart billiards-frontend

echo "[6/6] 冒烟自检（systemctl active 会骗人，必须真测线上）..."
sleep 4
BE=$(curl -s -o /dev/null -w "%{http_code}" https://zzyppz.cn/api/v1/quota || echo 000)
echo "  后端 /api/v1/quota -> $BE (期望 401)"
if [ "$BE" = "000" ] || [ "${BE:0:1}" = "5" ]; then
  echo "  !!! 后端异常（$BE）：可能 import 失败/起不来，查 journalctl -u billiards-backend -n 50 !!!"
  exit 1
fi
CHUNK=$(curl -s https://zzyppz.cn/login | grep -oE '/_next/static/chunks/[^"]+\.js' | head -1)
if [ -z "$CHUNK" ]; then
  echo "  !!! 没从 /login 抓到前端静态 chunk，前端可能没正常起，请手动检查 !!!"
  exit 1
fi
FE=$(curl -s -o /dev/null -w "%{http_code}" "https://zzyppz.cn$CHUNK" || echo 000)
echo "  前端静态 $CHUNK -> $FE (期望 200)"
if [ "$FE" != "200" ]; then
  echo "  !!! 前端静态返回 $FE 不是 200：standalone static 没拷好，站点会白屏！部署失败 !!!"
  exit 1
fi

echo "=== 部署完成，冒烟通过（后端 $BE / 前端静态 $FE）==="
