import { describe, expect, it } from "vitest";
import { deskKey, parseDesk, usSessionOpen, usTradingDay } from "../src/shared/desk";
import { validateSettings } from "../src/shared/settings";
import { forDesk } from "../src/worker/desk";
import { BybitLinear } from "../src/worker/market/bybit";
import { CATEGORIES, sanitizeTriage, STOCK_CATEGORIES, triageSchema, triageSystem } from "../src/worker/news/triage";
import { pickInput, scoreSide } from "../src/worker/pick";
import type { MarketRegime } from "../src/worker/regime";
import { reportInput } from "../src/worker/report/input";
import { reportSystem } from "../src/worker/report/schema";
import { marketFromSnapshots } from "../src/worker/scan";
import { buildSnapshot, type Snapshot } from "../src/worker/snapshot";
import { ohlc, path, uptrend } from "./fixtures";

const at = (iso: string) => Date.parse(iso);
const NOW = 1_800_000_000_000;

function snapshot(symbol: string): Snapshot {
  const c = ohlc(path(uptrend(260)), NOW);
  return buildSnapshot({ symbol, now: NOW, candles: { "15m": c, "1h": c, "4h": c, "1d": c }, funding: null, openInterest: null });
}

describe("режими", () => {
  it("режим із запиту: невідоме значення — крипто", () => {
    expect(parseDesk("stocks")).toBe("stocks");
    expect(parseDesk("forex")).toBe("crypto");
    expect(parseDesk(undefined)).toBe("crypto");
  });

  it("налаштування режиму акцій мають префікс stocks_", () => {
    expect(deskKey("crypto", "watchlist")).toBe("watchlist");
    expect(deskKey("stocks", "watchlist")).toBe("stocks_watchlist");
    expect(deskKey("stocks", "report_times")).toBe("stocks_report_times");
  });

  it("налаштування акцій перевіряються: символи у верхньому регістрі, орієнтир — один символ", () => {
    const { values, errors } = validateSettings({ stocks_watchlist: ["aaplusdt", " NVDAUSDT", "AAPLUSDT"], stocks_benchmark: "qqqusdt", stocks_enabled: "off" });
    expect(errors).toEqual({});
    expect(values).toEqual({ stocks_watchlist: ["AAPLUSDT", "NVDAUSDT"], stocks_benchmark: "QQQUSDT", stocks_enabled: "off" });
    expect(Object.keys(validateSettings({ stocks_benchmark: "SPY", stocks_enabled: "yes" }).errors).sort()).toEqual(["stocks_benchmark", "stocks_enabled"]);
  });
});

describe("сесія NYSE", () => {
  it("взимку (EST) основна сесія 14:30–21:00 UTC", () => {
    expect(usSessionOpen(at("2026-11-20T14:29:00Z"))).toBe(false);
    expect(usSessionOpen(at("2026-11-20T14:30:00Z"))).toBe(true);
    expect(usSessionOpen(at("2026-11-20T20:59:00Z"))).toBe(true);
    expect(usSessionOpen(at("2026-11-20T21:00:00Z"))).toBe(false);
  });

  it("влітку (EDT) на годину раніше: 13:30–20:00 UTC", () => {
    expect(usSessionOpen(at("2026-07-01T13:15:00Z"))).toBe(false);
    expect(usSessionOpen(at("2026-07-01T13:45:00Z"))).toBe(true);
    expect(usSessionOpen(at("2026-07-01T20:30:00Z"))).toBe(false);
  });

  it("вихідні й свята закриті", () => {
    expect(usTradingDay(at("2026-11-21T16:00:00Z"))).toBe(false); // субота
    expect(usSessionOpen(at("2026-11-26T16:00:00Z"))).toBe(false); // День подяки
    expect(usTradingDay(at("2026-11-27T16:00:00Z"))).toBe(true);
    // Пізній вечір п'ятниці за UTC ще п'ятниця в Нью-Йорку.
    expect(usTradingDay(at("2026-11-21T03:00:00Z"))).toBe(true);
  });
});

describe("джерело акцій: Bybit", () => {
  it("контракти беруться з instruments-info за symbolType, лише ті, що торгуються", async () => {
    const urls: string[] = [];
    const api = new BybitLinear(async (url) => {
      urls.push(url);
      return Response.json({
        retCode: 0,
        retMsg: "OK",
        result: { list: [{ symbol: "AAPLUSDT", status: "Trading" }, { symbol: "XYZUSDT", status: "PreLaunch" }, { symbol: "NVDAUSDT", status: "Trading" }] },
      });
    });
    expect(await api.instruments("stock")).toEqual(["AAPLUSDT", "NVDAUSDT"]);
    const u = new URL(urls[0]!);
    expect(u.pathname).toBe("/v5/market/instruments-info");
    expect(u.searchParams.get("category")).toBe("linear");
    expect(u.searchParams.get("symbolType")).toBe("stock");
  });
});

