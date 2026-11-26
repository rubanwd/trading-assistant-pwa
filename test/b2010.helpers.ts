import { dec, type Dec } from "../src/b2010/decimal";
import { DAY_MS } from "../src/b2010/strategy";
import type { Candle, InstrumentSpec } from "../src/b2010/types";

export const T0 = Date.parse("2026-01-01T00:00:00Z");
export const day = (i: number) => T0 + i * DAY_MS;

/** Денні свічки з [open, high, low, close]. */
export const daily = (rows: [number, number, number, number][], start = 0): Candle[] =>
  rows.map(([o, h, l, c], i) => ({ openTime: day(start + i), open: dec(o), high: dec(h), low: dec(l), close: dec(c) }));

/** n пласких днів: open/close 100, high 105, low 95. */
export const flat = (n: number): [number, number, number, number][] => Array.from({ length: n }, () => [100, 105, 95, 100]);

export const SPEC: InstrumentSpec = {
  symbol: "BTCUSDT",
  status: "Trading",
  tickSize: dec("0.1"),
  qtyStep: dec("0.001"),
  minOrderQty: dec("0.001"),
  minNotional: dec("5"),
  maxMktOrderQty: dec("100"),
};

export const d = (v: string | number): Dec => dec(v);
