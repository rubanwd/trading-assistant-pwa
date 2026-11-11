/** Режим ринку. Чисті функції: рахує код, модель лише отримує готові мітки. */

export type Trend = "up" | "down" | "range";
export type Volatility = "low" | "normal" | "high";
export type MarketMood = "risk_on" | "risk_off" | "mixed";

export interface TrendInput {
  close: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
}

/**
 * Тренд за розташуванням ціни та EMA:
 * up, коли close > EMA200 і EMA20 > EMA50 > EMA200; down дзеркально; інакше range.
 * null, коли даних для EMA замало.
 */
export function trend({ close, ema20, ema50, ema200 }: TrendInput): Trend | null {
  if (close === null || ema20 === null || ema50 === null || ema200 === null) return null;
  if (close > ema200 && ema20 > ema50 && ema50 > ema200) return "up";
  if (close < ema200 && ema20 < ema50 && ema50 < ema200) return "down";
  return "range";
}

/** Волатильність за місцем поточного ATR% серед останніх значень (перцентиль 0..1). */
export function volatility(atrPercentile: number | null): Volatility | null {
  if (atrPercentile === null) return null;
  if (atrPercentile >= 0.8) return "high";
  if (atrPercentile <= 0.2) return "low";
  return "normal";
}

export interface SymbolRegime {
  /** Тренд робочого контексту (4h). */
  trend: Trend | null;
  /** Тренд старшого таймфрейму (1d). */
  higherTrend: Trend | null;
  /** Волатильність на таймфреймі входу (1h). */
  volatility: Volatility | null;
}

export interface MarketRegime {
  mood: MarketMood;
  /** Тренд BTC на 4h. */
  btcTrend: Trend | null;
  /** Частка монет із ціною вище EMA200 на 4h (0..1); null, якщо даних немає. */
  breadth: number | null;
  /** Скільки монет увійшло в розрахунок ширини. */
  counted: number;
}

/**
 * Загальний режим: risk_on, коли BTC у висхідному тренді й щонайменше 60% монет вище EMA200 (4h);
 * risk_off, коли BTC у низхідному й таких монет не більше 40%; інакше mixed.
 */
export function marketRegime(
  btcTrend: Trend | null,
  aboveEma200: (boolean | null)[],
): MarketRegime {
  const known = aboveEma200.filter((v): v is boolean => v !== null);
  const breadth = known.length ? known.filter(Boolean).length / known.length : null;
  let mood: MarketMood = "mixed";
  if (breadth !== null) {
    if (btcTrend === "up" && breadth >= 0.6) mood = "risk_on";
    else if (btcTrend === "down" && breadth <= 0.4) mood = "risk_off";
  }
  return { mood, btcTrend, breadth, counted: known.length };
}
