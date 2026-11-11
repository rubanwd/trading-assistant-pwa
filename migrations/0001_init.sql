-- Увесь час у UTC (ISO 8601).
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- scan | morning_report | evening_report | weekly_review | probe
  started_at TEXT NOT NULL,
  status TEXT NOT NULL,            -- ok | error
  duration_ms INTEGER,
  candidates INTEGER DEFAULT 0,
  detail TEXT,
  error TEXT
);
CREATE INDEX runs_kind_started ON runs (kind, started_at DESC);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  symbol TEXT NOT NULL,
  features TEXT NOT NULL
);
CREATE INDEX snapshots_run ON snapshots (run_id);

CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,              -- long | short
  setup TEXT NOT NULL,
  entry_low REAL NOT NULL,
  entry_high REAL NOT NULL,
  stop REAL NOT NULL,
  tp1 REAL NOT NULL,
  tp2 REAL,
  rr REAL NOT NULL,
  p_analyst REAL,
  p_skeptic REAL,
  status TEXT NOT NULL,            -- pending | active | tp1 | tp2 | stopped | expired | rejected
  expires_at TEXT NOT NULL,
  result_r REAL,
  resolved_at TEXT,
  reasoning TEXT,
  snapshot_id INTEGER REFERENCES snapshots(id),
  playbook_version INTEGER
);
CREATE INDEX signals_status ON signals (status, created_at DESC);

CREATE TABLE signal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals(id),
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  price REAL
);
CREATE INDEX signal_events_signal ON signal_events (signal_id);

CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- morning | evening | weekly
  date TEXT NOT NULL,
  body TEXT NOT NULL,
  model TEXT,
  cost_usd REAL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, date)
);

CREATE TABLE forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,            -- report:<id> | signal:<id>
  statement TEXT NOT NULL,
  probability REAL NOT NULL,
  resolve_at TEXT NOT NULL,
  rule TEXT NOT NULL,
  outcome INTEGER,                 -- 1 | 0 | NULL
  resolved_at TEXT
);
CREATE INDEX forecasts_open ON forecasts (outcome, resolve_at);

CREATE TABLE journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  signal_id INTEGER REFERENCES signals(id),
  action TEXT,                     -- taken | skipped
  note TEXT,
  entry REAL,
  exit REAL,
  size REAL
);

CREATE TABLE news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  relevance REAL,
  impact TEXT,
  sentiment TEXT,
  symbols TEXT
);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  latency_ms INTEGER
);
CREATE INDEX llm_calls_ts ON llm_calls (ts);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  keys TEXT NOT NULL,
  device TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE playbook_versions (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  content TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0
);

INSERT INTO settings (key, value) VALUES
  ('timezone', '"Europe/Kyiv"'),
  ('report_times', '{"morning":"07:30","evening":"20:30"}'),
  ('risk_per_trade_pct', '1'),
  ('min_rr', '2'),
  ('skeptic_threshold', '0.6'),
  ('max_active_signals', '3'),
  ('macro_blackout_hours', '2'),
  ('max_signal_pushes_per_day', '5'),
  ('llm_budget_usd', '25'),
  ('watchlist', '["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","SUIUSDT","TONUSDT","DOTUSDT","LTCUSDT","NEARUSDT","APTUSDT"]');
