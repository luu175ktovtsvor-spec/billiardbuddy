# dataeye 部署 Runbook(国内 app 机)

> 📌 一步步照做的部署清单。目标机:国内 app/staging 服务器(Postgres 18、Ubuntu、阿里云 ECS)。
> 真实 IP/密码从服务器 `gw.env` 或密码管理器取,本文档一律用 `<占位>`,不写明文。
> 当前部署步骤以本目录配置和服务文件为准。

全程在服务器上以 root 执行(或有 sudo 权限的账号)。

---

## 0. 前置:把代码传到服务器

```bash
# 本地打包 dataeye/ 目录,scp 到服务器 /opt/dataeye
scp -r dataeye/ root@<app机IP>:/opt/dataeye
```

---

## 1. 挂大数据盘

在云服务商控制台(阿里云 ECS)给这台机器新挂一块**空白**云盘,确认挂上后:

```bash
lsblk                       # 找到新盘盘符,如 /dev/vdb(千万别搞错成系统盘 /dev/vda)
cd /opt/dataeye/deploy
sudo ./mount-data-disk.sh /dev/vdb     # !! 会格式化该盘,脚本内有二次确认,先读脚本头部警告 !!
```

跑完确认:

```bash
df -h /data
ls /data          # 应该能看到 transcripts/ pg/
```

---

## 2. PG 建库 + 建用户 + 建表

```bash
sudo -u postgres psql -c "CREATE DATABASE dataeye;"
sudo -u postgres psql -c "CREATE USER dataeye WITH PASSWORD '<从密码管理器取,生成一个强密码>';"
sudo -u postgres psql -c "GRANT ALL ON DATABASE dataeye TO dataeye;"

# 建六模块表(幂等,IF NOT EXISTS,可重复跑)
sudo -u postgres psql -d dataeye -f /opt/dataeye/sql/schema.sql
```

可选:让大表落大盘(而不是系统盘的默认 PG 数据目录):

```bash
mkdir -p /data/pg && chown postgres:postgres /data/pg
sudo -u postgres psql -c "CREATE TABLESPACE dataeye_ts LOCATION '/data/pg';"
# 之后新建表可指定 TABLESPACE dataeye_ts,或迁移现有表:
#   ALTER TABLE raw_inbox SET TABLESPACE dataeye_ts;（数据量大时会锁表一阵,挑低峰跑)
```

确认 PG 只监听本地、不对公网开 5432:

```bash
grep listen_addresses /etc/postgresql/*/main/postgresql.conf   # 应为 'localhost' 或 '127.0.0.1'
```

---

## 3. 准备 Bun 运行时

```bash
bun --version
# 如果服务器还没装 Bun,先按官方脚本安装到运行用户环境,并确认 systemd 能找到 bun:
#   curl -fsSL https://bun.sh/install | bash
#   ln -sf /root/.bun/bin/bun /usr/local/bin/bun
```

---

## 4. 装 systemd 服务

```bash
cp /opt/dataeye/deploy/dataeye-receiver.service /etc/systemd/system/dataeye-receiver.service
# 编辑该文件,把 <令牌1,令牌2> <db密码> <运行用户> 三处占位换成真实值:
#   - INGEST_TOKENS:给每台/每批客户端发一个令牌,逗号分隔;要吊销某台机器直接从这里删掉对应令牌再 restart
#   - PGDSN:postgresql://dataeye:<第2步设的密码>@127.0.0.1/dataeye
#   - User:建议新建一个不能登录 shell 的系统用户跑这个服务,而不是 root
vim /etc/systemd/system/dataeye-receiver.service

systemctl daemon-reload
systemctl enable --now dataeye-receiver
systemctl is-active dataeye-receiver     # 应输出 active
journalctl -u dataeye-receiver -n 50 --no-pager   # 看启动日志有没有报错

cp /opt/dataeye/deploy/dataeye-board.service /etc/systemd/system/dataeye-board.service
# 编辑该文件,把 <db密码> <运行用户> 两处占位换成真实值;PGDSN 与 receiver 保持同库。
vim /etc/systemd/system/dataeye-board.service

systemctl daemon-reload
systemctl enable --now dataeye-board
systemctl is-active dataeye-board        # 应输出 active
journalctl -u dataeye-board -n 50 --no-pager
```

---

## 5. 装 nginx 反代

```bash
cp /opt/dataeye/deploy/nginx-dataeye.conf /etc/nginx/conf.d/dataeye.conf
# 编辑 server_name、ssl_certificate 路径(证书用 certbot 申请或已有的通配符证书)
vim /etc/nginx/conf.d/dataeye.conf

nginx -t                    # 语法检查
systemctl reload nginx
```

看板(`/board`)现在由 Bun/TS 只读页监听 `127.0.0.1:9200`,nginx `location /board` 直接反代过去并加 Basic Auth。

---

## 6. 冒烟测试

先在服务器本机造一个测试用的 gzip 样例包(也可以在本地机器造好再 scp 上去):

```bash
node /opt/dataeye/tests/make_sample.mjs --out=sample.json.gz
```

