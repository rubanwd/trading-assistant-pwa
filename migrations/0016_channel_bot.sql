-- Третій бот Channel 20/10 (bot = 'c2010'): BTCUSDT на денних свічках, вхід за ринком після закриття доби
-- за межею 20-денного каналу, стоп за 10-денним каналом щодня підтягується, тейка немає (target = 0, max_hold_hours = 0).
-- stop лишається стопом на момент входу (від нього рахується 1R), чинний стоп — у trail_stop.
-- Фандинг за час позиції в R додається до fee_r: чистий результат, як і в інших ботів, = result_r − fee_r.
ALTER TABLE bot_orders ADD COLUMN trail_stop REAL;

INSERT INTO settings (key, value) VALUES
  ('chn_enabled', '"on"'),
  ('chn_symbol', '"BTCUSDT"'),
  ('chn_entry_days', '20'),
  ('chn_exit_days', '10'),
  ('chn_entry_window_hours', '2')
ON CONFLICT (key) DO NOTHING;
