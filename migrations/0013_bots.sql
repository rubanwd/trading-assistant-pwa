-- Боти: стратегії, що щогодини «ставлять» ордери за правилами коду. Поки паперова торгівля на публічних даних Bybit:
-- ордери не йдуть на біржу, виконання, тейк, стоп і закриття за часом рахує код за свічками 15m.
-- Перший бот — High Value Tube (bot = 'hvt'): 3 найрухливіші монети з топ-20, по лімітці в лонг і шорт навколо ціни.
CREATE TABLE bot_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot TEXT NOT NULL,                     -- hvt
  desk TEXT NOT NULL DEFAULT 'crypto',
  created_at TEXT NOT NULL,              -- UTC, коли ордер поставлено (цикл години)
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  bias TEXT NOT NULL CHECK (bias IN ('bull', 'bear', 'neutral')), -- напрямок ринку в момент постановки
  near INTEGER,                          -- 1: ближчий ордер монети, 0: дальній, NULL: ринок без напрямку
  rank INTEGER NOT NULL,                 -- місце монети в рейтингу руху, від 1
  price REAL NOT NULL,                   -- ціна в момент постановки
  atr REAL NOT NULL,                     -- ATR(14) 1h
  entry REAL NOT NULL,                   -- лімітна ціна входу
  stop REAL NOT NULL,
  target REAL NOT NULL,                  -- тейк-профіт
  expires_at TEXT NOT NULL,              -- невиконаний ордер знімається
  max_hold_hours REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'cancelled', 'open', 'target', 'stop', 'timeout')),
  filled_at TEXT,
  resolved_at TEXT,
  exit_price REAL,
  result_r REAL,                         -- до комісій
  fee_r REAL,                            -- комісії в R: вхід і тейк maker, стоп і за часом taker
  body TEXT NOT NULL                     -- JSON: ознаки монети, з яких складено ордер
);
CREATE INDEX bot_orders_active ON bot_orders (bot, status) WHERE status IN ('pending', 'open');
CREATE INDEX bot_orders_created ON bot_orders (bot, created_at DESC);

INSERT INTO settings (key, value) VALUES
  ('tube_enabled', '"on"'),
  ('tube_top_n', '20'),
  ('tube_pick_n', '3'),
  ('tube_entry_atr', '1'),
  ('tube_bias_ratio', '2'),
  ('tube_bias_side', '"counter"'),
  ('tube_stop_atr', '3'),
  ('tube_target_r', '0.5'),
  ('tube_min_stop_pct', '0.5'),
  ('tube_max_hold_hours', '12'),
  ('tube_max_positions', '6')
ON CONFLICT (key) DO NOTHING;
