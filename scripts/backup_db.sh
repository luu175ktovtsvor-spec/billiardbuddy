#!/usr/bin/env bash
# 每日数据库备份:pg_dump 压缩到 /var/backups/billiards,保留最近 7 天。
# 安装(服务器上执行一次,deploy 不会自动装 cron):
#   chmod +x /var/www/billiards-ai/scripts/backup_db.sh
#   (crontab -l 2>/dev/null | grep -v backup_db.sh; \
#    echo "30 4 * * * bash /var/www/billiards-ai/scripts/backup_db.sh >> /var/log/billiards-backup.log 2>&1") | crontab -
# 恢复:
#   gunzip -c /var/backups/billiards/billiards_ai_YYYY-MM-DD.sql.gz | \
#     PGPASSWORD=billiards123 psql -U billiards -h localhost billiards_ai
set -euo pipefail

BACKUP_DIR=/var/backups/billiards
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%F)

export PGPASSWORD=billiards123
pg_dump -U billiards -h localhost billiards_ai | gzip > "$BACKUP_DIR/billiards_ai_${STAMP}.sql.gz"

# 轮转:只清理本目录下 7 天前的备份文件,不触碰其他任何路径
find "$BACKUP_DIR" -name "billiards_ai_*.sql.gz" -mtime +7 -delete

echo "[$(date '+%F %T')] backup ok: billiards_ai_${STAMP}.sql.gz ($(du -h "$BACKUP_DIR/billiards_ai_${STAMP}.sql.gz" | cut -f1))"
