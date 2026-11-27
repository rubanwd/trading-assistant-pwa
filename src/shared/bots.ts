import type { Desk } from "./desk";

/**
 * Боти: стратегії, що самі «виставляють» ордери за правилами коду й ведуть облік кожного.
 * Поки це паперова торгівля на публічних даних Bybit: ордери не йдуть на біржу, виконання рахує код за свічками.
 */

export const BOT_IDS = ["hvt", "hvb", "c2010"] as const;
export type BotId = (typeof BOT_IDS)[number];
export const isBotId = (v: unknown): v is BotId => typeof v === "string" && (BOT_IDS as readonly string[]).includes(v);

/** Боти «труби» (High Value Tube і High Value Breakout): щогодинні ордери на найрухливіших монетах топ-20. */
export const TUBE_BOT_IDS = ["hvt", "hvb"] as const;
export type TubeBotId = (typeof TUBE_BOT_IDS)[number];
export const isTubeBot = (v: unknown): v is TubeBotId => typeof v === "string" && (TUBE_BOT_IDS as readonly string[]).includes(v);

/**
 * fade — лімітки на відстані від ціни ловлять різкий рух і виходять на відкаті (High Value Tube);
 * breakout — стоп-ордери на тій самій відстані входять у бік руху, коли ціна її проходить (High Value Breakout);
 * channel — денний пробій каналу з підтягуванням стопа за коротшим каналом, без тейка (Channel 20/10).
 */
export type BotMode = "fade" | "breakout" | "channel";

export interface BotInfo {
  id: BotId;
  name: string;
  desk: Desk;
  mode: BotMode;
  /** Одне речення для списку ботів. */
  summary: string;
}

export const BOTS: BotInfo[] = [
  {
    id: "hvt",
    name: "High Value Tube",
    desk: "crypto",
    mode: "fade",
    summary: "Щогодини бере 3 найрухливіші з топ-20 монет Bybit і ставить лімітки на краях «труби» навколо ціни: ловить різкий рух і виходить на відкаті.",
  },
  {
    id: "hvb",
    name: "High Value Breakout",
    desk: "crypto",
    mode: "breakout",
    summary: "Ті самі 3 найрухливіші монети, але навпаки: стоп-ордери над і під ціною входять у бік різкого руху, коли ціна проходить край «труби», і забирають продовження.",
  },
  {
    id: "c2010",
    name: "Channel 20/10",
    desk: "crypto",
    mode: "channel",
    summary: "BTC на денних свічках: вхід за ринком, коли доба закрилась вище максимуму чи нижче мінімуму попередніх 20 днів; стоп за 10-денним каналом щодня підтягується, тейка немає. Одна позиція.",
  },
];

export const botInfo = (id: BotId): BotInfo => BOTS.find((b) => b.id === id)!;

/**
 * Стартовий список бота, якщо CoinGecko недоступний: топ-20 за капіталізацією на листопад 2026
 * без стейблкоїнів, золота й обгорток, з контрактом на Bybit і Binance. Ним же користується бектест.
 */
export const TUBE_FALLBACK = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT", "TRXUSDT", "HYPEUSDT", "ZECUSDT", "XMRUSDT", "DOGEUSDT",
  "LINKUSDT", "ADAUSDT", "XLMUSDT", "BCHUSDT", "NEARUSDT", "LTCUSDT", "AVAXUSDT", "UNIUSDT", "SUIUSDT", "HBARUSDT",
];

/** Що з двох ордерів ставиться ближче до ціни, коли ринок має напрямок. */
export type TubeBiasSide = "counter" | "trend" | "off";
export const TUBE_BIAS_SIDES: TubeBiasSide[] = ["counter", "trend", "off"];

/** Налаштування бота High Value Tube. Однакові для рушія й бектесту. */
export interface TubeConfig {
  /** Скільки монет з найбільшою капіталізацією в списку бота. */
  topN: number;
  /** Скільки найрухливіших монет бере кожна година. */
  pickN: number;
  /** Відстань дальнього ордера від ціни, ATR(14) 1h. */
  entryAtr: number;
  /** У скільки разів ближчий ордер ближче за дальній, коли ринок має напрямок. */
  biasRatio: number;
  /**
   * counter: ближче ордер проти ринку (бичачий ринок — шорт удвічі ближче за лонг, ведмежий — навпаки), як задано;
   * trend: ближче ордер за ринком; off: обидва на однаковій відстані.
   */
  biasSide: TubeBiasSide;
  /** Стоп за входом, ATR(14) 1h. */
  stopAtr: number;
  /** Тейк-профіт, R (частки ризику до стопа). */
  targetR: number;
  /** Стоп не ближче, % від входу: на ближчому комісії з'їдають надто велику частку R. */
  minStopPct: number;
  /** Позиція закривається за ринком, якщо за цей час не дійшла ні до тейка, ні до стопа. */
  maxHoldHours: number;
  /** Відкритих позицій разом із новими ордерами не більше. */
  maxPositions: number;
  /**
   * Лише ордер у бік руху монети: ціна вище EMA20 1h — лише лонг, нижче — лише шорт.
   * Для ліміток це купівля відкату в русі, для стоп-ордерів — вхід у продовження.
   */
  trendOnly: boolean;
  /** Без нових ордерів, коли ринок без напрямку (не бичачий і не ведмежий). */
  skipNeutral: boolean;
}

