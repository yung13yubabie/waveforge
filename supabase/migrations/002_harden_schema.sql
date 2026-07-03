-- WaveForge Migration 002 — schema hardening
-- 目的：
--   1. scan_results 增加 user_id 直接綁定（不只透過 works 間接授權）
--   2. 補齊 created_at / updated_at 欄位
--   3. RLS policy 補 WITH CHECK（INSERT 需要）並限定 authenticated 角色
--   4. 補 user_id index
-- 執行方式：supabase db push 或 Dashboard SQL Editor

-- ── user_settings: 補 created_at ────────────────────────────
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- ── works: 補 updated_at + trigger ──────────────────────────
ALTER TABLE works
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

DROP TRIGGER IF EXISTS set_works_updated_at ON works;
CREATE TRIGGER set_works_updated_at
  BEFORE UPDATE ON works
  FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

-- ── scan_results: 直接綁 user_id ────────────────────────────
ALTER TABLE scan_results
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- 回填既有資料的 user_id（從 works 推導）
UPDATE scan_results sr
SET user_id = w.user_id
FROM works w
WHERE sr.work_id = w.id AND sr.user_id IS NULL;

CREATE INDEX IF NOT EXISTS scan_results_user_id_idx ON scan_results(user_id);

-- ── RLS 重建：明確角色 + INSERT 需要 WITH CHECK ─────────────
-- user_settings
DROP POLICY IF EXISTS "user_settings: own row only" ON user_settings;
CREATE POLICY "user_settings: own row only" ON user_settings
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- works
DROP POLICY IF EXISTS "works: own rows only" ON works;
CREATE POLICY "works: own rows only" ON works
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- scan_results：user_id 直接限制（比透過 works EXISTS 子查詢更快也更嚴格）
DROP POLICY IF EXISTS "scan_results: via works owner" ON scan_results;
CREATE POLICY "scan_results: own rows only" ON scan_results
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM works
      WHERE works.id = scan_results.work_id
        AND works.user_id = auth.uid()
    )
  );