describe("моделі в режимі акцій", () => {
  it("для крипто промпт не змінюється, для акцій додано пояснення з орієнтиром", () => {
    expect(forDesk("system", "crypto", "BTCUSDT")).toBe("system");
    const s = forDesk("system", "stocks", "SPYUSDT");
    expect(s.startsWith("system\n")).toBe(true);
    expect(s).toContain("SPYUSDT");
    expect(s).toContain("9:30–16:00");
  });

  it("звіт по акціях не просить рівнів BTC і ETH", () => {
    expect(reportSystem("morning")).toContain("BTC і ETH");
    const stocks = reportSystem("morning", "stocks");
    expect(stocks).not.toContain("BTC і ETH");
    expect(stocks).toContain("орієнтира ринку");
  });

  it("вхід звіту без фону крипто не має домінації BTC і страху й жадібності", () => {
    const market: MarketRegime = { mood: "mixed", btcTrend: "up", breadth: 0.5, counted: 2 };
    const input = reportInput({ kind: "morning", localDate: "2026-11-20", localClock: "16:00", market, context: null, snapshots: [], news: [], priorForecasts: [], openSignals: [] });
    expect(Object.keys(input.market).sort()).toEqual(["btc_trend_4h", "mood", "share_above_ema200_4h"]);
  });

  it("сортувальник новин акцій має свої категорії й відкидає крипто-категорії", () => {
    expect(triageSystem("stocks")).toContain("фондового ринку");
    const schema = triageSchema(["AAPLUSDT"], STOCK_CATEGORIES);
    expect(schema.properties.items.items.properties.category.enum).toContain("earnings");
    const sent = [{ id: 1, source: "x", title: "Apple beats" }, { id: 2, source: "x", title: "Hack" }];
    const rows = sanitizeTriage(
      { items: [{ id: 1, relevance: 8, impact: "high", sentiment: "bullish", symbols: ["AAPLUSDT", "BTCUSDT"], category: "earnings" }, { id: 2, relevance: 3, impact: "low", sentiment: "bearish", symbols: [], category: "hack_exploit" }] },
      sent,
      ["AAPLUSDT"],
      STOCK_CATEGORIES,
    );
    expect(rows.map((r) => [r.category, r.symbols])).toEqual([["earnings", ["AAPLUSDT"]], ["other", []]]);
    // Крипто без змін: earnings там не категорія.
    expect(sanitizeTriage({ items: [{ id: 1, relevance: 5, category: "earnings" }] }, sent, [], CATEGORIES)[0]!.category).toBe("other");
  });

  it("настрій ринку акцій бере тренд орієнтира, а не BTC", () => {
    const spy = snapshot("SPYUSDT");
    const aapl = snapshot("AAPLUSDT");
    expect(marketFromSnapshots([spy, aapl], "SPYUSDT").btcTrend).toBe(spy.regime.trend);
    expect(marketFromSnapshots([spy, aapl]).btcTrend).toBeNull();
  });

  it("ідея скану: ознака тренду орієнтира підписана його тикером, а сам орієнтир її не отримує", () => {
    const market: MarketRegime = { mood: "mixed", btcTrend: "up", breadth: 0.5, counted: 2 };
    const aapl = scoreSide(snapshot("AAPLUSDT"), "long", market, "SPYUSDT");
    expect(aapl.factors.some((f) => f.note.startsWith("SPY 4h"))).toBe(true);
    const spy = scoreSide(snapshot("SPYUSDT"), "long", market, "SPYUSDT");
    expect(spy.factors.some((f) => f.note.startsWith("SPY 4h"))).toBe(false);
    const spySnap = snapshot("SPYUSDT");
    const input = pickInput({
      options: [{ symbol: "SPYUSDT", side: "long", score: 60, factors: [], price: spySnap.price, market: { entry: 1, stop: 0.9, target: 1.2, stopPct: 10 }, pullback: null, roomAtr: null }],
      snapshots: new Map([["SPYUSDT", spySnap]]),
      btc: spySnap,
      market,
      news: [],
      horizonHours: 24,
      minutesToMacro: null,
    });
    // Знімок орієнтира вже є в полі btc: у варіанті його не дублюємо.
    expect(input.options[0]!.snapshot).toBeNull();
  });
});
