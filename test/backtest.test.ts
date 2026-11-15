import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { mergeCandles, months, parseKlines, shiftMonth, unzipFirst } from "../src/backtest/data";
import { bootstrapMeanCi, buildReport, maxDrawdown, summarize } from "../src/backtest/report";
import { backtest, DEFAULT_CONFIG, type SymbolCandles, type Trade } from "../src/backtest/simulate";
import type { Candle } from "../src/worker/market/types";

const M15 = 900_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-01-01T00:00:00Z");

/** Детермінований ряд 15m: випадкове блукання з трендовими відрізками, щоб детектори мали що знайти. */
function walk(seed: number, days: number, start = 100): Candle[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: Candle[] = [];
  let price = start;
  let drift = 0;
  for (let i = 0; i < (days * DAY) / M15; i++) {
    if (i % 400 === 0) drift = (rand() - 0.5) * 0.0016;
    const open = price;
    const close = open * (1 + drift + (rand() - 0.5) * 0.008);
    const high = Math.max(open, close) * (1 + rand() * 0.003);
    const low = Math.min(open, close) * (1 - rand() * 0.003);
    out.push({ openTime: T0 + i * M15, closeTime: T0 + (i + 1) * M15 - 1, open, high, low, close, volume: 1 + rand() });
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
  return out.filter((c) => c.closeTime <= m15[m15.length - 1]!.closeTime);
}

const symbol = (name: string, m15: Candle[]): SymbolCandles => ({
  symbol: name,
  "15m": m15,
  "1h": aggregate(m15, HOUR),
  "4h": aggregate(m15, 4 * HOUR),
  "1d": aggregate(m15, DAY),
});

const DAYS = 90;
const market = [symbol("BTCUSDT", walk(1, DAYS, 60_000)), symbol("ETHUSDT", walk(7, DAYS, 3_000)), symbol("SOLUSDT", walk(13, DAYS, 150))];
const cfg = { ...DEFAULT_CONFIG, from: T0 + 40 * DAY, to: T0 + DAYS * DAY - HOUR };
const result = backtest(market, cfg);

describe("бектест", () => {
  it("знаходить і публікує сигнали на синтетичному ринку", () => {
    expect(result.funnel.scans).toBe((DAYS - 40) * 24);
    expect(result.funnel.detected).toBeGreaterThan(0);
    expect(result.trades.length).toBeGreaterThan(5);
  });

  it("не заглядає в майбутнє: рішення до моменту X не залежать від свічок після X", () => {
    const cut = T0 + 65 * DAY;
    const truncated = market.map((s) =>
      symbol(s.symbol, s["15m"].filter((c) => c.closeTime < cut)),
    );
    const early = backtest(truncated, { ...cfg, to: cut - HOUR });
    const key = (t: Trade) => `${t.createdAt}|${t.symbol}|${t.side}|${t.setup}|${t.entryLow}|${t.stop}|${t.tp1}`;
    expect(early.trades.map(key)).toEqual(result.trades.filter((t) => t.createdAt < cut).map(key));
  });

  it("тримає ліміт відкритих сигналів і не більше одного на монету", () => {
    for (const t of result.trades) {
      const open = result.trades.filter((x) => x.createdAt <= t.createdAt && (x.resolvedAt === null || x.resolvedAt > t.createdAt));
      expect(open.length).toBeLessThanOrEqual(cfg.maxActive);
      expect(new Set(open.map((x) => x.symbol)).size).toBe(open.length);
    }
  });

  it("кожна опублікована угода проходить поріг R:R, а результат уже після комісій", () => {
    for (const t of result.trades) {
      expect(t.rr).toBeGreaterThanOrEqual(cfg.minRr);
      if (t.netR !== null) expect(t.netR).toBeCloseTo(t.resultR! - t.feeR, 3);
    }
  });

  it("звіт збирає підсумки без збоїв", () => {
    const report = buildReport(result);
    expect(report.overall.signals).toBe(result.trades.length);
    expect(report.overall.trades + report.overall.noEntry + report.overall.stillOpen).toBe(result.trades.length);
    expect(Object.values(report.bySetup).reduce((s, g) => s + g.trades, 0)).toBe(report.overall.trades);
  });
});

describe("підсумки бектесту", () => {
  const trade = (netR: number, resolvedAt: number): Trade =>
    ({ netR, resultR: netR, feeR: 0, resolvedAt, events: [], status: netR > 0 ? "tp1" : "stopped" }) as unknown as Trade;

  it("просадка рахується від попереднього максимуму", () => {
    expect(maxDrawdown([2, -1, -1, 3, -1])).toBe(2);
    expect(maxDrawdown([-1, -1])).toBe(2);
    expect(maxDrawdown([])).toBe(0);
  });

  it("довірчий інтервал детермінований і охоплює середнє", () => {
    const values = [2, -1, -1, 2, -1, 2, -1, -1];
    const ci = bootstrapMeanCi(values)!;
    expect(bootstrapMeanCi(values)).toEqual(ci);
    expect(ci[0]).toBeLessThan(0.125);
    expect(ci[1]).toBeGreaterThan(0.125);
    expect(bootstrapMeanCi([1])).toBeNull();
  });

  it("виграш, середнє, profit factor", () => {
    const s = summarize([trade(2, 3), trade(-1, 1), trade(-1, 2)]);
    expect(s).toMatchObject({ trades: 3, wins: 1, winRate: 0.333, avgR: 0, totalR: 0, profitFactor: 1, maxDrawdownR: 2 });
  });
});

describe("архів Binance", () => {
  /** Мінімальний zip з одним файлом, стиснутим deflate, і розмірами лише в центральному каталозі. */
  function zip(name: string, text: string): Uint8Array {
    const data = deflateRawSync(Buffer.from(text));
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 42);
    const dirOffset = local.length + nameBuf.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + nameBuf.length, 12);
    eocd.writeUInt32LE(dirOffset, 16);
    return new Uint8Array(Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]));
  }

  const CSV =
    "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n" +
    "1767225600000,100,101,99,100.5,10,1767229199999,1000,5,4,400,0\n" +
    "1767229200000,100.5,102,100,101,12,1767232799999,1200,6,5,500,0\n";

  it("розпаковує zip і розбирає CSV із заголовком", () => {
    const csv = new TextDecoder().decode(unzipFirst(zip("BTCUSDT-1h-2026-01.csv", CSV)));
    expect(csv).toBe(CSV);
    expect(parseKlines(csv)).toEqual([
      { openTime: 1767225600000, closeTime: 1767229199999, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
      { openTime: 1767229200000, closeTime: 1767232799999, open: 100.5, high: 102, low: 100, close: 101, volume: 12 },
    ]);
  });

  it("склеює місяці без дублікатів і за порядком часу", () => {
    const [a, b] = parseKlines(CSV);
    expect(mergeCandles([[b!], [a!, b!]])).toEqual([a, b]);
  });

  it("місяці й зсуви через межу року", () => {
    expect(months("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
    expect(shiftMonth("2026-10", -17)).toBe("2025-05");
  });
});
