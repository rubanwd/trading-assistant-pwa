-- Ідея скану: щопів години одна монета, напрямок і ціна входу, найкращі серед списку.
-- Бал технічного аналізу, вхід, стоп і ціль рахує код; модель вибирає один із найкращих варіантів або жоден.
-- Це не сигнал (немає скептика й супроводу зі сповіщеннями), але результат кожної ідеї код рахує за свічками 1h.
CREATE TABLE picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,              -- UTC
  run_id INTEGER,                        -- запуск скану, зі знімків якого складено ідею
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('market', 'pullback')),
  price REAL NOT NULL,                   -- ціна в момент ідеї
  entry REAL NOT NULL,
  stop REAL NOT NULL,
  target REAL NOT NULL,
  score INTEGER NOT NULL,                -- бал технічного аналізу 0–100
  verdict TEXT NOT NULL CHECK (verdict IN ('pick', 'pass', 'none')), -- pick: модель вибрала; pass: модель радить не входити; none: моделі не було
  probability REAL,                      -- оцінка моделі 0..1: ціль раніше стопа за horizon_hours
  model TEXT,
  horizon_hours REAL NOT NULL,
  is_repeat INTEGER NOT NULL DEFAULT 0,  -- та сама монета й напрямок, що й у попередньої відкритої ідеї: у статистику не йде
  body TEXT NOT NULL,                    -- JSON: ознаки балу, інші варіанти, пояснення моделі
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'target', 'stop', 'expired', 'unfilled')),
  result_r REAL,
  filled_at TEXT,
  resolved_at TEXT
);
CREATE INDEX picks_created ON picks (created_at DESC);
CREATE INDEX picks_open ON picks (status) WHERE status = 'open';

INSERT INTO settings (key, value) VALUES
  ('pick_enabled', '"on"'),
  ('pick_horizon_hours', '24')
ON CONFLICT (key) DO NOTHING;
