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

/** Відкат у висхідному тренді: тренд, спад до EMA20 і свічка зростання наостанок. */
export function pullbackSeries(): [number, number, number, number][] {
  const closes = uptrend(110);
  const top = closes[closes.length - 1]!;
  for (let i = 1; i <= 6; i++) closes.push(top - i * 0.75);
  const rows = path(closes);
  const prev = closes[closes.length - 1]!;
  rows.push([prev, prev + 1.0, prev - 0.5, prev + 0.9]);
  return rows;
}

/** Діапазон під опором 110 з кількома дотиками, пробій і ретест рівня. */
export function breakoutSeries(): [number, number, number, number][] {
  const closes: number[] = [];
  for (let i = 0; i < 80; i++) closes.push(105 + 4 * Math.sin(i / 4));
  const rows = path(closes, 0.4).map(([o, h, l, cl]): [number, number, number, number] => [o, Math.min(h, 110), l, Math.min(cl, 109.4)]);
  const last = rows[rows.length - 1]![3];
  rows.push([last, 112.6, last - 0.2, 112.2]); // пробій
  rows.push([112.2, 113.4, 111.9, 113.0]);
  rows.push([113.0, 113.6, 112.0, 112.3]);
  rows.push([112.3, 112.5, 109.7, 111.4]); // ретест рівня 110
  return rows;
}

/** Діапазон із розворотним мінімумом, який остання свічка проколює тінню і закривається вище. */
export function sweepSeries(): [number, number, number, number][] {
  const closes: number[] = [];
  for (let i = 0; i < 90; i++) closes.push(105 + 3 * Math.sin(i / 5));
  const rows = path(closes, 0.3);
  const lows = rows.slice(-45, -6).map((r) => r[2]);
  const floor = Math.min(...lows);
  const prev = rows[rows.length - 1]![3];
  rows.push([prev, prev + 0.2, floor - 0.6, floor + 0.9]);
  return rows;
}

/** Дзеркало ряду відносно рівня: з лонгового сетапу виходить шортовий. */
export function flip(rows: [number, number, number, number][], around = 250): [number, number, number, number][] {
  return rows.map(([o, h, l, cl]) => [around - o, around - l, around - h, around - cl]);
}
