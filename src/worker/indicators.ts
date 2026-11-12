import type { Candle } from "./market/types";

/**
 * Індикатори. Чисті функції без доступу до мережі й бази.
 * Кожна серія має довжину входу; поки даних для розрахунку замало, значення NaN.
 */

/** Останнє скінченне значення серії або null. */
export function last(series: number[]): number | null {
  const v = series[series.length - 1];
  return v !== undefined && Number.isFinite(v) ? v : null;
}

/** Проста ковзна середня. */
export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA. Початкове значення: SMA перших `period` точок. */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Згладжування Вайлдера (RMA): початок з SMA, далі alpha = 1/period. */
function wilder(values: number[], period: number, offset: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period < 1 || values.length < offset + period) return out;
  let prev = 0;
  for (let i = offset; i < offset + period; i++) prev += values[i]!;
  prev /= period;
  out[offset + period - 1] = prev;
  for (let i = offset + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** RSI Вайлдера. Перше значення з'являється на індексі `period`. */
export function rsi(closes: number[], period = 14): number[] {
  const gains = new Array<number>(closes.length).fill(0);
  const losses = new Array<number>(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gains[i] = d;
    else losses[i] = -d;
  }
  // Зміна на індексі 0 не існує, тому згладжування починається з 1.
  const avgGain = wilder(gains, period, 1);
  const avgLoss = wilder(losses, period, 1);
  return closes.map((_, i) => {
    const g = avgGain[i]!;
    const l = avgLoss[i]!;
    if (!Number.isFinite(g) || !Number.isFinite(l)) return NaN;
    if (l === 0) return g === 0 ? 50 : 100;
    return 100 - 100 / (1 + g / l);
  });
}

/** Істинний діапазон. Для першої свічки це high - low. */
export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

/** ATR Вайлдера. Перше значення з'являється на індексі `period`. */
export function atr(candles: Candle[], period = 14): number[] {
  // Перший TR без попереднього закриття в розрахунок не йде.
  return wilder(trueRange(candles), period, 1);
}

export interface Pivot {
  index: number;
  price: number;
  kind: "high" | "low";
}

/**
 * Розворотні точки: максимум (мінімум) свічки строго вищий (нижчий)
 * за `span` свічок ліворуч і не нижчий (не вищий) за `span` свічок праворуч.
 * Останні `span` свічок підтвердити ще не можна, тому вони не розглядаються.
 */
export function pivots(candles: Candle[], span = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let i = span; i < candles.length - span; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= span; j++) {
      const l = candles[i - j]!;
      const r = candles[i + j]!;
      if (!(c.high > l.high && c.high >= r.high)) isHigh = false;
      if (!(c.low < l.low && c.low <= r.low)) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: c.high, kind: "high" });
    if (isLow) out.push({ index: i, price: c.low, kind: "low" });
  }
  return out;
}

export interface Level {
  price: number;
  /** Скільки розворотних точок злилось у рівень. */
  touches: number;
  /** Індекс свічки останнього дотику. */
  lastIndex: number;
}

export interface Levels {
  /** Нижче ціни, від найближчого. */
  support: Level[];
  /** Вище ціни, від найближчого. */
  resistance: Level[];
}

/**
 * Рівні підтримки й опору: розворотні точки, ближчі одна до одної ніж `tolerance`,
 * зливаються в один рівень (середня ціна). Повертає до `max` найближчих з кожного боку.
 */
export function levels(
  candles: Candle[],
  price: number,
  tolerance: number,
  opts: { span?: number; max?: number } = {},
): Levels {
  const { span = 3, max = 3 } = opts;
  const sorted = pivots(candles, span).sort((a, b) => a.price - b.price);
  const clusters: Level[] = [];
  let sum = 0;
  for (const p of sorted) {
    const cur = clusters[clusters.length - 1];
    if (cur && p.price - cur.price <= tolerance) {
      sum += p.price;
      cur.touches += 1;
      cur.price = sum / cur.touches;
      cur.lastIndex = Math.max(cur.lastIndex, p.index);
    } else {
      sum = p.price;
      clusters.push({ price: p.price, touches: 1, lastIndex: p.index });
    }
  }
  return {
    support: clusters.filter((l) => l.price < price).reverse().slice(0, max),
    resistance: clusters.filter((l) => l.price > price).slice(0, max),
  };
}

/** Частка значень серії, не більших за останнє (0..1). Для оцінки «висока чи низька волатильність». */
export function percentileOfLast(series: number[], lookback: number): number | null {
  const window = series.slice(-lookback).filter(Number.isFinite);
  if (window.length < 2) return null;
  const cur = window[window.length - 1]!;
  return window.filter((v) => v <= cur).length / window.length;
}
