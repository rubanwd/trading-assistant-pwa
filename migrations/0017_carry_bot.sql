-- Четвертий бот Funding Carry (bot = 'carry'): спот у лонг і шорт безстрокового контракту на той самий обсяг,
-- дохід — фандинг. Паперова торгівля на публічних даних Bybit: ордери на біржу не йдуть.
-- Облік у частках: funding і fee — від обсягу позиції; share — частка капіталу бота в позиції.
-- Результат позиції в % капіталу = (funding − fee) × share × 100.
CREATE TABLE carry_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL,              -- UTC, цикл доби, на якому бот увійшов
  symbol TEXT NOT NULL,                 -- контракт Bybit (спот — та сама монета до USDT)
  share REAL NOT NULL,                  -- частка капіталу бота: 1 / max_positions на момент входу
  entry_apr REAL NOT NULL,              -- фандинг за lookback на вході, % річних
  entry_price REAL,                     -- марк-ціна на вході, для довідки
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TEXT,
  exit_apr REAL,                        -- фандинг на виході, % річних; NULL — контракт зник
  exit_price REAL,
  funding REAL NOT NULL DEFAULT 0,      -- сума нарахованих ставок (шорт отримує додатну), частка обсягу
  payments INTEGER NOT NULL DEFAULT 0,  -- скільки нарахувань враховано
  last_funding_at TEXT,                 -- останнє враховане нарахування
  fee REAL NOT NULL,                    -- комісії обох ніг на вході (і на виході після закриття), частка обсягу
  reason TEXT                           -- чому закрито: below_exit | no_data | disabled
);
CREATE INDEX carry_positions_status ON carry_positions (status, symbol);

-- Денний облік у % капіталу бота: для підсумків за 7 / 30 днів.
CREATE TABLE carry_days (
  day TEXT PRIMARY KEY,                 -- YYYY-MM-DD UTC
  funding_pct REAL NOT NULL,            -- фандинг, нарахований за позиціями до циклу цієї доби
  fee_pct REAL NOT NULL,                -- комісії входів і виходів цієї доби
  positions INTEGER NOT NULL            -- відкритих позицій після циклу
);

INSERT INTO settings (key, value) VALUES
  ('cry_enabled', '"on"'),
  ('cry_top_n', '20'),
  ('cry_lookback_days', '3'),
  ('cry_entry_apr', '20'),
  ('cry_exit_apr', '5'),
  ('cry_max_positions', '5')
ON CONFLICT (key) DO NOTHING;
