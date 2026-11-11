import type { Candle } from "../src/worker/market/types";

/** Свічки з рядів high/low/close; open дорівнює попередньому закриттю. */
export function candles(rows: [high: number, low: number, close: number][], stepMs = 3_600_000): Candle[] {
  return rows.map(([high, low, close], i) => ({
    openTime: i * stepMs,
    closeTime: (i + 1) * stepMs - 1,
    open: i === 0 ? close : rows[i - 1]![2],
    high,
    low,
    close,
    volume: 100,
  }));
}

/** Свічки з одних закриттів: high/low на ±spread від закриття. */
export function fromCloses(closes: number[], spread = 0.5, stepMs = 3_600_000): Candle[] {
  return candles(closes.map((c) => [c + spread, c - spread, c]), stepMs);
}
