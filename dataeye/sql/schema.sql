-- dataeye/sql/schema.sql
-- 六模块 DDL(原始层 + 整理层)。全部 CREATE TABLE IF NOT EXISTS,可重复执行、幂等。
-- 执行:sudo -u postgres psql -d dataeye -f schema.sql

-- 📥 原始落地层(收件箱):append-only,原样存每条上传原文,能回溯、能重解析。
CREATE TABLE IF NOT EXISTS raw_inbox (
  id BIGSERIAL PRIMARY KEY,
  machine_id TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- event | gen | trace | store
  ref_id TEXT NOT NULL,
  payload JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (machine_id, kind, ref_id)
);

-- 📊 events:动作流水(做了啥/成没成/耗时/报错)
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  machine_id TEXT,
  event_id TEXT,                         -- = 客户端 usage_events.id
  store_id TEXT,
  user_id TEXT,
  event TEXT,
  props JSONB,
  created_at TIMESTAMPTZ,
  UNIQUE (machine_id, event_id)
);

-- 🖼️ generations:生成记录(提示词/结果/模型/token/好评差评)
CREATE TABLE IF NOT EXISTS generations (
  id BIGSERIAL PRIMARY KEY,
  machine_id TEXT,
  gen_id TEXT,                           -- = 客户端 generations.id
  store_id TEXT,
  type TEXT,
  sub_type TEXT,
  prompt_used TEXT,
  result TEXT,
  model_used TEXT,
  tokens_used INT,
  effect_rating TEXT,
  effect_note TEXT,
  is_favorite BOOL,
  source_rec_id TEXT,
  conversation_id TEXT,
  created_at TIMESTAMPTZ,
  UNIQUE (machine_id, gen_id)
);

-- 📁 transcripts:索引卡片;长文本正文落大盘文件(TRANSCRIPT_STORE_DIR),表里只存索引
CREATE TABLE IF NOT EXISTS transcripts (
  id BIGSERIAL PRIMARY KEY,
  machine_id TEXT,
  conversation_id TEXT,
  file_path TEXT,
  summary TEXT,
  turns INT,
  created_at TIMESTAMPTZ,
  UNIQUE (machine_id, conversation_id)
);

-- 🏬 stores:门店画像/身份/机器(每台机每家店只留最新快照)
CREATE TABLE IF NOT EXISTS stores (
  id BIGSERIAL PRIMARY KEY,
  machine_id TEXT,
  store_id TEXT,
  snapshot JSONB,
  received_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (machine_id, store_id)
);

-- 常用索引:按机器+时间查、按好评差评查
CREATE INDEX IF NOT EXISTS idx_events_machine_created ON events (machine_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generations_machine_created ON generations (machine_id, created_at);
CREATE INDEX IF NOT EXISTS idx_generations_effect_rating ON generations (effect_rating);
