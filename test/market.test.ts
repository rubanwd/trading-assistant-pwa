import { describe, expect, it } from "vitest";
import { BinanceFutures } from "../src/worker/market/binance";
import { BybitLinear } from "../src/worker/market/bybit";
import { FailoverMarket, isGeoBlock } from "../src/worker/market/failover";
import { MarketDataError } from "../src/worker/market/types";

const H = 3_600_000;
const ok = (result: unknown) => Response.json({ retCode: 0, retMsg: "OK", result });

describe("Bybit", () => {
  it("свічки: від нових до старих, без незакритої, час закриття з інтервалу", async () => {
    const urls: string[] = [];
    const api = new BybitLinear(
      async (url) => {
        urls.push(url);
        return ok({ list: [[String(2 * H), "3", "4", "2", "3.5", "10", "0"], [String(H), "2", "3", "1", "2.5", "10", "0"], ["0", "1", "2", "0.5", "1.5", "10", "0"]] });
      },
      "https://api.bybit.com",
      () => 2 * H + 10,
    );
    const c = await api.candles("BTCUSDT", "1h", 2);
    expect(urls[0]).toBe("https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=3");
    expect(c).toEqual([
      { openTime: 0, closeTime: H - 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { openTime: H, closeTime: 2 * H - 1, open: 2, high: 3, low: 1, close: 2.5, volume: 10 },
    ]);
  });

  it("фандинг і відкритий інтерес у USDT за ціною маркування", async () => {
    const api = new BybitLinear(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/v5/market/tickers") {
        return ok({ list: [{ symbol: "BTCUSDT", markPrice: "100", indexPrice: "99.9", fundingRate: "0.0001", nextFundingTime: "123" }, { symbol: "BTC-26DEC", markPrice: "1", indexPrice: "1", fundingRate: "", nextFundingTime: "0" }] });
      }
      return ok({ list: [{ openInterest: "20", timestamp: "2" }, { openInterest: "10", timestamp: "1" }] });
    });
    expect([...(await api.funding()).entries()]).toEqual([["BTCUSDT", { symbol: "BTCUSDT", rate: 0.0001, markPrice: 100, indexPrice: 99.9, nextFundingTime: 123 }]]);
    expect(await api.openInterest("BTCUSDT", 2)).toEqual([
      { ts: 1, contracts: 10, valueUsd: 1000 },
      { ts: 2, contracts: 20, valueUsd: 2000 },
    ]);
  });

  it("помилка в тілі відповіді й блокування за локацією", async () => {
    await expect(new BybitLinear(async () => Response.json({ retCode: 10001, retMsg: "params error", result: {} })).funding()).rejects.toThrow("10001");
    await expect(new BybitLinear(async () => new Response("", { status: 403 })).funding()).rejects.toMatchObject({ status: 403 });
  });
});

describe("перемикання на запасну біржу", () => {
  const blocked = new BinanceFutures(async () => new Response("", { status: 451 }));
  const fine = (name: string) =>
    ({
      name,
      candles: async () => [],
      funding: async () => new Map(),
      openInterest: async () => [{ ts: 1, contracts: 1, valueUsd: 1 }],
    });

  it("на 451 переходить на запасну і лишається там", async () => {
    let primaryCalls = 0;
    const primary = { ...fine("binance"), funding: async () => { primaryCalls++; throw new MarketDataError("HTTP 451", 451); } };
    const m = new FailoverMarket(primary, fine("bybit"));
    expect(m.name).toBe("binance");
    expect(await m.funding()).toEqual(new Map());
    expect(m.name).toBe("bybit");
    expect(m.reason).toContain("451");
    await m.funding();
    expect(primaryCalls).toBe(1);
  });

  it("інші помилки не перемикають", async () => {
    const primary = { ...fine("binance"), candles: async () => { throw new MarketDataError("HTTP 500", 500); } };
    const m = new FailoverMarket(primary, fine("bybit"));
    await expect(m.candles("BTCUSDT", "1h", 10)).rejects.toThrow("500");
    expect(m.name).toBe("binance");
  });

  it("справжній адаптер Binance з 451 вважається блокуванням", async () => {
    const err = await blocked.funding().catch((e) => e);
    expect(isGeoBlock(err)).toBe(true);
    expect(isGeoBlock(new MarketDataError("x", null))).toBe(false);
  });
});
