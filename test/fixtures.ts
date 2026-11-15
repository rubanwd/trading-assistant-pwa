import type { Candle } from "../src/worker/market/types";

const H = 3_600_000;

/** Свічки 1h з ряду [open, high, low, close]; час закриття останньої дорівнює end. */
export function ohlc(rows: [number, number, number, number][], end = 1_800_000_000_000, step = H): Candle[] {
  return rows.map(([open, high, low, close], i) => {
    const closeTime = end - (rows.length - 1 - i) * step;
    return { openTime: closeTime - step + 1, closeTime, open, high, low, close, volume: 100 };
  });
}

/** Ряд із закриттів: open дорівнює попередньому закриттю, тіні по wick з кожного боку. */
export function path(closes: number[], wick = 0.3): [number, number, number, number][] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    return [open, Math.max(open, close) + wick, Math.min(open, close) - wick, close];
  });
}

/** Висхідний тренд із дрібними відкатами: +1.1, −0.1, … від start. */
export function uptrend(n: number, start = 100): number[] {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1]! + (i % 2 ? 1.1 : -0.1));
  return out;
}

/**
 * Трендовий пробій 4h: 230 свічок зростання (ціна над EMA200), 20 свічок вузького діапазону
 * і свічка, що закрилась вище максимуму діапазону.
 */
export function trendBreakoutSeries(): [number, number, number, number][] {
  const closes: number[] = [];
  for (let i = 0; i < 230; i++) closes.push(100 + i * 0.2);
  const base = closes[closes.length - 1]!;
  for (let i = 0; i < 20; i++) closes.push(base + (i % 2 ? 0.5 : -0.5));
  closes.push(base + 3);
  return path(closes);
}

/** Дзеркало ряду відносно рівня: з лонгового сетапу виходить шортовий. */
export function flip(rows: [number, number, number, number][], around = 250): [number, number, number, number][] {
  return rows.map(([o, h, l, cl]) => [around - o, around - l, around - h, around - cl]);
}
