/**
 * Схема налаштувань: перевірка значень для API і підписи для екрана «Налаштування».
 * Значення лежать у таблиці settings як JSON; рушій читає їх на кожному запуску, тож зміни діють без деплою.
 */

export type Check = (v: unknown) => { ok: true; value: unknown } | { ok: false; error: string };

export interface SettingSpec {
  key: string;
  group: "Ризик" | "Сигнали" | "Звіти й сповіщення" | "Ринок" | "Модель і дані";
  label: string;
  help?: string;
  kind: "number" | "nullable-number" | "clock" | "quiet" | "report-times" | "symbols" | "macro" | "feeds" | "enum" | "timezone";
  options?: string[];
  check: Check;
}

const ok = (value: unknown) => ({ ok: true as const, value });
const fail = (error: string) => ({ ok: false as const, error });

function num(min: number, max: number, integer = false): Check {
  return (v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return fail("має бути числом");
    if (integer && !Number.isInteger(v)) return fail("має бути цілим");
    if (v < min || v > max) return fail(`від ${min} до ${max}`);
    return ok(v);
  };
}

const nullable = (inner: Check): Check => (v) => (v === null ? ok(null) : inner(v));

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const clock: Check = (v) => (typeof v === "string" && CLOCK.test(v) ? ok(v) : fail("час у форматі ГГ:ХХ"));

const SYMBOL = /^[A-Z0-9]{2,20}USDT$/;

