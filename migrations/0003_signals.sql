-- Етап «Сигнали»: налаштування життєвого циклу сигналів і сповіщень.
CREATE INDEX signals_symbol_created ON signals (symbol, created_at DESC);
CREATE INDEX journal_signal ON journal (signal_id);

INSERT INTO settings (key, value) VALUES
  ('signal_ttl_hours', '12'),            -- скільки сигнал чекає входу
  ('signal_max_hold_hours', '48'),       -- після цього активний сигнал закривається за ринком
  ('signal_cooldown_hours', '6'),        -- не розглядати той самий сетап по монеті повторно
  ('max_candidates_per_scan', '3'),      -- скільки кандидатів за скан іде до моделі
  ('quiet_hours', '{"from":"23:00","to":"07:00"}'),
  ('macro_events', '[]'),                -- ["2026-12-16T19:00:00Z", ...] або [{"at":"...","name":"ФРС"}]
  ('deposit_usd', 'null');               -- депозит для розрахунку розміру позиції
