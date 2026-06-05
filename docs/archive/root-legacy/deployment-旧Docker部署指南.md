# 部署指南

## 架构概览

单服务器部署方案：

```
用户 → 域名 → ECS → Nginx(:80/:443)
                      ├─ /api/* → FastAPI Backend (:8000)
                      ├─ /*     → Next.js Frontend (:3000)
                      └─ PostgreSQL (:5432)
```

所有服务通过 Docker Compose 管理。

## 前置条件

- 阿里云 ECS 实例（推荐 2核4G 起步）
- 已安装 Docker 和 Docker Compose
- 域名（阿里云域名服务购买，或已有域名解析到 ECS 公网 IP）

## 部署步骤

### 1. 上传代码到服务器

```bash
# 方式 A：Git 拉取（推荐）
ssh root@YOUR_ECS_IP
cd /opt
git clone YOUR_REPO_URL billiards-ai
cd billiards-ai

# 方式 B：SCP 上传
scp -r . root@YOUR_ECS_IP:/opt/billiards-ai
```

### 2. 配置环境变量

```bash
cd /opt/billiards-ai
cp server/.env.production.example server/.env
```

编辑 `server/.env`，填写：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接串，Docker 内用 `postgres` 作主机名 |
| `SECRET_KEY` | 随机字符串，至少32位。可用 `openssl rand -hex 32` 生成 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `CORS_ORIGINS` | 生产域名，如 `https://your-domain.com` |

同时创建根目录 `.env`（Docker Compose 用）：

```bash
cat > .env << 'EOF'
POSTGRES_USER=billiards
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_DB=billiards_ai
EOF
```

> 注意：`server/.env` 中的 `DATABASE_URL` 密码要和根目录 `.env` 中的 `POSTGRES_PASSWORD` 一致。

### 3. 一键部署

```bash
./deploy.sh
```

或手动执行：

```bash
docker compose build
docker compose up -d
docker compose exec backend uv run alembic upgrade head
```

### 4. 验证

```bash
# 检查所有服务运行状态
docker compose ps

# 测试后端
curl http://localhost/api/v1/health

# 测试前端
curl -I http://localhost
```

## 域名与 SSL

### 5. 配置域名解析

在阿里云域名控制台，添加 A 记录：

| 记录类型 | 主机记录 | 记录值 |
|---------|---------|--------|
| A | @ | ECS 公网 IP |
| A | www | ECS 公网 IP |

### 6. 配置 SSL 证书

使用 Let's Encrypt 免费证书：

```bash
# 安装 certbot
apt install -y certbot python3-certbot-nginx

# 先临时启动 nginx（仅 HTTP）让 certbot 验证域名
# 编辑 nginx/nginx.conf，将 server_name _ 改为你的域名
# 重启 nginx
docker compose restart nginx

# 获取证书
certbot certonly --webroot \
  -w /var/www/certbot \
  -d your-domain.com \
  -d www.your-domain.com

# 证书会保存在 /etc/letsencrypt/live/your-domain.com/
```

然后在 `nginx/nginx.conf` 中取消 HTTPS server 块的注释，将 `your-domain.com` 替换为实际域名。

```bash
docker compose restart nginx
```

### 7. 自动续期

Let's Encrypt 证书有效期 90 天，添加自动续期：

```bash
echo "0 3 * * * certbot renew --quiet && docker compose restart nginx" | crontab -
```

## 常用运维命令

```bash
# 查看日志
docker compose logs -f backend
docker compose logs -f frontend

# 重启服务
docker compose restart

# 更新代码后重新部署
git pull
docker compose build backend frontend
docker compose up -d

# 数据库备份
docker compose exec postgres pg_dump -U billiards billiards_ai > backup_$(date +%Y%m%d).sql

# 数据库恢复
cat backup.sql | docker compose exec -T postgres psql -U billiards billiards_ai
```

## 故障排查

| 问题 | 排查 |
|------|------|
| 前端无法访问 | `docker compose ps` 看 frontend 是否运行；`docker compose logs frontend` |
| API 502 | backend 未启动或未健康；`docker compose logs backend` |
| SSE 流式中断 | nginx 缺少 `proxy_buffering off` 配置 |
| 数据库连接失败 | 检查 `DATABASE_URL` 中的密码与 `POSTGRES_PASSWORD` 是否一致 |
| SSL 证书失败 | 域名解析未生效（DNS 传播需几分钟） |

## 文件说明

| 文件 | 用途 |
|------|------|
| `server/Dockerfile` | 后端镜像构建 |
| `web/Dockerfile` | 前端镜像构建（standalone 模式） |
| `docker-compose.yml` | 服务编排 |
| `nginx/nginx.conf` | Nginx 反向代理配置 |
| `deploy.sh` | 一键部署脚本 |
| `server/.env.production.example` | 生产环境配置模板 |
