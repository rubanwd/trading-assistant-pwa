import type { Candle } from "./market/types";

/** Прогноз закриває код за правилом; модель дає лише ймовірність. */
export const CONDITIONS = ["touch_above", "touch_below", "close_above", "close_below"] as const;
export type Condition = (typeof CONDITIONS)[number];

export interface ForecastRule {
  v: 1;
  symbol: string;
  condition: Condition;
  level: number;
  /** Початок вікна перевірки, ISO UTC. */
  from: string;
  /** Назва сценарію зі звіту. */
  title: string;
}

/**
 * Результат прогнозу за свічками 1h у вікні (from, resolveAt]:
 * touch_*: ціна хоч раз дісталась рівня; close_*: останнє закриття у вікні за рівнем.
 * null, якщо у вікні немає жодної закритої свічки.
 */
export function resolveForecast(rule: ForecastRule, candles: Candle[], resolveAt: number): 0 | 1 | null {
  const from = Date.parse(rule.from);
  const window = candles.filter((c) => c.openTime >= from && c.closeTime <= resolveAt);
  const lastCandle = window[window.length - 1];
  if (!lastCandle) return null;
  switch (rule.condition) {
    case "touch_above":
      return window.some((c) => c.high >= rule.level) ? 1 : 0;
    case "touch_below":
      return window.some((c) => c.low <= rule.level) ? 1 : 0;
    case "close_above":
      return lastCandle.close > rule.level ? 1 : 0;
    case "close_below":
      return lastCandle.close < rule.level ? 1 : 0;
  }
}

const PHRASE: Record<Condition, string> = {
  touch_above: "торкнеться рівня або підніметься вище",
  touch_below: "торкнеться рівня або опуститься нижче",
  close_above: "закриється вище",
  close_below: "закриється нижче",
};

/** Твердження для бази та екрана складає код, а не модель. */
export function statement(rule: ForecastRule, deadline: string): string {
  return `${rule.symbol} ${PHRASE[rule.condition]} ${rule.level} до ${deadline}`;
}
