-- Ідея скану: фільтр імпульсу (лише варіанти з RSI 1h у бік угоди не нижче порогу, вхід за ринком)
-- і стиль балу: swing (тренд 1d і 4h, як і раніше) або short (напрямок за ринком останніх годин).
INSERT INTO settings (key, value) VALUES
  ('pick_style', '"swing"'),
  ('pick_min_rsi_1h', '65')
ON CONFLICT (key) DO NOTHING;
