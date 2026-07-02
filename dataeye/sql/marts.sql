-- dataeye/sql/marts.sql
-- 📈 报表物化视图:预算好的汇总,喂看板直接读,不折腾原始/整理层数据。
-- 执行:sudo -u postgres psql -d dataeye -f marts.sql(需先跑过 schema.sql)

-- 按机器+天:token 消耗与生成次数(成本视角)
CREATE MATERIALIZED VIEW IF NOT EXISTS marts_cost_by_machine_day AS
SELECT
  machine_id,
  date_trunc('day', created_at) AS day,
  sum(tokens_used) AS total_tokens,
  count(*) AS generation_count
FROM generations
WHERE created_at IS NOT NULL
GROUP BY machine_id, date_trunc('day', created_at);

-- 按机器+天:活跃事件数与涉及门店数(活跃度视角)
CREATE MATERIALIZED VIEW IF NOT EXISTS marts_activity_by_machine_day AS
SELECT
  machine_id,
  date_trunc('day', created_at) AS day,
  count(*) AS event_count,
  count(DISTINCT store_id) AS distinct_stores
FROM events
WHERE created_at IS NOT NULL
GROUP BY machine_id, date_trunc('day', created_at);

-- 按机器+门店:好评/差评计数与好评率(反馈飞轮视角)
CREATE MATERIALIZED VIEW IF NOT EXISTS marts_feedback AS
SELECT
  machine_id,
  store_id,
  count(*) FILTER (WHERE effect_rating IN ('good', 'up', 'positive', '好评', '1')) AS good_count,
  count(*) FILTER (WHERE effect_rating IN ('bad', 'down', 'negative', '差评', '0', '-1')) AS bad_count,
  count(*) FILTER (WHERE effect_rating IS NOT NULL AND effect_rating <> '') AS rated_count,
  round(
    count(*) FILTER (WHERE effect_rating IN ('good', 'up', 'positive', '好评', '1'))::numeric
    / NULLIF(count(*) FILTER (WHERE effect_rating IS NOT NULL AND effect_rating <> ''), 0),
    4
  ) AS good_rate
FROM generations
GROUP BY machine_id, store_id;

-- 按天:疑似崩溃/报错/合规命中事件计数(健康度视角)
CREATE MATERIALIZED VIEW IF NOT EXISTS marts_crashes AS
SELECT
  machine_id,
  date_trunc('day', created_at) AS day,
  count(*) FILTER (WHERE event ILIKE '%error%') AS error_count,
  count(*) FILTER (WHERE event ILIKE '%crash%') AS crash_count,
  count(*) FILTER (WHERE event ILIKE '%compliance_hit%') AS compliance_hit_count,
  count(*) AS total_flagged
FROM events
WHERE created_at IS NOT NULL
  AND (event ILIKE '%error%' OR event ILIKE '%crash%' OR event ILIKE '%compliance_hit%')
GROUP BY machine_id, date_trunc('day', created_at);

-- 刷新方式(物化视图不会自动更新,需手动或定时刷新):
-- REFRESH MATERIALIZED VIEW marts_cost_by_machine_day;
-- REFRESH MATERIALIZED VIEW marts_activity_by_machine_day;
-- REFRESH MATERIALIZED VIEW marts_feedback;
-- REFRESH MATERIALIZED VIEW marts_crashes;
-- 建议 cron 每小时/每天跑一遍上面四行,或在看板侧(Metabase 定时任务)配置刷新。
