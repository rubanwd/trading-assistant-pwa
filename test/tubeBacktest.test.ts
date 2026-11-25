import { describe, expect, it } from "vitest";
import { simulateTube, tubeHours, tubeReport, CYCLE_DELAY_MS } from "../src/backtest/tube";
import type { SymbolCandles } from "../src/backtest/simulate";
import { TUBE_DEFAULTS } from "../src/shared/bots";
import type { Candle } from "../src/worker/market/types";

const M15 = 900_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-01-01T00:00:00Z");

/** Детермінований ряд 15m: випадкове блукання з різкими рухами. */
function walk(seed: number, days: number, start = 100): Candle[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < (days * DAY) / M15; i++) {
    const shock = rand() < 0.01 ? (rand() - 0.5) * 0.06 : 0;
    const open = price;
    const close = open * (1 + (rand() - 0.5) * 0.008 + shock);
    out.push({ openTime: T0 + i * M15, closeTime: T0 + (i + 1) * M15 - 1, open, high: Math.max(open, close) * (1 + rand() * 0.004), low: Math.min(open, close) * (1 - rand() * 0.004), close, volume: 1 + rand() });
    price = close;
  }
  return out;
}

function aggregate(m15: Candle[], step: number): Candle[] {
  const out: Candle[] = [];
  for (const c of m15) {
    const openTime = Math.floor(c.openTime / step) * step;
    const cur = out[out.length - 1];
    if (cur && cur.openTime === openTime) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    } else out.push({ ...c, openTime, closeTime: openTime + step - 1 });
  }
  return out;
}

const symbols: SymbolCandles[] = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"].map((symbol, i) => {
  const m15 = walk(i + 7, 60, 100 * (i + 1));
  return { symbol, "15m": m15, "1h": aggregate(m15, HOUR), "4h": aggregate(m15, 4 * HOUR), "1d": [] };
});

describe("бектест High Value Tube", () => {
  const from = T0 + 20 * DAY;
  const to = T0 + 59 * DAY;
  const hours = tubeHours(symbols, from, to);
  const m15 = new Map(symbols.map((s) => [s.symbol, s["15m"]]));
  const cfg = { ...TUBE_DEFAULTS, topN: 5, maxPositions: 4, trendOnly: false, skipNeutral: false };
  const orders = simulateTube(hours, m15, { cfg, fees: { makerPct: 0.02, takerPct: 0.05 }, slippagePct: 0 });

  it("цикл щогодини о :04 і лише по закритих свічках 1h", () => {
    expect(hours[0]!.t % HOUR).toBe(CYCLE_DELAY_MS);
    for (const h of hours.slice(0, 50)) for (const f of h.features) expect(f.closedAt).toBeLessThan(h.t);
  });

  it("лімітка виконується лише в свою годину; позиції не перевищують ліміт і не дублюються", () => {
    const filled = orders.filter((o) => o.filledAt !== null);
    expect(filled.length).toBeGreaterThan(20);
    for (const o of filled) {
      expect(o.filledAt!).toBeGreaterThanOrEqual(o.createdAt);
      expect(o.filledAt!).toBeLessThan(o.createdAt + HOUR);
    }
    for (const h of hours) {
      const open = filled.filter((o) => o.filledAt! < h.t && (o.resolvedAt === null || o.resolvedAt >= h.t));
      const placed = orders.filter((o) => o.createdAt === h.t);
      // Нові лімітки займають місця, ніби вже виконались.
      expect(open.length + placed.length).toBeLessThanOrEqual(cfg.maxPositions);
      const keys = open.map((o) => `${o.symbol}:${o.side}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const p of placed) expect(keys).not.toContain(`${p.symbol}:${p.side}`);
    }
  });

  it("звіт: R після комісій, частка виконаних, розріз за ближчою й дальньою ліміткою", () => {
    const rep = tubeReport(orders, from, to);
    expect(rep.overall.orders).toBe(orders.length);
    expect(rep.overall.fillRate).toBeGreaterThan(0);
    expect(rep.overall.trades).toBe(orders.filter((o) => o.netR !== null).length);
    const closed = orders.filter((o) => o.netR !== null);
    for (const o of closed) expect(o.netR!).toBeCloseTo(o.resultR! - o.feeR!, 3);
    expect(Object.keys(rep.byDistance).every((k) => ["near", "far", "neutral"].includes(k))).toBe(true);
  });
});
