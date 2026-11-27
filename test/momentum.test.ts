import { describe, expect, it } from "vitest";
import { simulateMomentum, type MomentumSeries } from "../src/backtest/momentum";
import { MOMENTUM_DEFAULTS } from "../src/shared/bots";
import { DAY_MS, legFunding, momentumRank, planMomentum, turnover, WEEK_MS, weekStart } from "../src/worker/bots/momentum";
import type { Candle } from "../src/worker/market/types";

const MON = Date.parse("2026-01-05T00:00:00Z");
const candle = (openTime: number, open: number, close: number): Candle => ({ openTime, closeTime: openTime + DAY_MS - 1, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1000 });
/** n діб від start з геометричним приростом g за добу. */
const series = (start: number, n: number, g: number, p0 = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => candle(start + i * DAY_MS, p0 * (1 + g) ** i, p0 * (1 + g) ** (i + 1)));

describe("momentum", () => {
  it("weekStart повертає понеділок 00:00 UTC", () => {
    expect(weekStart(MON)).toBe(MON);
    expect(weekStart(MON + 3 * DAY_MS + 5)).toBe(MON);
    expect(weekStart(MON - 1)).toBe(MON - WEEK_MS);
  });

  it("імпульс — доходність за lookback, null на пропуску", () => {
    const d = series(MON - 40 * DAY_MS, 40, 0.01);
    const r = momentumRank({ symbol: "A", daily: d }, { lookbackDays: 28, volDays: 30 })!;
    expect(r.momentum).toBeCloseTo(1.01 ** 28 - 1, 6);
    expect(momentumRank({ symbol: "A", daily: [...d.slice(0, 20), ...d.slice(21)] }, { lookbackDays: 28, volDays: 30 })).toBeNull();
  });

  it("лонг найсильніших, шорт найслабших, по 50% на сторону", () => {
    const inputs = [0.02, 0.01, 0.005, 0, -0.005, -0.01, -0.02, 0.03, -0.03].map((g, i) => ({ symbol: `S${i}`, daily: series(MON - 40 * DAY_MS, 40, g) }));
    const { legs } = planMomentum(inputs, { ...MOMENTUM_DEFAULTS, legs: 2 });
    expect(legs.filter((l) => l.side === "long").map((l) => l.symbol)).toEqual(["S7", "S0"]);
    expect(legs.filter((l) => l.side === "short").map((l) => l.symbol)).toEqual(["S6", "S8"]);
    for (const s of ["long", "short"]) expect(legs.filter((l) => l.side === s).reduce((a, l) => a + l.weight, 0)).toBeCloseTo(0.5, 6);
    expect(planMomentum(inputs.slice(0, 3), { ...MOMENTUM_DEFAULTS, legs: 2 }).legs).toEqual([]);
  });

  it("обіг і фандинг", () => {
    expect(turnover(new Map([["A", 0.25], ["B", -0.25]]), new Map([["A", 0.25], ["C", 0.25]]))).toBeCloseTo(0.5);
    expect(turnover(new Map(), new Map([["A", 0.5], ["B", -0.5]]))).toBeCloseTo(1);
    // Лонг платить додатну ставку, шорт отримує; нарахування рівно на початку не входить.
    const ev = [{ at: 0, paid: 0.001 }, { at: 8, paid: 0.001 }];
    expect(legFunding(0.25, ev, 0, 10)).toBeCloseTo(-0.00025);
    expect(legFunding(-0.25, ev, 0, 10)).toBeCloseTo(0.00025);
  });

  it("симуляція: сильна монета росте далі — тиждень у плюсі, комісія з обігу", () => {
    const start = MON - 60 * DAY_MS;
    const s: MomentumSeries[] = [0.02, 0.01, -0.01, -0.02].map((g, i) => ({ symbol: `S${i}`, daily: series(start, 75, g), funding: [] }));
    const weeks = simulateMomentum(s, MON, MON + WEEK_MS, { cfg: { ...MOMENTUM_DEFAULTS, legs: 1, topN: 4 }, takerPct: 0.05, slippagePct: 0, volumeDays: 30 });
    expect(weeks).toHaveLength(1);
    const w = weeks[0]!;
    expect(w.legs.map((l) => `${l.side}:${l.symbol}`)).toEqual(["long:S0", "short:S3"]);
    expect(w.fee).toBeCloseTo(0.0005);
    expect(w.gross).toBeCloseTo(0.5 * (1.02 ** 7 - 1) - 0.5 * (0.98 ** 7 - 1), 6);
  });
});