直接打接收端(未经 nginx,验证服务本身活着):

```bash
curl -s http://127.0.0.1:9100/health
# {"ok":true}

curl -s -X POST \
  -H "Authorization: Bearer <INGEST_TOKENS 里配的某个令牌>" \
  -H "Content-Encoding: gzip" \
  -H "Content-Type: application/json" \
  --data-binary @sample.json.gz \
  http://127.0.0.1:9100/ingest
# {"accepted":1,"duplicated":0}
```

直接打看板(未经 nginx,验证只读页能连库):

```bash
curl -s http://127.0.0.1:9200/board/healthz
# {"ok":true}

curl -s http://127.0.0.1:9200/board/ | head
# <!doctype html>...
```

再打一遍确认幂等(第二次应该 duplicated:1):

```bash
curl -s -X POST \
  -H "Authorization: Bearer <令牌>" \
  -H "Content-Encoding: gzip" \
  --data-binary @sample.json.gz \
  http://127.0.0.1:9100/ingest
# {"accepted":0,"duplicated":1}
```

进库确认数据真落地了:

```bash
sudo -u postgres psql -d dataeye -c "SELECT * FROM raw_inbox ORDER BY id DESC LIMIT 5;"
sudo -u postgres psql -d dataeye -c "SELECT * FROM events ORDER BY id DESC LIMIT 5;"
```

走 nginx/HTTPS 的话把 `http://127.0.0.1:9100` 换成 `https://<域名>` 再测一遍完整链路。

---

## 7. 安装报表物化视图

```bash
sudo -u postgres psql -d dataeye -f /opt/dataeye/sql/marts.sql

# 首次建好后要手动刷新一次才有数据(物化视图不会自动更新):
sudo -u postgres psql -d dataeye -c "
REFRESH MATERIALIZED VIEW marts_cost_by_machine_day;
REFRESH MATERIALIZED VIEW marts_activity_by_machine_day;
REFRESH MATERIALIZED VIEW marts_feedback;
REFRESH MATERIALIZED VIEW marts_crashes;
"
```

定时刷新(建议每小时或每天,接进现有 cron 习惯,或用看板工具如 Metabase 的定时任务):

```bash
cat > /etc/cron.d/dataeye-marts-refresh <<'EOF'
0 * * * * postgres psql -d dataeye -c "REFRESH MATERIALIZED VIEW marts_cost_by_machine_day; REFRESH MATERIALIZED VIEW marts_activity_by_machine_day; REFRESH MATERIALIZED VIEW marts_feedback; REFRESH MATERIALIZED VIEW marts_crashes;"
EOF
```

---

## 8. 磁盘告警

```bash
cp /opt/dataeye/deploy/disk-alarm.cron /etc/cron.d/dataeye-disk
chmod 644 /etc/cron.d/dataeye-disk
systemctl restart cron   # 或 crond,视发行版而定
```

跑得动的话可以把脚本里 `logger` 那一段换成真的告警(企业微信/飞书机器人 webhook curl),接你现有通知渠道。

---

## 9. 本地看库(不开公网 5432)

PG 只绑 `127.0.0.1`,不对公网开放。本地看数走 SSH 隧道:

```bash
ssh -N -L 15432:127.0.0.1:5432 root@<app机>
# 隧道开着的情况下,本地数据库工具(TablePlus/DBeaver/psql)连:
#   host=localhost port=15432 dbname=dataeye user=dataeye password=<密码>
```

---

## 10. 吊销某台机器的令牌

```bash
vim /etc/systemd/system/dataeye-receiver.service   # 从 INGEST_TOKENS 里删掉对应令牌
systemctl daemon-reload
systemctl restart dataeye-receiver
```

---

## 常见问题

- `systemctl is-active` 不是 active → `journalctl -u dataeye-receiver -n 100 --no-pager` 看报错,常见是 PGDSN 密码错、bun 不在 PATH、端口被占。
- `curl` 返回 401 → 令牌没在 `INGEST_TOKENS` 清单里,或 systemd env 改了没 `daemon-reload` + `restart`。
- `curl` 返回 200 但 `accepted:0 duplicated:0` → 检查 batch 是不是空数组,或 `kind` 拼写是否是 `event|gen|trace|store` 四选一之外的值(未知 kind 只落 raw_inbox,不整理,也算 accepted)。
- 磁盘涨得快 → 先看 `transcripts/` 目录，并按当前保留策略清理或扩容。

## ⚠️ 重部署代码(改了 receiver/board 后同步到服务器)

业务数据在 PostgreSQL 和 `/data/transcripts/`，都不放在 `/opt/dataeye/`。真实令牌和数据库密码由 systemd 单元或受保护的 `EnvironmentFile` 持有，不放进代码目录。因此可以只同步代码，再重启服务:

```bash
rsync -az --delete dataeye/ root@<app机>:/opt/dataeye/
systemctl restart dataeye-receiver dataeye-board
```

重部署不复制或改写正在使用的 systemd 单元；需要变更环境变量时，单独编辑单元或 `EnvironmentFile`，再执行 `systemctl daemon-reload`。
