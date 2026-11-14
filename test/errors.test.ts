import { describe, expect, it } from "vitest";
import { errorSummary } from "../src/shared/errors";

describe("короткий опис помилки запуску", () => {
  it("ліміт запитів Cloudflare пояснює зрозуміло", () => {
    const e = "SUIUSDT: MarketDataError: bybit-linear /v5/market/kline: Error: Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits; TONUSDT: MarketDataError: …";
    expect(errorSummary(e)).toBe("Cloudflare обмежив кількість запитів за один запуск: потрібен план Workers Paid.");
  });

  it("блокування біржі за локацією", () => {
    expect(errorSummary("BTCUSDT: MarketDataError: binance-futures /fapi/v1/klines: HTTP 451 (заборонена локація)")).toBe("біржа недоступна з дата-центру рушія.");
  });

  it("решта: перша помилка, обрізана, і скільки ще", () => {
    expect(errorSummary("a; b; c")).toBe("a (і ще 2)");
    expect(errorSummary("x".repeat(200))).toBe(`${"x".repeat(120)}…`);
    expect(errorSummary(null)).toBe("");
  });
});
