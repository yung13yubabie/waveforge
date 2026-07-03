-- WaveForge Migration 003 — Spotify API 憑證
-- 用途：掃描結果以 Spotify Web API（Client Credentials flow）增強
--       （ISRC 精準查詢 → 專輯封面 / 發行日 / 正確連結）
-- 前提：001、002 已執行
-- 執行方式：Dashboard SQL Editor 貼上執行（可安全重跑）

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS spotify_client_id text,
  ADD COLUMN IF NOT EXISTS spotify_client_secret text;

-- RLS 已由 002 的 "user_settings: own row only" policy 覆蓋（FOR ALL），
-- 新欄位自動受同一 policy 保護，無需額外變更。
