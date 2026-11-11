# trading-assistant-pwa

AI-асистент трейдера: PWA на Cloudflare. Звіт двічі на день і пошук входів раз на 30 хв на ф'ючерсах Binance. Система пропонує сигнали, ордери не виставляє і торгових ключів не зберігає.

- План і архітектура: https://claude.ai/artifact/UbnRZ93BmcHBWeJBS64tD3
- Макети екранів: https://claude.ai/artifact/9vRhZcu858jPLMkjCnTchn

Це інструмент для аналізу, а не фінансова порада.

## Архітектура

Один проєкт Wrangler:

- **Worker**: статичні файли PWA (React, Vite) і API на `/api/*`.
- **Рушій**: Durable Object у юрисдикції `eu`. Усі серверні запити до біржі, Claude API та новин ідуть із нього.
- **Cron Trigger** раз на 30 хв будить рушій; час звітів (07:30 і 20:30 за Києвом) рушій звіряє сам.
- **D1**: сигнали, звіти, прогнози, журнал, витрати.
- **Вхід**: Cloudflare Access. **Сповіщення**: Web Push і Telegram.

## Етапи

1. Каркас: деплой, вхід, порожня PWA, тест доступності Binance і Claude API з ЄС.
2. Дані і рушій: свічки, індикатори, режим ринку, скан без моделі.
3. Звіти: новини, ранковий і вечірній звіт, push.
4. Сигнали: 2–3 сетапи, фільтр, аналітик і скептик, супровід сигналів.
5. Статистика: калібрування, результат по сетапах, витрати, тижневий розбір.
6. Форвард-тест 8 тижнів без реальних грошей.

## Запуск

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev            # http://localhost:8787
npm test               # тести індикаторів, режиму ринку і скану
```

Скан можна запустити вручну: `POST /api/scan`. Знімки останнього скану: `GET /api/snapshots/latest`.

## Перший деплой

1. `npx wrangler login`
2. `npx wrangler d1 create trading-assistant`, потім встав `database_id` у `wrangler.jsonc`.
3. `npm run db:migrate`
4. `npx wrangler secret put ANTHROPIC_API_KEY`
5. `npm run deploy`
6. Увімкни Cloudflare Access для домену застосунку.
7. Відкрий застосунок і натисни «Перевірити джерела з ЄС». Це перша перевірка плану: Binance і Claude API мають відповісти з рушія.

Потрібен план Workers Paid: скан робить 76 зовнішніх запитів (15 монет × 4 таймфрейми і відкритий інтерес, плюс фандинг), безкоштовний план дає 50.
