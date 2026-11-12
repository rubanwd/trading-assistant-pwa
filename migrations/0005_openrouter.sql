-- Моделі через OpenRouter: для кожного агента модель, рівень міркування, ліміт відповіді й запасна модель.
-- Змінюються на сторінці «Моделі ШІ». Пакетного API в OpenRouter немає, тож таблиця пакетів більше не потрібна.
INSERT INTO settings (key, value) VALUES
  ('ai_agents', '{"news":{"model":"anthropic/claude-haiku-5.5","effort":"low","maxTokens":8000,"fallback":null},"report":{"model":"anthropic/claude-sonnet-5.5","effort":"medium","maxTokens":16000,"fallback":null},"analyst":{"model":"anthropic/claude-sonnet-5.5","effort":"medium","maxTokens":8000,"fallback":null},"skeptic":{"model":"anthropic/claude-sonnet-5.5","effort":"medium","maxTokens":8000,"fallback":null},"weekly":{"model":"anthropic/claude-opus-5.5","effort":"high","maxTokens":16000,"fallback":null}}'),
  ('ai_budget_fallback_model', '"anthropic/claude-haiku-5.5"'),
  ('ai_data_collection', '"deny"')
ON CONFLICT (key) DO NOTHING;

DROP TABLE IF EXISTS llm_batches;
