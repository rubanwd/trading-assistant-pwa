-- Фільтри High Value Tube (за бектестом найгірші угоди — проти руху монети й у ринку без напрямку)
-- і другий бот High Value Breakout (bot = 'hvb'): ті самі монети, але стоп-ордери входять у бік руху.
-- Ордери обох ботів у bot_orders; налаштування High Value Breakout з префіксом brk_.
INSERT INTO settings (key, value) VALUES
  ('tube_trend_only', '"on"'),
  ('tube_skip_neutral', '"on"'),
  ('brk_enabled', '"on"'),
  ('brk_top_n', '20'),
  ('brk_pick_n', '3'),
  ('brk_entry_atr', '2'),
  ('brk_bias_ratio', '2'),
  ('brk_bias_side', '"off"'),
  ('brk_stop_atr', '3'),
  ('brk_target_r', '3'),
  ('brk_min_stop_pct', '0.5'),
  ('brk_max_hold_hours', '12'),
  ('brk_max_positions', '6'),
  ('brk_trend_only', '"off"'),
  ('brk_skip_neutral', '"off"')
ON CONFLICT (key) DO NOTHING;
