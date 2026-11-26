import { botEnabledKey, botInfo, botKeys, CHANNEL_KEYS, CHANNEL_LIMITS, TUBE_BIAS_SIDES, TUBE_LIMITS, type TubeBotId } from "./bots";

/**
 * Схема налаштувань: перевірка значень для API і підписи для екрана «Налаштування».
 * Значення лежать у таблиці settings як JSON; рушій читає їх на кожному запуску, тож зміни діють без деплою.
 */

export type Check = (v: unknown) => { ok: true; value: unknown } | { ok: false; error: string };

export interface SettingSpec {
  key: string;
  group: "Ризик" | "Сигнали" | "Боти" | "Звіти й сповіщення" | "Ринок" | "Акції" | "Модель і дані";
  label: string;
  help?: string;
  kind: "number" | "nullable-number" | "clock" | "quiet" | "report-times" | "symbols" | "symbol" | "macro" | "feeds" | "enum" | "timezone";
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

/** Числове поле бота з межами з TUBE_LIMITS. */
const tubeNum = (field: keyof typeof TUBE_LIMITS): Check => {
  const l = TUBE_LIMITS[field];
  return num(l.min, l.max, l.integer);
};

/** Налаштування одного бота: однаковий набір полів, назва бота в підписі, свій префікс ключів. */
function botSettings(id: TubeBotId): SettingSpec[] {
  const { name, mode } = botInfo(id);
  const k = botKeys(id);
  const order = mode === "breakout" ? "стоп-ордер" : "лімітка";
  const orders = mode === "breakout" ? "стоп-ордери" : "лімітки";
  const g = "Боти" as const;
  return [
    {
      key: botEnabledKey(id),
      group: g,
      label: name,
      help:
        (mode === "breakout"
          ? "Паперова торгівля: щогодини найрухливіші монети з топ-20 за капіталізацією, стоп-ордери над і під ціною входять у бік руху, з тейком і стопом."
          : "Паперова торгівля: щогодини найрухливіші монети з топ-20 за капіталізацією, лімітки під і над ціною ловлять різкий рух і виходять на відкаті, з тейком і стопом.") +
        ` Ордери на біржу не йдуть. Вимкнений бот знімає ${orders}, а відкриті позиції веде до закриття.`,
      kind: "enum",
      options: ["on", "off"],
      check: onOff,
    },
    { key: k.topN, group: g, label: `${name}: монет у списку`, help: "Топ за капіталізацією (CoinGecko) з контрактом на Bybit, без стейблкоїнів і золота.", kind: "number", check: tubeNum("topN") },
    { key: k.pickN, group: g, label: `${name}: найрухливіших монет щогодини`, kind: "number", check: tubeNum("pickN") },
    { key: k.entryAtr, group: g, label: `${name}: відстань ордера, ATR 1h`, help: `На скільки ATR(14) 1h від ціни стоїть дальня ${order}.`, kind: "number", check: tubeNum("entryAtr") },
    { key: k.biasRatio, group: g, label: `${name}: у скільки разів ближчий ордер ближче`, help: "Коли ринок бичачий або ведмежий, один із двох ордерів стоїть ближче до ціни. 2 — удвічі ближче, 1 — однаково.", kind: "number", check: tubeNum("biasRatio") },
    {
      key: k.biasSide,
      group: g,
      label: `${name}: який ордер ближче`,
      help: "counter — проти ринку: у бичачому ринку шорт удвічі ближче за лонг, у ведмежому лонг удвічі ближче за шорт. trend — навпаки, за ринком. off — обидва однаково.",
      kind: "enum",
      options: TUBE_BIAS_SIDES,
      check: (v) => (TUBE_BIAS_SIDES.includes(v as never) ? ok(v) : fail(TUBE_BIAS_SIDES.join(", "))),
    },
    { key: k.stopAtr, group: g, label: `${name}: стоп, ATR 1h від входу`, kind: "number", check: tubeNum("stopAtr") },
    { key: k.targetR, group: g, label: `${name}: тейк-профіт, R`, help: "Частки відстані до стопа: 1 — тейк на тій самій відстані, що й стоп.", kind: "number", check: tubeNum("targetR") },
    { key: k.minStopPct, group: g, label: `${name}: стоп не ближче, % від входу`, kind: "number", check: tubeNum("minStopPct") },
    { key: k.maxHoldHours, group: g, label: `${name}: найдовше тримати позицію, год`, help: "Позиція, що не дійшла ні до тейка, ні до стопа, закривається за ринком.", kind: "number", check: tubeNum("maxHoldHours") },
    { key: k.maxPositions, group: g, label: `${name}: позицій не більше`, help: "Відкриті позиції разом із новими ордерами. Ризик кожної — ризик на угоду з групи «Ризик».", kind: "number", check: tubeNum("maxPositions") },
    {
      key: k.trendOnly,
      group: g,
      label: `${name}: лише в бік руху монети`,
      help:
        mode === "breakout"
          ? "on: ціна вище EMA20 1h — лише стоп-ордер у лонг, нижче — лише в шорт. Так бот не входить проти руху монети."
          : "on: ціна вище EMA20 1h — лише лімітка в лонг (купівля відкату в русі), нижче — лише в шорт. У бектесті найгірші угоди були саме проти руху.",
      kind: "enum",
      options: ["on", "off"],
      check: onOff,
    },
    { key: k.skipNeutral, group: g, label: `${name}: без ордерів у ринку без напрямку`, help: "on: коли ринок не бичачий і не ведмежий, нові ордери не ставляться. У бектесті це найгірший режим.", kind: "enum", options: ["on", "off"], check: onOff },
  ];
}

/** Налаштування Channel 20/10. */
function channelSettings(): SettingSpec[] {
  const g = "Боти" as const;
  const name = botInfo("c2010").name;
  const n = (field: keyof typeof CHANNEL_LIMITS) => num(CHANNEL_LIMITS[field].min, CHANNEL_LIMITS[field].max, CHANNEL_LIMITS[field].integer);
  return [
    {
      key: botEnabledKey("c2010"),
      group: g,
      label: name,
      help: "Паперова торгівля BTC на денних свічках: вхід за ринком після закриття доби за межею 20-денного каналу, стоп за 10-денним каналом підтягується щодня, без тейка. Ордери на біржу не йдуть. Вимкнений бот не входить, а відкриту позицію веде до стопа.",
      kind: "enum",
      options: ["on", "off"],
      check: onOff,
    },
    { key: CHANNEL_KEYS.symbol, group: g, label: `${name}: контракт`, help: "Безстроковий USDT-контракт Bybit. Стратегію перевірено бектестом лише на BTCUSDT.", kind: "symbol", check: symbol },
    { key: CHANNEL_KEYS.entryDays, group: g, label: `${name}: канал входу, діб`, help: "Вхід, коли доба закрилась вище найбільшого High (лонг) або нижче найменшого Low (шорт) стількох попередніх діб.", kind: "number", check: n("entryDays") },
    { key: CHANNEL_KEYS.exitDays, group: g, label: `${name}: канал стопа, діб`, help: "Стоп — найменший Low (лонг) або найбільший High (шорт) стількох останніх діб; після кожного закриття доби рухається лише в бік зменшення ризику.", kind: "number", check: n("exitDays") },
    {
      key: CHANNEL_KEYS.entryWindowHours,
      group: g,
      label: `${name}: вікно входу, год`,
      help: "Скільки годин після закриття доби сигнал ще виконується. Якщо рушій прокинувся пізніше, сигнал прострочений: заднім числом бот не входить.",
      kind: "number",
      check: n("entryWindowHours"),
    },
  ];
}

const nullable = (inner: Check): Check => (v) => (v === null ? ok(null) : inner(v));

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const clock: Check = (v) => (typeof v === "string" && CLOCK.test(v) ? ok(v) : fail("час у форматі ГГ:ХХ"));

const SYMBOL = /^[A-Z0-9]{2,20}USDT$/;

const onOff: Check = (v) => (v === "on" || v === "off" ? ok(v) : fail("on або off"));

const reportTimes: Check = (v) => {
  const t = v as { morning?: unknown; evening?: unknown } | null;
  if (!t || !clock(t.morning).ok || !clock(t.evening).ok) return fail("ранок і вечір у форматі ГГ:ХХ");
  return ok({ morning: t.morning, evening: t.evening });
};

const symbols = (what: string): Check => (v) => {
  if (!Array.isArray(v) || v.length === 0 || v.length > 30) return fail(`від 1 до 30 ${what}`);
  const list = [...new Set(v.map((s) => (typeof s === "string" ? s.trim().toUpperCase() : "")))];
  const bad = list.find((s) => !SYMBOL.test(s));
  return bad !== undefined ? fail(`невідомий формат: ${bad || "порожньо"}`) : ok(list);
};

const symbol: Check = (v) => {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return SYMBOL.test(s) ? ok(s) : fail("символ контракту, наприклад SPYUSDT");
};

const feeds: Check = (v) => {
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
};

export const SETTINGS: SettingSpec[] = [
  { key: "deposit_usd", group: "Ризик", label: "Депозит, $", help: "Для розміру позиції в сповіщеннях; порожньо, якщо не потрібно.", kind: "nullable-number", check: nullable(num(1, 100_000_000)) },
  { key: "risk_per_trade_pct", group: "Ризик", label: "Ризик на угоду, % депозиту", kind: "number", check: num(0.1, 5) },
  { key: "fee_maker_pct", group: "Ризик", label: "Комісія maker, %", help: "Лімітні ордери: вхід у зоні й цілі. Ф'ючерси Binance, VIP 0: 0.02%.", kind: "number", check: num(0, 0.5) },
  { key: "fee_taker_pct", group: "Ризик", label: "Комісія taker, %", help: "Ринкові ордери: стоп, беззбиток, закриття за часом і вхід, якщо ціна вже за серединою зони. Ф'ючерси Binance, VIP 0: 0.05%.", kind: "number", check: num(0, 0.5) },
  { key: "min_stop_pct", group: "Сигнали", label: "Стоп не ближче, % від входу", help: "Кандидати з ближчим стопом відсіюються до моделі: на них комісії з'їдають надто велику частку R. 0 вимикає перевірку.", kind: "number", check: num(0, 10) },
  { key: "skeptic_threshold", group: "Сигнали", label: "Поріг скептика", help: "Частка від 0.3 до 0.95: 0.45 означає 45%. Скептик оцінює, чи пройде ціна +1R до закриття позиції; у бектесті так буває в 48% угод, тож поріг вище 0.5 відхиляє майже всіх кандидатів.", kind: "number", check: num(0.3, 0.95) },
  { key: "max_active_signals", group: "Сигнали", label: "Відкритих сигналів не більше", help: "Що більше місць, то частіше сигнали, але й більший ризик одночасно: 10 відкритих по 0.5% депозиту — це 5%.", kind: "number", check: num(1, 15, true) },
  { key: "max_candidates_per_scan", group: "Сигнали", label: "Кандидатів до моделі за скан", help: "Якщо пробоїв більше, до моделі йдуть найсильніші.", kind: "number", check: num(1, 10, true) },
  { key: "signal_max_hold_hours", group: "Сигнали", label: "Найдовше тримати позицію, год", help: "Позицію закриває стоп, вихід за каналом 4h або цей ліміт. Коротший ліміт швидше звільняє місце для нових сигналів: у бектесті 120 год дали більше сигналів без втрати середнього результату. Не більше 480 год: супровід іде за свічками 1h, а кеш тримає ~20 днів.", kind: "number", check: num(4, 480) },
  { key: "pick_enabled", group: "Сигнали", label: "Ідея скану", help: "Щопів години одна монета, напрямок і вхід, найкращі за технічним аналізом і на думку агента «Ідея скану». Це не сигнал: без скептика й сповіщень.", kind: "enum", options: ["on", "off"], check: onOff },
  {
    key: "pick_style",
    group: "Сигнали",
    label: "Напрямок ідеї скану",
    help: "swing: за трендом 1d і 4h. short: за ринком останніх годин (тренд BTC і монети на 1h і 15m, частка монет вище EMA20 1h), тож у глобальному спаді денний відскок дає лонги. У бектесті за 3 роки без фільтра імпульсу обидва в середньому ≈ 0R; swing добре заробляє в сильному тренді й програє в боковику, short рівніший, але в тренді заробляє менше.",
    kind: "enum",
    options: ["swing", "short"],
    check: (v) => (v === "short" || v === "swing" ? ok(v) : fail("short або swing")),
  },
  {
    key: "pick_min_rsi_1h",
    group: "Сигнали",
    label: "Ідея скану: RSI 1h у бік угоди не нижче",
    help: "Фільтр імпульсу: ідея лише там, де ціна вже рухається в бік угоди (для шорта рахується 100 − RSI), і вхід лише за ринком. У бектесті за 3 роки: без фільтра 18 ідей на добу і −0.01R на ідею, з порогом 65 — 7 на добу і +0.03R, з 70 — 4 на добу і +0.04R. 0 вимикає фільтр.",
    kind: "number",
    check: (v) => (v === 0 ? ok(0) : num(50, 90)(v)),
  },
  { key: "pick_horizon_hours", group: "Сигнали", label: "Горизонт ідеї скану, год", help: "За цей час ціна має дійти до цілі 2R раніше за стоп; інакше ідея закривається за часом. Лімітний вхід, що не виконався за цей час, скасовується.", kind: "number", check: num(4, 96) },
  ...botSettings("hvt"),
  ...botSettings("hvb"),
  ...channelSettings(),
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
  { key: "report_times", group: "Звіти й сповіщення", label: "Час звітів", help: "Крипто. Час звітів по акціях — у групі «Акції».", kind: "report-times", check: reportTimes },
  { key: "weekly_review_time", group: "Звіти й сповіщення", label: "Тижневий розбір, неділя о", kind: "clock", check: clock },
  {
    key: "quiet_hours",
    group: "Звіти й сповіщення",
    label: "Тихі години",
    help: "У цей час сповіщення про нові сигнали не надсилаються. Стоп і вихід із позиції приходять завжди.",
    kind: "quiet",
    check: (v) => {
      if (v === null) return ok(null);
      const q = v as { from?: unknown; to?: unknown };
      if (!clock(q.from).ok || !clock(q.to).ok) return fail("початок і кінець у форматі ГГ:ХХ");
      return ok({ from: q.from, to: q.to });
    },
  },
  { key: "max_signal_pushes_per_day", group: "Звіти й сповіщення", label: "Сповіщень про нові сигнали на добу", help: "Стоп і вихід із позиції приходять завжди й цей ліміт не витрачають.", kind: "number", check: num(0, 50, true) },
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
  { key: "watchlist", group: "Ринок", label: "Монети", help: "Ф'ючерси USDT через кому, до 30.", kind: "symbols", check: symbols("монет") },
  { key: "market_source", group: "Ринок", label: "Джерело даних", help: "auto: Binance, а якщо він недоступний з ЄС, то Bybit.", kind: "enum", options: ["auto", "binance", "bybit"], check: (v) => (v === "auto" || v === "binance" || v === "bybit" ? ok(v) : fail("auto, binance або bybit")) },
  {
    key: "stocks_enabled",
    group: "Акції",
    label: "Режим акцій",
    help: "Безстрокові USDT-контракти Bybit на акції та ETF США: свій скан, сигнали, ідеї, новини й звіти. Нові сигнали й ідеї лише в основну сесію NYSE (9:30–16:00 за Нью-Йорком). Ризик, пороги й ліміти спільні з крипто, місця для сигналів рахуються окремо.",
    kind: "enum",
    options: ["on", "off"],
    check: onOff,
  },
  { key: "stocks_watchlist", group: "Акції", label: "Акції", help: "Контракти Bybit через кому, до 30: AAPLUSDT, NVDAUSDT, ETF SPYUSDT… Символу без контракту на Bybit скан не знайде й напише про це в пульсі.", kind: "symbols", check: symbols("акцій") },
  { key: "stocks_benchmark", group: "Акції", label: "Орієнтир ринку", help: "Замість BTC: його тренд 4h разом із часткою акцій вище EMA200 визначає настрій ринку. Скан бере його завжди, навіть якщо його немає в списку.", kind: "symbol", check: symbol },
  { key: "stocks_report_times", group: "Акції", label: "Час звітів по акціях", help: "Лише в торгові дні США. Стартово 16:00 перед відкриттям і 23:15 після закриття за Києвом.", kind: "report-times", check: reportTimes },
  { key: "stocks_news_feeds", group: "Акції", label: "Стрічки новин фондового ринку", help: "Рядок на стрічку: назва, потім адреса https.", kind: "feeds", check: feeds },
  { key: "news_feeds", group: "Модель і дані", label: "Стрічки новин", help: "Крипто. Рядок на стрічку: назва, потім адреса https.", kind: "feeds", check: feeds },
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

export const SETUP_KEYS = ["trend_breakout"] as const;

/** Перевірка нової версії правил сетапів: усі три сетапи, розумна довжина. */
export function validatePlaybook(raw: unknown): { ok: true; rules: Record<string, string> } | { ok: false; error: string } {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return { ok: false, error: "потрібні правила сетапів" };
  const rules: Record<string, string> = {};
  for (const key of SETUP_KEYS) {
    const text = typeof r[key] === "string" ? (r[key] as string).trim() : "";
    if (text.length < 50 || text.length > 3000) return { ok: false, error: `${key}: від 50 до 3000 символів` };
    rules[key] = text;
  }
  return { ok: true, rules };
}
