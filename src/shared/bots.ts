import type { Desk } from "./desk";

/**
 * Боти: стратегії, що самі «виставляють» ордери за правилами коду й ведуть облік кожного.
 * Поки це паперова торгівля на публічних даних Bybit: ордери не йдуть на біржу, виконання рахує код за свічками.
 */

export const BOT_IDS = ["hvt"] as const;
export type BotId = (typeof BOT_IDS)[number];
export const isBotId = (v: unknown): v is BotId => typeof v === "string" && (BOT_IDS as readonly string[]).includes(v);

export interface BotInfo {
  id: BotId;
  name: string;
  desk: Desk;
  /** Одне речення для списку ботів. */
  summary: string;
}

export const BOTS: BotInfo[] = [
  {
    id: "hvt",
    name: "High Value Tube",
    desk: "crypto",
    summary: "Щогодини бере 3 найрухливіші з топ-20 монет Bybit і ставить по лімітці в лонг і шорт на краях «труби» навколо ціни: ловить різкий рух і виходить на відкаті.",
  },
];

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
}

/** Стартові значення: підібрані бектестом на 2023-11 — 2025-10 і перевірені на 2025-11 — 2026-10 (див. README). */
export const TUBE_DEFAULTS: TubeConfig = {
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
};

/** Ключ налаштування для кожного поля. */
export const TUBE_KEYS: Record<keyof TubeConfig, string> = {
  topN: "tube_top_n",
  pickN: "tube_pick_n",
  entryAtr: "tube_entry_atr",
  biasRatio: "tube_bias_ratio",
  biasSide: "tube_bias_side",
  stopAtr: "tube_stop_atr",
  targetR: "tube_target_r",
  minStopPct: "tube_min_stop_pct",
  maxHoldHours: "tube_max_hold_hours",
  maxPositions: "tube_max_positions",
};

/** Межі числових полів: те саме перевіряє схема налаштувань. */
export const TUBE_LIMITS: Record<Exclude<keyof TubeConfig, "biasSide">, { min: number; max: number; integer?: boolean }> = {
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
export function tubeConfig(values: Record<string, unknown>): TubeConfig {
  const out = { ...TUBE_DEFAULTS };
  for (const [field, limits] of Object.entries(TUBE_LIMITS) as [Exclude<keyof TubeConfig, "biasSide">, (typeof TUBE_LIMITS)[keyof typeof TUBE_LIMITS]][]) {
    const v = values[TUBE_KEYS[field]];
    if (typeof v === "number" && Number.isFinite(v) && v >= limits.min && v <= limits.max && (!limits.integer || Number.isInteger(v))) out[field] = v;
  }
  const side = values[TUBE_KEYS.biasSide];
  if (TUBE_BIAS_SIDES.includes(side as TubeBiasSide)) out.biasSide = side as TubeBiasSide;
  return out;
}
