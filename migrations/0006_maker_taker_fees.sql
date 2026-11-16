-- Комісії окремо для maker і taker: вхід у зоні й цілі виконуються лімітними ордерами (maker),
-- стоп, беззбиток і закриття за часом — ринковими (taker). Ф'ючерси Binance, VIP 0: 0.02% і 0.05%.
-- Колишня єдина ставка fee_pct_per_side була ставкою taker: якщо її змінювали, вона переходить у fee_taker_pct.
INSERT INTO settings (key, value)
  SELECT 'fee_taker_pct', value FROM settings WHERE key = 'fee_pct_per_side'
ON CONFLICT (key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('fee_maker_pct', '0.02'),
  ('fee_taker_pct', '0.05')
ON CONFLICT (key) DO NOTHING;

DELETE FROM settings WHERE key = 'fee_pct_per_side';