/** Стартові значення: підібрані бектестом на 2023-11 — 2025-10 і перевірені на 2025-11 — 2026-10 (див. README). */
export const BOT_DEFAULTS: Record<TubeBotId, TubeConfig> = {
  hvt: {
    topN: 20,
    pickN: 3,
    entryAtr: 1,
    biasRatio: 2,
    biasSide: "counter",
    stopAtr: 3,
    targetR: 0.5,
    minStopPct: 0.5,
    maxHoldHours: 12,
    maxPositions: 6,
    trendOnly: true,
    skipNeutral: true,
  },
  hvb: {
    topN: 20,
    pickN: 3,
    entryAtr: 2,
    biasRatio: 2,
    biasSide: "off",
    stopAtr: 3,
    targetR: 3,
    minStopPct: 0.5,
    maxHoldHours: 12,
    maxPositions: 6,
    trendOnly: false,
    skipNeutral: false,
  },
};
export const TUBE_DEFAULTS = BOT_DEFAULTS.hvt;

/** Префікс налаштувань бота: tube_* для High Value Tube, brk_* для High Value Breakout. */
export const BOT_PREFIX: Record<BotId, string> = { hvt: "tube", hvb: "brk", c2010: "chn" };

const FIELD_KEY: Record<keyof TubeConfig, string> = {
  topN: "top_n",
  pickN: "pick_n",
  entryAtr: "entry_atr",
  biasRatio: "bias_ratio",
  biasSide: "bias_side",
  stopAtr: "stop_atr",
  targetR: "target_r",
  minStopPct: "min_stop_pct",
  maxHoldHours: "max_hold_hours",
  maxPositions: "max_positions",
  trendOnly: "trend_only",
  skipNeutral: "skip_neutral",
};

/** Ключі налаштувань бота для кожного поля. */
export const botKeys = (id: TubeBotId): Record<keyof TubeConfig, string> =>
  Object.fromEntries(Object.entries(FIELD_KEY).map(([f, k]) => [f, `${BOT_PREFIX[id]}_${k}`])) as Record<keyof TubeConfig, string>;
/** Ключ «бот увімкнено»: on | off. */
export const botEnabledKey = (id: BotId) => `${BOT_PREFIX[id]}_enabled`;
export const TUBE_KEYS = botKeys("hvt");

/** Межі числових полів: те саме перевіряє схема налаштувань. */
type NumField = Exclude<keyof TubeConfig, "biasSide" | "trendOnly" | "skipNeutral">;
export const TUBE_LIMITS: Record<NumField, { min: number; max: number; integer?: boolean }> = {
  topN: { min: 5, max: 30, integer: true },
  pickN: { min: 1, max: 5, integer: true },
  entryAtr: { min: 0.5, max: 6 },
  biasRatio: { min: 1, max: 4 },
  stopAtr: { min: 0.5, max: 6 },
  targetR: { min: 0.3, max: 4 },
  minStopPct: { min: 0, max: 5 },
  maxHoldHours: { min: 1, max: 96 },
  maxPositions: { min: 1, max: 15, integer: true },
};

/** Налаштування бота з таблиці settings; непридатне значення замінюється стартовим. */
export function tubeConfig(values: Record<string, unknown>, id: TubeBotId = "hvt"): TubeConfig {
  const out = { ...BOT_DEFAULTS[id] };
  const keys = botKeys(id);
  for (const [field, limits] of Object.entries(TUBE_LIMITS) as [NumField, (typeof TUBE_LIMITS)[NumField]][]) {
    const v = values[keys[field]];
    if (typeof v === "number" && Number.isFinite(v) && v >= limits.min && v <= limits.max && (!limits.integer || Number.isInteger(v))) out[field] = v;
  }
  const side = values[keys.biasSide];
  if (TUBE_BIAS_SIDES.includes(side as TubeBiasSide)) out.biasSide = side as TubeBiasSide;
  for (const field of ["trendOnly", "skipNeutral"] as const) {
    const v = values[keys[field]];
    if (v === "on" || v === "off") out[field] = v === "on";
  }
  return out;
}

