import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BybitApiError, BybitClient, BybitMarket, UncertainError } from "../src/b2010/bybit";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("b2010: клієнт Bybit V5", () => {
  it("підпис приватного запиту: HMAC(timestamp + key + recvWindow + query)", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const client = new BybitClient({
      base: "https://x",
      credentials: { key: "K", secret: "S" },
      now: () => 1_700_000_000_000,
      fetcher: async (url, init) => {
        seen = { url, headers: init!.headers as Record<string, string> };
        return json({ retCode: 0, retMsg: "OK", result: { list: [] } });
      },
    });
    await client.privateGet("/v5/position/list", { category: "linear", symbol: "BTCUSDT" });
    const expected = createHmac("sha256", "S").update("1700000000000K5000category=linear&symbol=BTCUSDT").digest("hex");
    expect(seen!.url).toBe("https://x/v5/position/list?category=linear&symbol=BTCUSDT");
    expect(seen!.headers["X-BAPI-SIGN"]).toBe(expected);
    expect(seen!.headers["X-BAPI-API-KEY"]).toBe("K");
  });

  it("код помилки — BybitApiError, таймаут і 5xx — UncertainError; ключ не потрапляє в текст", async () => {
    const err = new BybitClient({ base: "https://x", credentials: { key: "SECRETKEY", secret: "S" }, fetcher: async () => json({ retCode: 110072, retMsg: "dup", result: {} }) });
    await expect(err.privatePost("/v5/order/create", {})).rejects.toBeInstanceOf(BybitApiError);
    const down = new BybitClient({ base: "https://x", fetcher: async () => { throw new Error("timeout"); } });
    await expect(down.publicGet("/v5/market/tickers", {})).rejects.toBeInstanceOf(UncertainError);
    const five = new BybitClient({ base: "https://x", fetcher: async () => new Response("", { status: 502 }) });
    await expect(five.publicGet("/v5/market/tickers", {})).rejects.toBeInstanceOf(UncertainError);
    await err.privatePost("/v5/order/create", {}).catch((e: Error) => expect(e.message).not.toContain("SECRETKEY"));
  });

  it("свічки від старих до нових, фандинг і обмеження контракту", async () => {
    const market = new BybitMarket(
      new BybitClient({
        base: "https://x",
        fetcher: async (url) => {
          if (url.includes("/kline")) return json({ retCode: 0, retMsg: "OK", result: { list: [["2000", "2", "3", "1", "2.5", "9"], ["1000", "1", "2", "0.5", "2", "9"]] } });
          if (url.includes("/funding/history")) return json({ retCode: 0, retMsg: "OK", result: { list: [{ fundingRate: "-0.0001", fundingRateTimestamp: "28800000" }] } });
          return json({
            retCode: 0,
            retMsg: "OK",
            result: { list: [{ symbol: "BTCUSDT", status: "Trading", priceFilter: { tickSize: "0.10" }, lotSizeFilter: { qtyStep: "0.001", minOrderQty: "0.001", minNotionalValue: "5", maxMktOrderQty: "119", maxOrderQty: "1190" } }] },
          });
        },
      }),
      "BTCUSDT",
    );
    const k = await market.kline("D", 0, 3000);
    expect(k.map((c) => c.openTime)).toEqual([1000, 2000]);
    expect((await market.fundingHistory(0, 1))[0].rate.toString()).toBe("-0.0001");
    const spec = await market.instrument();
    expect(spec.qtyStep.toString()).toBe("0.001");
    expect(spec.minNotional.toString()).toBe("5");
    expect(spec.maxMktOrderQty.toString()).toBe("119");
  });
});
