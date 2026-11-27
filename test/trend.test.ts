import { describe, expect, it } from "vitest";
import { simulateTrend, type TrendSeries } from "../src/backtest/trend";
import { TREND_BASKET_DEFAULTS, trendConfig } from "../src/shared/bots";
import { validateSettings } from "../src/shared/settings";
import { DAY_MS, trendState, trendTargets, withBand } from "../src/worker/bots/trend";
import type { Candle } from "../src/worker/market/types";

const T0 = Date.parse("2026-01-01T00:00:00Z");
/** n діб з цінами closes[i]; open = попереднє закриття. */
const daily = (closes: number[]): Candle[] =>
  closes.map((cl, i) => ({ openTime: T0 + i * DAY_MS, closeTime: T0 + (i + 1) * DAY_MS - 1, open: i ? closes[i - 1]! : cl, high: cl, low: cl, close: cl, volume: 1000 }));
/** Зростання з чергуванням ±2%, щоб волатильність не була нульовою. */
const zig = (n: number, drift: number) => Array.from({ length: n }, (_, i) => 100 * (1 + drift) ** i * (i % 2 ? 1.02 : 0.98));
const cfg = { ...TREND_BASKET_DEFAULTS, smaDays: 20, volDays: 10 };

describe("trend basket", () => {
  it("лонг вище середньої, без позиції нижче, шорт лише з both", () => {
    expect(trendState({ symbol: "A", daily: daily(zig(30, 0.01)) }, cfg)!.dir).toBe(1);
    expect(trendState({ symbol: "A", daily: daily(zig(30, -0.01)) }, cfg)!.dir).toBe(0);
    expect(trendState({ symbol: "A", daily: daily(zig(30, -0.01)) }, { ...cfg, sides: "both" })!.dir).toBe(-1);
    expect(trendState({ symbol: "A", daily: daily(zig(10, 0.01)) }, cfg)).toBeNull();
  });

  it("частка обернено пропорційна волатильності, з межею й без плеча", () => {
    const st = (symbol: string, vol: number) => ({ symbol, close: 1, sma: 0.9, vol, dir: 1 as const });
    const t = trendTargets([st("A", 0.5), st("B", 1), st("C", 0.1)], { ...TREND_BASKET_DEFAULTS, topN: 10, targetVol: 0.5 });
    expect(t.get("A")).toBeCloseTo(0.1);
    expect(t.get("B")).toBeCloseTo(0.05);
    expect(t.get("C")).toBeCloseTo(0.2); // межа 2/topN
    const many = trendTargets(Array.from({ length: 10 }, (_, i) => st(`S${i}`, 0.1)), { ...TREND_BASKET_DEFAULTS, topN: 5 });
    expect([...many.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("смуга: дрібна зміна не перебалансовує, зміна знака й нуль — завжди", () => {
    expect(withBand(0.1, 0.11, 0.25)).toBe(0.1);
    expect(withBand(0.1, 0.2, 0.25)).toBe(0.2);
    expect(withBand(0.1, 0, 0.25)).toBe(0);
    expect(withBand(0.1, -0.1, 0.25)).toBe(-0.1);
  });

  it("налаштування: межі й сторони", () => {
    expect(trendConfig({ trb_sides: "both", trb_sma_days: 5 })).toMatchObject({ sides: "both", smaDays: TREND_BASKET_DEFAULTS.smaDays });
    expect(validateSettings({ trb_band: 2 }).errors.trb_band).toBeTruthy();
  });

  it("симуляція: зростаюча монета дає плюс, комісія з обігу", () => {
    const s: TrendSeries[] = [{ symbol: "A", daily: daily(zig(60, 0.01)), funding: [] }];
    const days = simulateTrend(s, T0 + 30 * DAY_MS, T0 + 40 * DAY_MS, { cfg: { ...cfg, topN: 1, targetVol: 100 }, takerPct: 0.1, slippagePct: 0, volumeDays: 30 });
    expect(days).toHaveLength(10);
    expect(days[0]!.exposure).toBeCloseTo(1);
    expect(days[0]!.fee).toBeCloseTo(0.001);
    expect(days.reduce((a, d) => a + d.gross, 0)).toBeGreaterThan(0);
  });
});
