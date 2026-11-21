/**
 * Режими застосунку: крипто (ф'ючерси Binance або Bybit) і акції (безстрокові USDT-контракти Bybit на акції та ETF США).
 * Кожен режим має свій список інструментів, скан, сигнали, ідеї скану, новини й звіти; ризик і пороги спільні.
 */

export const DESKS = ["crypto", "stocks"] as const;
export type Desk = (typeof DESKS)[number];

export const DESK_LABEL: Record<Desk, string> = { crypto: "Крипто", stocks: "Акції" };

export const isDesk = (v: unknown): v is Desk => v === "crypto" || v === "stocks";
/** Режим із запиту; без нього або з невідомим значенням — крипто, як було до появи акцій. */
export const parseDesk = (v: unknown): Desk => (isDesk(v) ? v : "crypto");

/** Орієнтир ринку крипто: тренд BTC визначає настрій ринку. Для акцій орієнтир задає налаштування stocks_benchmark. */
export const CRYPTO_LEADER = "BTCUSDT";
export const STOCKS_LEADER_DEFAULT = "SPYUSDT";

/**
 * Налаштування, які в режимі акцій мають власне значення з префіксом stocks_.
 * Решта (ризик, пороги, ліміти, макроподії) спільні для обох режимів.
 */
export const DESK_KEYS = ["watchlist", "news_feeds", "report_times"] as const;
export type DeskKey = (typeof DESK_KEYS)[number];
export const deskKey = (desk: Desk, key: DeskKey): string => (desk === "crypto" ? key : `stocks_${key}`);

// ── Сесія фондового ринку США ──────────────────────────────────────────────

/**
 * Дні, коли NYSE і Nasdaq закриті (крім вихідних). Скорочені дні не враховуються.
 * Список треба доповнювати щороку; після останньої дати вихідні дні рахуються лише за суботою й неділею.
 */
export const US_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

const NY = "America/New_York";
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

function nyTime(now: number): { date: string; minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: NY,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

/** Чи є ця дата (за Нью-Йорком) торговим днем США. */
export function usTradingDay(now: number): boolean {
  const t = nyTime(now);
  return t.weekday >= 1 && t.weekday <= 5 && !US_HOLIDAYS.has(t.date);
}

/** Чи триває основна сесія NYSE/Nasdaq (9:30–16:00 за Нью-Йорком, торговий день). */
export function usSessionOpen(now: number): boolean {
  if (!usTradingDay(now)) return false;
  const m = nyTime(now).minutes;
  return m >= OPEN_MIN && m < CLOSE_MIN;
}
