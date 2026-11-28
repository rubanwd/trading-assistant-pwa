import { describe, expect, it } from "vitest";
import { simulateCarry, type CarrySeries } from "../src/backtest/carry";
import { CARRY_DEFAULTS, carryConfig } from "../src/shared/bots";
import { validateSettings } from "../src/shared/settings";
import { carryLegCost, carryNetPct, DAY_MS, fundingApr, planCarry, spotBase } from "../src/worker/bots/carry";
import { BybitLinear } from "../src/worker/market/bybit";
import type { Candle } from "../src/worker/market/types";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const H8 = 8 * 3_600_000;
const daily = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ openTime: T0 + i * DAY_MS, closeTime: T0 + (i + 1) * DAY_MS - 1, open: 1, high: 1, low: 1, close: 1, volume: 1000 }));
/** Нарахування кожні 8 год від T0 зі ставкою rate(i). */
const funding = (n: number, rate: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ at: T0 + (i + 1) * H8, paid: rate(i) }));

describe("carry", () => {
  it("fundingApr: сума ставок, приведена до року", () => {
    // 0.01% кожні 8 год = 0.03% на добу ≈ 10.95% річних.
    expect(fundingApr(funding(9, () => 0.0001), T0, T0 + 3 * DAY_MS)).toBeCloseTo(10.95, 2);
    expect(fundingApr([], T0, T0 + DAY_MS)).toBeNull();
  });

  it("planCarry: вихід нижче порогу, вхід від найвищого, не більше місць", () => {
    const apr = new Map<string, number | null>([["A", 50], ["B", 30], ["C", 25], ["D", 10], ["E", 3], ["F", null]]);
    const cfg = { ...CARRY_DEFAULTS, maxPositions: 3 };
    // E нижче 5% — вихід; F без даних — вихід; D 10% — лишається (між порогами), але й не входить.
    expect(planCarry(["D", "E", "F"], apr, ["A", "B", "C", "D"], cfg)).toEqual({ exit: ["E", "F"], enter: ["A", "B"] });
    expect(planCarry([], apr, ["C", "B", "A"], { ...cfg, maxPositions: 1 }).enter).toEqual(["A"]);
  });

  it("spotBase знімає множник контракту", () => {
    expect(spotBase("1000PEPEUSDT")).toBe("PEPE");
    expect(spotBase("SHIB1000USDT")).toBe("SHIB");
    expect(spotBase("1INCHUSDT")).toBe("1INCH");
    expect(spotBase("BTCUSDT")).toBe("BTC");
  });

  it("комісії й результат у % капіталу", () => {
    expect(carryLegCost({ spotTakerPct: 0.1, perpTakerPct: 0.055, slippagePct: 0.05 })).toBeCloseTo(0.00255);
    expect(carryNetPct({ funding: 0.01, fee: 0.002, share: 0.2 })).toBeCloseTo(0.16);
  });

  it("carryConfig: вихід не вище входу, непридатне — стартове", () => {
    expect(carryConfig({ cry_entry_apr: 10, cry_exit_apr: 30 }).exitApr).toBe(10);
    expect(carryConfig({ cry_max_positions: 0.5 }).maxPositions).toBe(CARRY_DEFAULTS.maxPositions);
    expect(validateSettings({ cry_entry_apr: 1000 }).errors.cry_entry_apr).toBeTruthy();
    expect(validateSettings({ cry_lookback_days: 7 }).errors).toEqual({});
  });

  it("симуляція: вхід на високому фандингу, нарахування після входу, вихід на падінні", () => {
    // 6 діб по 0.03% кожні 8 год (≈33% річних), далі нуль.
    const s: CarrySeries[] = [{ symbol: "A", daily: daily(20), funding: funding(60, (i) => (i < 18 ? 0.0003 : 0)) }];
    const fees = { spotTakerPct: 0.1, perpTakerPct: 0.05, slippagePct: 0 };
    const r = simulateCarry(s, T0, T0 + 20 * DAY_MS, { cfg: { ...CARRY_DEFAULTS, lookbackDays: 1, maxPositions: 1, topN: 1 }, fees, volumeDays: 30 });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    // Вхід на добі 1 (після трьох нарахувань доби 0), вихід, коли за добу нарахувань нуль: доба 7.
    expect(t.openedAt).toBe(T0 + DAY_MS);
    expect(t.closedAt).toBe(T0 + 7 * DAY_MS);
    expect(t.funding).toBeCloseTo(15 * 0.0003);
    expect(t.cost).toBeCloseTo(0.003);
    expect(t.net).toBeCloseTo(0.0045 - 0.003);
  });

  it("спотові пари Bybit: лише до USDT і ті, що торгуються", async () => {
    const api = new BybitLinear(async (url) => {
      expect(new URL(url).searchParams.get("category")).toBe("spot");
      const list = [
        { symbol: "BTCUSDT", status: "Trading", baseCoin: "BTC", quoteCoin: "USDT" },
        { symbol: "BTCUSDC", status: "Trading", baseCoin: "BTC", quoteCoin: "USDC" },
        { symbol: "OLDUSDT", status: "Closed", baseCoin: "OLD", quoteCoin: "USDT" },
      ];
      return Response.json({ retCode: 0, retMsg: "OK", result: { list } });
    });
    expect([...(await api.spotUsdt())]).toEqual([["BTC", "BTCUSDT"]]);
  });
});
