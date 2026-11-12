import { describe, expect, it } from "vitest";
import { BinanceFutures, closedOnly, parseKlines } from "../src/worker/market/binance";
import { TIMEFRAME_MS, type MarketData, type Timeframe } from "../src/worker/market/types";
import { scan } from "../src/worker/scan";
import { fromCloses } from "./helpers";

const NOW = 1_800_000_000_000;

/** Біржа-заглушка: лінійний тренд із заданим нахилом на кожну монету. */
function fakeMarket(slopes: Record<string, number>, fail: string[] = []): MarketData {
  return {
    name: "fake",
    async candles(symbol, timeframe: Timeframe, limit) {
      if (fail.includes(symbol)) throw new Error("HTTP 451");
      const step = TIMEFRAME_MS[timeframe];
      const closes = Array.from({ length: limit }, (_, i) => 1000 + slopes[symbol]! * i + Math.sin(i) * 2);
      const out = fromCloses(closes, 1, step);
      const shift = NOW - out[out.length - 1]!.closeTime - 1;
      return out.map((c) => ({ ...c, openTime: c.openTime + shift, closeTime: c.closeTime + shift }));
    },
    async funding() {
      return new Map([
        ["BTCUSDT", { symbol: "BTCUSDT", rate: 0.0001, markPrice: 1, indexPrice: 1, nextFundingTime: NOW + 3_600_000 }],
      ]);
    },
    async openInterest(_symbol, points) {
      return Array.from({ length: points }, (_, i) => ({
        ts: NOW - (points - 1 - i) * 900_000,
        contracts: 1000 + i,
        valueUsd: 5_000_000.4,
      }));
    },
  };
}

describe("scan", () => {
  it("рахує знімки, режим ринку і не падає через одну монету", async () => {
    const res = await scan(
      fakeMarket({ BTCUSDT: 1, ETHUSDT: 1, SOLUSDT: -1, XRPUSDT: 1 }, ["XRPUSDT"]),
      ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"],
      NOW,
    );
    expect(res.snapshots.map((s) => s.symbol)).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
    expect(res.errors).toEqual([{ symbol: "XRPUSDT", message: "Error: HTTP 451" }]);
    expect(res.market).toEqual({ mood: "risk_on", btcTrend: "up", breadth: 2 / 3, counted: 3 });

    const btc = res.snapshots[0]!;
    expect(btc.regime.trend).toBe("up");
    expect(btc.regime.higherTrend).toBe("up");
    expect(btc.tf["1h"].ema20!).toBeGreaterThan(btc.tf["1h"].ema200!);
    expect(btc.tf["1h"].rsi14!).toBeGreaterThan(50);
    expect(btc.tf["1h"].atr14!).toBeGreaterThan(0);
    expect(btc.tf["1h"].closedAt).toBe(new Date(NOW - 1).toISOString());
    expect(btc.funding?.rate).toBe(0.0001);
    expect(btc.openInterest).toEqual({
      valueUsd: 5_000_000,
      contracts: 1096,
      change24hPct: 9.6,
      at: new Date(NOW).toISOString(),
    });
    expect(res.snapshots[1]!.funding).toBeNull();
    expect(res.snapshots[2]!.regime.trend).toBe("down");
    // Знімок має пережити JSON без втрат: саме так він лягає в snapshots.features.
    expect(JSON.parse(JSON.stringify(btc))).toEqual(btc);
  });
});

describe("BinanceFutures", () => {
  const kline = (openTime: number, close: string) => [
    openTime, "100.0", "101.5", "99.5", close, "1234.5", openTime + 3_600_000 - 1, "0", 10, "0", "0", "0",
  ];

  it("розбирає свічки і відкидає незакриту", () => {
    const parsed = parseKlines([kline(0, "100.5"), kline(3_600_000, "101.0")] as never);
    expect(parsed[0]).toEqual({
      openTime: 0, closeTime: 3_599_999, open: 100, high: 101.5, low: 99.5, close: 100.5, volume: 1234.5,
    });
    expect(closedOnly(parsed, 3_600_000 + 5)).toHaveLength(1);
  });

  it("ходить на публічні адреси fapi і мапить відповіді", async () => {
    const urls: string[] = [];
    const bodies: Record<string, unknown> = {
      "/fapi/v1/klines": [kline(0, "100.5"), kline(3_600_000, "101.0"), kline(7_200_000, "102.0")],
      "/fapi/v1/premiumIndex": [
        { symbol: "BTCUSDT", markPrice: "101.2", indexPrice: "101.1", lastFundingRate: "0.00010000", nextFundingTime: 9 },
      ],
      "/futures/data/openInterestHist": [
        { symbol: "BTCUSDT", sumOpenInterest: "20.5", sumOpenInterestValue: "2050.0", timestamp: 2 },
        { symbol: "BTCUSDT", sumOpenInterest: "20.0", sumOpenInterestValue: "2000.0", timestamp: 1 },
      ],
    };
    const api = new BinanceFutures(
      async (url) => {
        urls.push(url);
        return Response.json(bodies[new URL(url).pathname]);
      },
      "https://fapi.binance.com",
      () => 7_200_000 + 10,
    );

    const c = await api.candles("BTCUSDT", "1h", 2);
    expect(c.map((x) => x.close)).toEqual([100.5, 101]);
    expect(urls[0]).toBe("https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=3");

    expect((await api.funding()).get("BTCUSDT")).toEqual({
      symbol: "BTCUSDT", rate: 0.0001, markPrice: 101.2, indexPrice: 101.1, nextFundingTime: 9,
    });
    expect(await api.openInterest("BTCUSDT", 2)).toEqual([
      { ts: 1, contracts: 20, valueUsd: 2000 },
      { ts: 2, contracts: 20.5, valueUsd: 2050 },
    ]);
  });

  it("на 451 кидає помилку зі статусом", async () => {
    const api = new BinanceFutures(async () => new Response("", { status: 451 }));
    await expect(api.funding()).rejects.toMatchObject({ name: "MarketDataError", status: 451 });
  });
});
