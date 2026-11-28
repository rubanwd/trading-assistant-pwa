-- П'ятий бот Trend Basket (bot = 'trend'): лонг монет топ-N вище денної середньої, частки за волатильністю.
-- Паперова торгівля на публічних даних Bybit. Облік у % капіталу бота (капітал = 1): units — знакова кількість монет
-- на одиницю капіталу, pnl / fee / funding — частки капіталу, накопичені за епізод.
-- Епізод — від відкриття до закриття позиції в монеті або зміни знака; перебалансування всередині — resizes.
CREATE TABLE trend_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  entry_price REAL NOT NULL,
  entry_weight REAL NOT NULL,           -- частка капіталу на вході, за модулем
  units REAL NOT NULL,                  -- поточна знакова кількість на одиницю капіталу
  last_price REAL NOT NULL,             -- ціна останньої переоцінки
  last_funding_at TEXT,                 -- останнє враховане нарахування фандингу
  exit_price REAL,
  pnl REAL NOT NULL DEFAULT 0,          -- результат від руху ціни
  fee REAL NOT NULL DEFAULT 0,          -- комісії входу, перебалансувань і виходу
  funding REAL NOT NULL DEFAULT 0,      -- фандинг: лонг платить додатну ставку
  resizes INTEGER NOT NULL DEFAULT 0,
  reason TEXT                           -- чому закрито: below_sma | above_sma | dropped | no_data | disabled
);
CREATE INDEX trend_holdings_status ON trend_holdings (status, symbol);

-- Денний облік у % капіталу бота.
CREATE TABLE trend_days (
  day TEXT PRIMARY KEY,                 -- YYYY-MM-DD UTC
  pnl_pct REAL NOT NULL,                -- переоцінка позицій від попереднього циклу
  fee_pct REAL NOT NULL,
  funding_pct REAL NOT NULL,
  exposure REAL NOT NULL,               -- сума модулів часток після перебалансування
  positions INTEGER NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('trb_enabled', '"on"'),
  ('trb_top_n', '10'),
  ('trb_sma_days', '50'),
  ('trb_vol_days', '30'),
  ('trb_target_vol', '0.5'),
  ('trb_band', '0.25'),
  ('trb_sides', '"long"')
ON CONFLICT (key) DO NOTHING;
