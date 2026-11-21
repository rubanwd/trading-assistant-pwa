-- Режим акцій: безстрокові USDT-контракти Bybit на акції та ETF США поруч із крипто.
-- Кожен запис, що належить режиму, позначається колонкою desk: crypto | stocks. Старі рядки — крипто.

ALTER TABLE signals ADD COLUMN desk TEXT NOT NULL DEFAULT 'crypto';
CREATE INDEX signals_desk_status ON signals (desk, status, created_at DESC);

ALTER TABLE picks ADD COLUMN desk TEXT NOT NULL DEFAULT 'crypto';
CREATE INDEX picks_desk_created ON picks (desk, created_at DESC);

ALTER TABLE news ADD COLUMN desk TEXT NOT NULL DEFAULT 'crypto';
CREATE INDEX news_desk_ts ON news (desk, ts DESC);

ALTER TABLE forecasts ADD COLUMN desk TEXT NOT NULL DEFAULT 'crypto';

-- Запуски: режим лише для тих, що належать режиму (скан, сигнали, новини, звіти); у probe, pipeline і cleanup його немає.
ALTER TABLE runs ADD COLUMN desk TEXT;
UPDATE runs SET desk = 'crypto' WHERE kind IN ('scan', 'signals', 'news', 'morning_report', 'evening_report', 'weekly_review');
CREATE INDEX runs_desk_kind ON runs (desk, kind, started_at DESC);

-- Звіти: унікальність тепер у межах режиму, тож таблицю перебудовано.
CREATE TABLE reports_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  desk TEXT NOT NULL DEFAULT 'crypto',
  kind TEXT NOT NULL,              -- morning | evening | weekly
  date TEXT NOT NULL,
  body TEXT NOT NULL,
  model TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  UNIQUE (desk, kind, date)
);
INSERT INTO reports_new (id, desk, kind, date, body, model, cost_usd, created_at)
  SELECT id, 'crypto', kind, date, body, model, cost_usd, created_at FROM reports;
DROP TABLE reports;
ALTER TABLE reports_new RENAME TO reports;
CREATE INDEX reports_desk_created ON reports (desk, created_at DESC);

INSERT INTO settings (key, value) VALUES
  ('stocks_enabled', '"on"'),
  ('stocks_benchmark', '"SPYUSDT"'),
  ('stocks_watchlist', '["SPYUSDT","QQQUSDT","AAPLUSDT","MSFTUSDT","NVDAUSDT","GOOGLUSDT","AMZNUSDT","METAUSDT","TSLAUSDT","AVGOUSDT","TSMUSDT","AMDUSDT","PLTRUSDT","COINUSDT","MSTRUSDT"]'),
  ('stocks_news_feeds', '[{"source":"marketwatch","url":"https://feeds.content.dowjones.io/public/rss/mw_topstories"},{"source":"investing","url":"https://www.investing.com/rss/news_25.rss"},{"source":"seekingalpha","url":"https://seekingalpha.com/market_currents.xml"}]'),
  ('stocks_report_times', '{"morning":"16:00","evening":"23:15"}')
ON CONFLICT (key) DO NOTHING;
