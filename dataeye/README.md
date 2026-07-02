# dataeye — 用户数据接收端(独立小服务)

> 📌 状态:✅现行 · 最后核对 2026-07-02

## 这是什么

桌面客户端(装在门店老板电脑上的台球运营助手)会把本机产生的运营数据(操作事件、AI 生成记录、会话轨迹、门店画像)定期打包 gzip、POST 到这里。这个服务收下来、去重、分门别类落进 Postgres,供 owner 后续做成本统计/活跃度/好评率/门店画像看板。

**这是一个独立部署的小服务,不进桌面客户端安装包**——桌面版打包只打包仓库里的 `server/`,顶层这个 `dataeye/` 目录不会被 PyInstaller 带进去,只在 owner 自己的国内服务器上跑。

数据分三层,互不混:
1. **`raw_inbox`**(原始层):每条上传原样落地、只增不改,能回溯重解析。
2. **六模块整理层**:`events`(操作流水)/ `generations`(AI 生成记录)/ `transcripts`(会话轨迹索引,正文落大盘文件)/ `stores`(门店画像)。
3. **`marts_*`**(报表层):预算好的物化视图,喂看板直接读。

完整设计背景见 `docs/plans/用户数据留存与利用-机制设计-2026-07-02.md`。

## 目录结构

```
dataeye/
  receiver/
    app.py            # FastAPI:POST /ingest(接收端点)+ GET /health(探活)
    db.py              # asyncpg 连接池 + 落库逻辑(raw_inbox → 六模块整理)
    requirements.txt    # fastapi / uvicorn / asyncpg(接收端独立 venv,不与客户端共用)
  sql/
    schema.sql          # 六模块 DDL(CREATE TABLE IF NOT EXISTS,幂等可重跑)
    marts.sql            # 报表物化视图(cost/activity/feedback/crashes)
  deploy/
    dataeye-receiver.service   # systemd unit
    nginx-dataeye.conf          # nginx 反代(只对外暴露 /ingest 和 /board)
    mount-data-disk.sh           # 挂大数据盘脚本(⚠️破坏性,先读脚本头部警告)
    disk-alarm.cron               # 磁盘用量 >85% 告警
    runbook.md                     # 一步步部署清单(从挂盘到冒烟测试全流程)
  tests/
    test_receiver.py     # 本地单元测试(不需要真 PG,monkeypatch 掉 insert_batch)
    make_sample.py         # 造一个 gzip 测试包,方便本地/真机冒烟
```

## 本地怎么跑起来测

接收端本身依赖 `asyncpg` 连一个真 Postgres,但**单元测试不需要真库**——测试会 monkeypatch 掉 `db.insert_batch`,只验证 HTTP 层(鉴权 / gzip 解压 / 参数透传)对不对。

```bash
cd dataeye

# 装依赖(建议用独立虚拟环境,别装进桌面客户端的 server/.venv)
python3 -m venv .venv && source .venv/bin/activate
pip install -r receiver/requirements.txt
pip install pytest httpx      # 测试额外需要

# 跑单元测试
python -m pytest tests/ -q
```

### 真起服务本地冒烟(需要一个能连的 PG)

```bash
export INGEST_TOKENS=dev-token
export PGDSN=postgresql://dataeye:dataeye@127.0.0.1/dataeye   # 本地起一个 PG 容器或用已有实例
export TRANSCRIPT_STORE_DIR=/tmp/dataeye-transcripts

# 建表(需要先 createdb dataeye)
psql "$PGDSN" -f sql/schema.sql

cd receiver
uvicorn app:app --host 127.0.0.1 --port 9100 --reload
```

另开一个终端,造样例包打过去:

```bash
python dataeye/tests/make_sample.py   # 生成 dataeye/tests/sample.json.gz

curl -s -X POST \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Encoding: gzip" \
  -H "Content-Type: application/json" \
  --data-binary @dataeye/tests/sample.json.gz \
  http://127.0.0.1:9100/ingest
# {"accepted":1,"duplicated":0}
```

## 部署到服务器

见 `deploy/runbook.md`,从挂大数据盘、建库、装 systemd/nginx、冒烟测试到磁盘告警,一步步照做。

## 接口契约(锁定,客户端已按此实现,不能改)

- `POST /ingest`,Header `Authorization: Bearer <app令牌>`、`Content-Encoding: gzip`、`Content-Type: application/json`。
- Body(gzip 前 JSON):`{"machine_id": str, "batch": [{"kind": "event|gen|trace|store", "ref_id": str, "payload": {...}}]}`。
- 鉴权:令牌需在服务器 env `INGEST_TOKENS`(逗号分隔)清单里,可吊销(从清单删)。
- 幂等:按 `(machine_id, kind, ref_id)` 唯一,重复上传算 `duplicated`,不重复整理。
- 响应:`200 {"accepted": n, "duplicated": m}`;令牌无效 `401`。
