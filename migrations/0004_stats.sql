-- Етап «Статистика» і доробки: комісії, денні ціни для порівняння з BTC, тижневі пакети, прибирання.
ALTER TABLE signals ADD COLUMN fee_r REAL;          -- комісії в R, рахуються при закритті
-- Тіньовий супровід відхилених моделлю кандидатів: що було б, якби їх узяли. Без подій і сповіщень.
ALTER TABLE signals ADD COLUMN shadow_status TEXT;
ALTER TABLE signals ADD COLUMN shadow_r REAL;
CREATE INDEX signals_resolved ON signals (resolved_at);
CREATE INDEX signal_events_type_ts ON signal_events (type, ts);
CREATE INDEX snapshots_symbol ON snapshots (symbol, id);

CREATE TABLE prices_daily (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,                                -- дата закриття денної свічки (UTC), YYYY-MM-DD
  close REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);

-- Запити до Message Batches API, що ще не завершились.
CREATE TABLE llm_batches (
  id TEXT PRIMARY KEY,
  pipeline TEXT NOT NULL,
  report_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,                              -- pending | done | error
  input TEXT NOT NULL,                               -- статистика, на якій зроблено запит
  ended_at TEXT,
  error TEXT
);

INSERT INTO settings (key, value) VALUES
  ('fee_pct_per_side', '0.05'),                      -- комісія тейкера ф'ючерсів Binance, % за угоду
  ('retention_days', '30'),                          -- скільки зберігати знімки і новини
  ('weekly_review_time', '"12:00"'),                 -- неділя, за місцевим часом
  ('playbook_min_days', '14'),                       -- як часто можна вмикати нову версію правил
  ('market_source', '"auto"');                       -- auto | binance | bybit
