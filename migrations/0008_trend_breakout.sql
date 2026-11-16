-- Трендовий пробій 4h замість трьох сетапів на 1h. У нового сетапу немає фіксованої цілі й R:R:
-- позицію закриває стоп або вихід за 10-свічковим каналом 4h. Тому tp1 і rr стають необов'язковими,
-- а замість «ціль раніше за стоп» модель оцінює подію hit: ціна пройде +1R до закриття позиції.
-- SQLite не вміє знімати NOT NULL, тож таблицю перебудовано; перевірку зовнішніх ключів відкладено до кінця.
PRAGMA defer_foreign_keys = true;

CREATE TABLE signals_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,              -- long | short
  setup TEXT NOT NULL,
  entry_low REAL NOT NULL,         -- для trend_breakout entry_low = entry_high = ціна входу за ринком
  entry_high REAL NOT NULL,
  stop REAL NOT NULL,
  tp1 REAL,                        -- немає в trend_breakout
  tp2 REAL,
  rr REAL,                         -- немає в trend_breakout
  p_analyst REAL,
  p_skeptic REAL,
  status TEXT NOT NULL,            -- active | stopped | exited | rejected
  expires_at TEXT NOT NULL,        -- найпізніше закриття за часом
  result_r REAL,
  resolved_at TEXT,
  reasoning TEXT,
  snapshot_id INTEGER REFERENCES snapshots(id),
  playbook_version INTEGER,
  fee_r REAL,
  shadow_status TEXT,
  shadow_r REAL,
  hit INTEGER,                     -- 1: ціна пройшла +1R до закриття, 0: ні, NULL: ще невідомо
  shadow_hit INTEGER
);

INSERT INTO signals_new (id, created_at, symbol, side, setup, entry_low, entry_high, stop, tp1, tp2, rr, p_analyst, p_skeptic,
  status, expires_at, result_r, resolved_at, reasoning, snapshot_id, playbook_version, fee_r, shadow_status, shadow_r)
SELECT id, created_at, symbol, side, setup, entry_low, entry_high, stop, tp1, tp2, rr, p_analyst, p_skeptic,
  status, expires_at, result_r, resolved_at, reasoning, snapshot_id, playbook_version, fee_r, shadow_status, shadow_r
FROM signals;

DROP TABLE signals;
ALTER TABLE signals_new RENAME TO signals;

CREATE INDEX signals_status ON signals (status, created_at DESC);
CREATE INDEX signals_symbol_created ON signals (symbol, created_at DESC);
CREATE INDEX signals_resolved ON signals (resolved_at);

PRAGMA defer_foreign_keys = false;

-- Налаштування старих сетапів: цілі немає, вхід за ринком. Трендова позиція живе днями: медіана в бектесті ~60 год.
DELETE FROM settings WHERE key IN ('min_rr', 'signal_ttl_hours');
UPDATE settings SET value = '336' WHERE key = 'signal_max_hold_hours' AND value = '48';

-- Правила старих сетапів більше не діють: рушій створить нову версію з правилом трендового пробою.
UPDATE playbook_versions SET active = 0;