// ── Channel 20/10 ──────────────────────────────────────────────────────────

/** Налаштування бота Channel 20/10. Однакові для рушія й бектесту. */
export interface ChannelConfig {
  /** Контракт Bybit (linear USDT perpetual). Стратегія задумана для BTCUSDT. */
  symbol: string;
  /** Канал входу: найбільший High / найменший Low попередніх N завершених діб, без свічки сигналу. */
  entryDays: number;
  /** Канал стопа: найменший Low / найбільший High останніх N завершених діб, разом зі свічкою сигналу. */
  exitDays: number;
  /**
   * Скільки годин від початку доби UTC сигнал ще можна виконати. Рушій прокидається о :03 і :33;
   * якщо перший цикл нової доби запізнився більше, сигнал прострочений — заднім числом бот не входить.
   */
  entryWindowHours: number;
}

/** Стартові значення — правила стратегії 20/10. За бектестом їх не підбирали. */
export const CHANNEL_DEFAULTS: ChannelConfig = { symbol: "BTCUSDT", entryDays: 20, exitDays: 10, entryWindowHours: 2 };

type ChannelNum = Exclude<keyof ChannelConfig, "symbol">;
export const CHANNEL_LIMITS: Record<ChannelNum, { min: number; max: number; integer?: boolean }> = {
  entryDays: { min: 5, max: 100, integer: true },
  exitDays: { min: 2, max: 100, integer: true },
  entryWindowHours: { min: 1, max: 12 },
};

export const CHANNEL_KEYS: Record<keyof ChannelConfig, string> = {
  symbol: "chn_symbol",
  entryDays: "chn_entry_days",
  exitDays: "chn_exit_days",
  entryWindowHours: "chn_entry_window_hours",
};

const CHANNEL_SYMBOL = /^[A-Z0-9]{2,20}USDT$/;

/** Налаштування Channel 20/10 з таблиці settings; непридатне значення замінюється стартовим. */
export function channelConfig(values: Record<string, unknown>): ChannelConfig {
  const out = { ...CHANNEL_DEFAULTS };
  for (const [field, l] of Object.entries(CHANNEL_LIMITS) as [ChannelNum, (typeof CHANNEL_LIMITS)[ChannelNum]][]) {
    const v = values[CHANNEL_KEYS[field]];
    if (typeof v === "number" && Number.isFinite(v) && v >= l.min && v <= l.max && (!l.integer || Number.isInteger(v))) out[field] = v;
  }
  const sym = values[CHANNEL_KEYS.symbol];
  if (typeof sym === "string" && CHANNEL_SYMBOL.test(sym)) out.symbol = sym;
  return out;
}

// ── Імпульс між монетами ───────────────────────────────────────────────────

export type MomentumWeighting = "equal" | "vol";

/** Налаштування бота «Імпульс між монетами». Однакові для рушія й бектесту. */
export interface MomentumConfig {
  /** Скільки монет у списку (топ за капіталізацією в рушії, за обігом у бектесті). */
  topN: number;
  /** Доходність за скільки завершених діб ранжує монети. */
  lookbackDays: number;
  /** Монет у кожній стороні. */
  legs: number;
  /** equal — рівні частки; vol — частки обернено пропорційні волатильності за volDays діб. */
  weighting: MomentumWeighting;
  volDays: number;
}

/** Стартові значення вибрано до бектесту за дослідженнями крипто-імпульсу (1–4 тижні, щотижневе перебалансування). */
export const MOMENTUM_DEFAULTS: MomentumConfig = { topN: 20, lookbackDays: 28, legs: 4, weighting: "equal", volDays: 30 };

// ── Фандинг-кері ───────────────────────────────────────────────────────────

/** Налаштування бота «Фандинг-кері». Однакові для рушія й бектесту. */
export interface CarryConfig {
  /** Скільки монет у списку, з якого бот входить. */
  topN: number;
  /** Середня ставка за скільки діб вирішує вхід і вихід. */
  lookbackDays: number;
  /** Вхід, коли фандинг не нижче, % річних. */
  entryApr: number;
  /** Вихід, коли фандинг нижче, % річних. */
  exitApr: number;
  /** Позицій одночасно; кожна — 1/maxPositions капіталу. */
  maxPositions: number;
}

/** Стартові значення вибрано до бектесту: вхід від 20% річних, вихід нижче 5%, середнє за 3 доби, до 5 позицій. */
export const CARRY_DEFAULTS: CarryConfig = { topN: 20, lookbackDays: 3, entryApr: 20, exitApr: 5, maxPositions: 5 };
