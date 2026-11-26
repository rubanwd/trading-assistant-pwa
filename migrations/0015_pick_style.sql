-- Ідея скану: напрямок за ринком останніх годин (тренд 1h і 15m), а не за трендом 1d і 4h.
-- swing повертає попередній стиль. Стоп (1.5 ATR 4h) і горизонт (pick_horizon_hours) не змінюються.
INSERT INTO settings (key, value) VALUES
  ('pick_style', '"short"')
ON CONFLICT (key) DO NOTHING;