export const SETTINGS: SettingSpec[] = [
  { key: "deposit_usd", group: "Ризик", label: "Депозит, $", help: "Для розміру позиції в сповіщеннях; порожньо, якщо не потрібно.", kind: "nullable-number", check: nullable(num(1, 100_000_000)) },
  { key: "risk_per_trade_pct", group: "Ризик", label: "Ризик на угоду, % депозиту", kind: "number", check: num(0.1, 5) },
  { key: "fee_pct_per_side", group: "Ризик", label: "Комісія за угоду, %", help: "Тейкер ф'ючерсів Binance: 0.05%. Вхід і вихід платять окремо.", kind: "number", check: num(0, 0.5) },
  { key: "min_rr", group: "Сигнали", label: "Мінімальний R:R", kind: "number", check: num(1, 10) },
  { key: "skeptic_threshold", group: "Сигнали", label: "Поріг скептика", help: "Частка від 0.5 до 0.95: 0.6 означає 60%.", kind: "number", check: num(0.5, 0.95) },
  { key: "max_active_signals", group: "Сигнали", label: "Відкритих сигналів не більше", kind: "number", check: num(1, 10, true) },
  { key: "max_candidates_per_scan", group: "Сигнали", label: "Кандидатів до моделі за скан", kind: "number", check: num(1, 10, true) },
  { key: "signal_ttl_hours", group: "Сигнали", label: "Сигнал чекає входу, год", kind: "number", check: num(1, 72) },
  { key: "signal_max_hold_hours", group: "Сигнали", label: "Найдовше тримати позицію, год", kind: "number", check: num(4, 240) },
  { key: "signal_cooldown_hours", group: "Сигнали", label: "Пауза для того самого сетапу по монеті, год", kind: "number", check: num(0, 72) },
  { key: "macro_blackout_hours", group: "Сигнали", label: "Без нових сигналів до макроподії, год", kind: "number", check: num(0, 24) },
  {
    key: "macro_events",
    group: "Сигнали",
    label: "Макроподії",
    help: "Рядок на подію: дата й час у UTC, потім назва. Наприклад: 2026-12-16 19:00 ФРС",
    kind: "macro",
    check: (v) => {
      if (!Array.isArray(v) || v.length > 100) return fail("до 100 подій");
      const out: { at: string; name: string }[] = [];
      for (const e of v) {
        const at = typeof e === "string" ? e : (e as { at?: unknown })?.at;
        const name = typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name.trim().slice(0, 60) : "";
        const t = typeof at === "string" ? Date.parse(at) : NaN;
        if (!Number.isFinite(t)) return fail(`незрозуміла дата: ${String(at)}`);
        out.push({ at: new Date(t).toISOString(), name });
      }
      return ok(out.sort((a, b) => a.at.localeCompare(b.at)));
    },
  },
  {
    key: "report_times",
    group: "Звіти й сповіщення",
    label: "Час звітів",
    kind: "report-times",
    check: (v) => {
      const t = v as { morning?: unknown; evening?: unknown } | null;
      if (!t || !clock(t.morning).ok || !clock(t.evening).ok) return fail("ранок і вечір у форматі ГГ:ХХ");
      return ok({ morning: t.morning, evening: t.evening });
    },
  },
  { key: "weekly_review_time", group: "Звіти й сповіщення", label: "Тижневий розбір, неділя о", kind: "clock", check: clock },
  {
    key: "quiet_hours",
    group: "Звіти й сповіщення",
    label: "Тихі години",
    help: "У цей час сповіщення про сигнали не надсилаються.",
    kind: "quiet",
    check: (v) => {
      if (v === null) return ok(null);
      const q = v as { from?: unknown; to?: unknown };
      if (!clock(q.from).ok || !clock(q.to).ok) return fail("початок і кінець у форматі ГГ:ХХ");
      return ok({ from: q.from, to: q.to });
    },
  },
  { key: "max_signal_pushes_per_day", group: "Звіти й сповіщення", label: "Сповіщень про сигнали на добу", kind: "number", check: num(0, 50, true) },
  {
    key: "timezone",
    group: "Звіти й сповіщення",
    label: "Часовий пояс",
    kind: "timezone",
    check: (v) => {
      if (typeof v !== "string" || v.length > 60) return fail("назва часового поясу IANA");
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return ok(v);
      } catch {
        return fail("невідомий часовий пояс");
      }
    },
  },
  {
    key: "watchlist",
    group: "Ринок",
    label: "Монети",
    help: "Ф'ючерси USDT через кому, до 30.",
    kind: "symbols",
    check: (v) => {
      if (!Array.isArray(v) || v.length === 0 || v.length > 30) return fail("від 1 до 30 монет");
      const list = [...new Set(v.map((s) => (typeof s === "string" ? s.trim().toUpperCase() : "")))];
      const bad = list.find((s) => !SYMBOL.test(s));
      return bad !== undefined ? fail(`невідомий формат: ${bad || "порожньо"}`) : ok(list);
    },
  },
  { key: "market_source", group: "Ринок", label: "Джерело даних", help: "auto: Binance, а якщо він недоступний з ЄС, то Bybit.", kind: "enum", options: ["auto", "binance", "bybit"], check: (v) => (v === "auto" || v === "binance" || v === "bybit" ? ok(v) : fail("auto, binance або bybit")) },
  { key: "llm_budget_usd", group: "Модель і дані", label: "Стеля витрат на моделі, $ на місяць", kind: "number", check: num(1, 500) },
  {
    key: "news_feeds",
    group: "Модель і дані",
    label: "Стрічки новин",
    help: "Рядок на стрічку: назва, потім адреса https.",
    kind: "feeds",
    check: (v) => {
      if (!Array.isArray(v) || v.length > 10) return fail("до 10 стрічок");
      const out: { source: string; url: string }[] = [];
      for (const f of v) {
        const { source, url } = (f ?? {}) as { source?: unknown; url?: unknown };
        if (typeof source !== "string" || !/^[\w.-]{1,40}$/.test(source)) return fail("назва стрічки: латиниця, цифри, до 40 символів");
        try {
          if (typeof url !== "string" || new URL(url).protocol !== "https:") throw new Error();
        } catch {
          return fail(`адреса має починатися з https: ${String(url)}`);
        }
        out.push({ source, url });
      }
      return ok(out);
    },
  },
  { key: "retention_days", group: "Модель і дані", label: "Зберігати знімки й новини, днів", kind: "number", check: num(7, 365, true) },
  { key: "playbook_min_days", group: "Модель і дані", label: "Нова версія правил не частіше ніж раз на, днів", kind: "number", check: num(0, 60, true) },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** Перевіряє зміни. Невідомі ключі відкидаються як помилка, щоб не писати сміття в базу. */
export function validateSettings(changes: Record<string, unknown>): { values: Record<string, unknown>; errors: Record<string, string> } {
  const values: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [key, raw] of Object.entries(changes)) {
    const spec = BY_KEY.get(key);
    if (!spec) {
      errors[key] = "невідоме налаштування";
      continue;
    }
    const res = spec.check(raw);
    if (res.ok) values[key] = res.value;
    else errors[key] = res.error;
  }
  return { values, errors };
}

export const SETUP_KEYS = ["trend_pullback", "breakout_retest", "liquidity_sweep"] as const;

/** Перевірка нової версії правил сетапів: усі три сетапи, розумна довжина. */
export function validatePlaybook(raw: unknown): { ok: true; rules: Record<string, string> } | { ok: false; error: string } {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return { ok: false, error: "потрібні правила для трьох сетапів" };
  const rules: Record<string, string> = {};
  for (const key of SETUP_KEYS) {
    const text = typeof r[key] === "string" ? (r[key] as string).trim() : "";
    if (text.length < 50 || text.length > 3000) return { ok: false, error: `${key}: від 50 до 3000 символів` };
    rules[key] = text;
  }
  return { ok: true, rules };
}
