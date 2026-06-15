-- WaveForge Supabase 資料庫 Schema
-- 執行方式：supabase db push 或在 Supabase Dashboard SQL Editor 貼上執行

-- 啟用必要擴充
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── 使用者設定（ACRCloud credentials + 通知偏好）────────────
CREATE TABLE IF NOT EXISTS user_settings (
  user_id         uuid REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  acr_access_key  text,
  acr_access_secret text,
  acr_host        text DEFAULT 'identify-eu-west-1.acrcloud.com',
  email_notify    boolean DEFAULT true,
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_settings: own row only" ON user_settings
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── 原創作品庫 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS works (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  name            text NOT NULL,
  file_size_bytes bigint,
  duration_sec    numeric,
  fingerprint_ok  boolean DEFAULT false,
  last_scan       timestamptz,
  created_at      timestamptz DEFAULT now()
);

ALTER TABLE works ENABLE ROW LEVEL SECURITY;

CREATE POLICY "works: own rows only" ON works
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── 掃描結果 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scan_results (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  work_id      uuid REFERENCES works ON DELETE CASCADE NOT NULL,
  scanned_at   timestamptz DEFAULT now(),
  results      jsonb NOT NULL DEFAULT '[]',
  match_count  int DEFAULT 0,
  acr_raw      jsonb
);

ALTER TABLE scan_results ENABLE ROW LEVEL SECURITY;

-- Only allow access through works (user owns the work → can see its results)
CREATE POLICY "scan_results: via works owner" ON scan_results
  USING (
    EXISTS (
      SELECT 1 FROM works
      WHERE works.id = scan_results.work_id
        AND works.user_id = auth.uid()
    )
  );

-- ── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS works_user_id_idx ON works(user_id);
CREATE INDEX IF NOT EXISTS scan_results_work_id_idx ON scan_results(work_id);

-- ── Helper: auto-update updated_at ──────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_user_settings_updated_at ON user_settings;
CREATE TRIGGER set_user_settings_updated_at
  BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
