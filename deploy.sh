#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== 球房 AI 运营助手 部署脚本 ==="

# Check root .env (for docker-compose)
if [ ! -f .env ]; then
    echo "错误: .env 不存在"
    echo "请复制 .env.docker.example 为 .env 并填写实际值"
    exit 1
fi

# Check server .env (for FastAPI backend)
if [ ! -f server/.env ]; then
    echo "错误: server/.env 不存在"
    echo "请复制 server/.env.production.example 为 server/.env 并填写实际值"
    exit 1
fi

echo "[1/4] 构建镜像..."
docker compose build

echo "[2/4] 启动服务..."
docker compose up -d

echo "[3/4] 等待数据库就绪..."
for i in $(seq 1 30); do
    if docker compose exec -T postgres pg_isready -U billiards > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

echo "[4/4] 执行数据库迁移..."
docker compose exec backend uv run alembic upgrade head

echo ""
echo "=== 部署完成 ==="
echo "前端: http://localhost"
echo "后端 API: http://localhost/api/v1"
echo ""
echo "下一步："
echo "  1. 配置域名解析（A 记录指向 ECS 公网 IP）"
echo "  2. 修改 nginx/nginx.conf 中的 server_name 为你的域名"
echo "  3. 运行 certbot 配置 SSL 证书"
echo "  详细步骤请参考 docs/deployment/deployment.md"
