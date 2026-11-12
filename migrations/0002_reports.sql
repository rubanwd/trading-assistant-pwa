-- Етап «Звіти»: категорія новини від сортувальника і список стрічок.
ALTER TABLE news ADD COLUMN category TEXT;
CREATE INDEX news_ts ON news (ts DESC);
CREATE INDEX forecasts_source ON forecasts (source);

INSERT INTO settings (key, value) VALUES
  ('news_feeds', '[{"source":"coindesk","url":"https://www.coindesk.com/arc/outboundfeeds/rss"},{"source":"cointelegraph","url":"https://cointelegraph.com/rss"},{"source":"decrypt","url":"https://decrypt.co/feed"},{"source":"theblock","url":"https://www.theblock.co/rss.xml"}]');
