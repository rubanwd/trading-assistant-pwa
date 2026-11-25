import { describe, expect, it } from "vitest";
import { BOTS, TUBE_DEFAULTS, TUBE_KEYS, tubeConfig, type TubeConfig } from "../src/shared/bots";
import { validateSettings } from "../src/shared/settings";
import {
  MIN_GAP_ATR,
  movementScore,
  planCycle,
  rankTube,
  resolveTube,
  tubeFeatures,
  tubeFeeR,
  tubeMarket,
  tubeOrders,
  type TubeFeatures,
  type TubeTrade,
} from "../src/worker/bots/tube";
import { netR, outcomeOf, tubeGroup, tubeSummarize, type TubeRecord } from "../src/worker/bots/tubeStats";
import { isTradableCoin, topUniverse, type CapRow } from "../src/worker/bots/universe";
import { BybitLinear } from "../src/worker/market/bybit";
import type { Candle } from "../src/worker/market/types";
import { timeframeFeatures } from "../src/worker/snapshot";
import { ohlc, path, uptrend } from "./fixtures";

const H = 3_600_000;
const M15 = 15 * 60_000;
const NOW = 1_800_000_000_000;

function feature(symbol: string, over: Partial<TubeFeatures> = {}): TubeFeatures {
  return {
    symbol,
    price: 100,
    closedAt: NOW,
    atr: 2,
    atrPct: 2,
    ema20: 100,
    rsi: 50,
    volRatio: 1,
    change24hPct: 0,
    trend4h: "range",
    above200: null,
    score: 2,
    ...over,
  };
}

const cfg = (over: Partial<TubeConfig> = {}): TubeConfig => ({ ...TUBE_DEFAULTS, entryAtr: 2, stopAtr: 2, targetR: 1, minStopPct: 0, ...over });

describe("ознаки й рейтинг руху", () => {
  it("ATR, EMA20, активність обсягу й тренд 4h зі свічок", () => {
    const rows = path(uptrend(300));
    const h1 = ohlc(rows, NOW);
    const f = tubeFeatures("ETHUSDT", h1, timeframeFeatures(ohlc(rows, NOW, 4 * H)))!;
    expect(f.price).toBe(h1[h1.length - 1]!.close);
    expect(f.atr).toBeGreaterThan(0);
    expect(f.atrPct).toBeCloseTo((f.atr / f.price) * 100, 3);
    // Ціна стоїть, а останні 6 годин обсяг утричі більший за звичайний.
    const flat = ohlc(path(Array.from({ length: 200 }, (_, i) => 100 + (i % 2))), NOW).map((c, i) => ({ ...c, volume: i >= 194 ? 300 : 100 }));
    expect(tubeFeatures("X", flat, null)!.volRatio).toBeCloseTo(3, 1);
    expect(f.trend4h).toBe("up");
    expect(f.above200).toBe(true);
    expect(f.score).toBe(movementScore(f.atrPct, f.volRatio));
  });

  it("замало свічок — немає ознак; без тижневої історії активність невідома", () => {
    expect(tubeFeatures("X", ohlc(path(uptrend(20)), NOW), null)).toBeNull();
    const f = tubeFeatures("X", ohlc(path(uptrend(60)), NOW), null)!;
    expect(f.volRatio).toBeNull();
    expect(f.trend4h).toBeNull();
  });

  it("бал руху: волатильність, підсилена активністю, з межами ×0.5…×2", () => {
    expect(movementScore(2, 1)).toBe(2);
    expect(movementScore(2, 4)).toBe(4);
    expect(movementScore(2, 100)).toBe(4);
    expect(movementScore(2, 0)).toBe(1);
    expect(movementScore(2, null)).toBe(2);
  });

  it("рейтинг від найрухливішої монети", () => {
    const list = [feature("A", { score: 1 }), feature("B", { score: 3 }), feature("C", { score: 2 })];
    expect(rankTube(list).map((f) => f.symbol)).toEqual(["B", "C", "A"]);
    expect(rankTube([feature("A", { atrPct: 5, volRatio: 0.5 }), feature("B", { atrPct: 1, volRatio: 3 })], "volume")[0]!.symbol).toBe("B");
  });

  it("напрямок ринку: BTC 4h і частка монет вище EMA200", () => {
    const up = [feature("BTCUSDT", { trend4h: "up", above200: true }), feature("ETHUSDT", { above200: true }), feature("SOLUSDT", { above200: true })];
    expect(tubeMarket(up).bias).toBe("bull");
    const down = up.map((f) => ({ ...f, trend4h: f.symbol === "BTCUSDT" ? ("down" as const) : f.trend4h, above200: false }));
    expect(tubeMarket(down).bias).toBe("bear");
    expect(tubeMarket(up.map((f) => ({ ...f, trend4h: "range" as const }))).bias).toBe("neutral");
  });
});

describe("лімітки", () => {
  const f = feature("ETHUSDT");

  it("бичачий ринок: шорт удвічі ближче до ціни, ніж лонг (правило counter)", () => {
    const [long, short] = tubeOrders(f, "bull", cfg());
    expect(long).toMatchObject({ side: "long", entry: 96, stop: 92, target: 100, offsetAtr: 2, near: false });
    expect(short).toMatchObject({ side: "short", entry: 102, stop: 106, target: 98, offsetAtr: 1, near: true });
  });

  it("ведмежий ринок — навпаки; нейтральний і off — однаково", () => {
    const [long, short] = tubeOrders(f, "bear", cfg());
    expect(long!.offsetAtr).toBe(1);
    expect(short!.offsetAtr).toBe(2);
    for (const [bias, c] of [["neutral", cfg()], ["bull", cfg({ biasSide: "off" })]] as const) {
      const o = tubeOrders(f, bias, c);
      expect(o.map((x) => x.offsetAtr)).toEqual([2, 2]);
      expect(o.every((x) => x.near === null)).toBe(true);
    }
  });

  it("правило trend: у бичачому ринку ближче лонг", () => {
    const [long, short] = tubeOrders(f, "bull", cfg({ biasSide: "trend" }));
    expect(long!.near).toBe(true);
    expect(short!.near).toBe(false);
  });

  it("тейк у R від ризику, стоп не ближче min_stop_pct, лімітка не ближче мінімального відступу", () => {
    const [long] = tubeOrders(f, "neutral", cfg({ targetR: 0.5, minStopPct: 10 }));
    // Ризик 10% від входу 96 замість 2 ATR.
    expect(long!.stop).toBeCloseTo(86.4, 6);
    expect(long!.target).toBeCloseTo(100.8, 6);
    const near = tubeOrders(f, "neutral", cfg({ entryAtr: 0.1 }));
    expect(near.map((o) => o.offsetAtr)).toEqual([MIN_GAP_ATR, MIN_GAP_ATR]);
    // Від EMA20: ціна вище середини — лонг далі від ціни.
    const [fromEma] = tubeOrders(feature("X", { price: 104, ema20: 100 }), "neutral", cfg(), 1, "ema");
    expect(fromEma!.entry).toBe(96);
  });

  it("непридатний ордер не ставиться: стоп лонга нижче нуля", () => {
    const orders = tubeOrders(feature("X", { price: 1, atr: 0.4 }), "neutral", cfg({ entryAtr: 1, stopAtr: 2 }));
    expect(orders.map((o) => o.side)).toEqual(["short"]);
  });
});

describe("план години", () => {
  const list = [feature("A", { score: 3 }), feature("B", { score: 2 }), feature("C", { score: 1.5 }), feature("D", { score: 1 })];

  it("три найрухливіші монети, по дві лімітки", () => {
    const plan = planCycle(list, [], cfg({ pickN: 3, maxPositions: 10 }));
    expect(plan.chosen).toEqual(["A", "B", "C"]);
    expect(plan.orders.map((o) => `${o.symbol}:${o.side}:${o.rank}`)).toEqual(["A:long:1", "A:short:1", "B:long:2", "B:short:2", "C:long:3", "C:short:3"]);
  });

  it("по монеті й напрямку з відкритою позицією нового ордера немає; ліміт позицій рахує нові ордери", () => {
    const plan = planCycle(list, [{ symbol: "A", side: "long" }], cfg({ pickN: 3, maxPositions: 4 }));
    expect(plan.orders.map((o) => `${o.symbol}:${o.side}`)).toEqual(["A:short", "B:long", "B:short"]);
    expect(plan.skipped).toEqual([
      { symbol: "A", side: "long", reason: "position" },
      { symbol: "C", side: "long", reason: "slots" },
      { symbol: "C", side: "short", reason: "slots" },
    ]);
  });
});

/** Свічки 15m від t0: [high, low, close]. */
function m15(t0: number, rows: [number, number, number][]): Candle[] {
  return rows.map(([high, low, close], i) => ({ openTime: t0 + i * M15, closeTime: t0 + (i + 1) * M15 - 1, open: close, high, low, close, volume: 1 }));
}

describe("паперове виконання", () => {
  // Ордер поставлено о :04; живе годину; свічки 15m з :00.
  const hour = NOW - (NOW % H);
  const placedAt = hour + 4 * 60_000;
  const long: TubeTrade = { side: "long", entry: 96, stop: 92, target: 100, placedAt, expiresAt: placedAt + H, maxHoldMs: 2 * H };

  it("свічка, що почалась до постановки, не виконує; торкання ціни не рахується", () => {
    const res = resolveTube(long, m15(hour, [[101, 90, 100], [101, 96, 100], [101, 97, 100], [101, 97, 100]]), placedAt + H);
    expect(res.status).toBe("cancelled");
    expect(res.resolvedAt).toBe(placedAt + H);
    expect(resolveTube(long, m15(hour, [[101, 99, 100]]), placedAt + 10 * 60_000).status).toBe("pending");
  });

  it("свічка, що закривається після зняття, теж не виконує", () => {
    const res = resolveTube(long, m15(hour, [[101, 99, 100], [101, 99, 100], [101, 99, 100], [101, 99, 100], [101, 90, 95]]), placedAt + 2 * H);
    expect(res.status).toBe("cancelled");
  });

  it("вхід, потім тейк; у свічці входу тейк не зараховується", () => {
    const res = resolveTube(long, m15(hour, [[101, 99, 100], [101, 95.5, 99], [100.5, 98, 100]]), placedAt + H);
    expect(res).toEqual({ status: "target", filledAt: hour + M15, resolvedAt: hour + 3 * M15 - 1, exitPrice: 100, resultR: 1 });
  });

  it("стоп у свічці входу; стоп має перевагу над тейком", () => {
    expect(resolveTube(long, m15(hour, [[101, 99, 100], [97, 91, 93]]), placedAt + H).status).toBe("stop");
    const res = resolveTube(long, m15(hour, [[101, 99, 100], [97, 95, 96], [101, 91, 95]]), placedAt + H);
    expect(res).toMatchObject({ status: "stop", resultR: -1, exitPrice: 92 });
  });

  it("позиція живе до maxHold і закривається за останнім закриттям", () => {
    const rows: [number, number, number][] = [[101, 99, 100], [97, 95, 96], ...Array.from({ length: 10 }, (): [number, number, number] => [98, 95, 97])];
    const candles = m15(hour, rows);
    expect(resolveTube(long, candles, hour + 2 * H).status).toBe("open");
    const res = resolveTube(long, candles, hour + 4 * H);
    // Вхід о :15, термін через 2 год: остання свічка перед ним закрилась о 2:14:59.
    expect(res).toMatchObject({ status: "timeout", exitPrice: 97, resolvedAt: hour + M15 + 2 * H - 1, resultR: 0.25 });
  });

  it("шорт дзеркально", () => {
    const short: TubeTrade = { side: "short", entry: 104, stop: 108, target: 100, placedAt, expiresAt: placedAt + H, maxHoldMs: 2 * H };
    const res = resolveTube(short, m15(hour, [[101, 99, 100], [104.5, 101, 103], [104, 99.5, 100]]), placedAt + H);
    expect(res).toMatchObject({ status: "target", resultR: 1 });
  });

  it("комісії: вхід і тейк maker, стоп і за часом taker", () => {
    const fees = { makerPct: 0.02, takerPct: 0.05 };
    expect(tubeFeeR(long, "target", 100, fees)).toBeCloseTo((96 * 0.0002 + 100 * 0.0002) / 4, 3);
    expect(tubeFeeR(long, "stop", 92, fees)).toBeCloseTo((96 * 0.0002 + 92 * 0.0005) / 4, 3);
    expect(tubeFeeR(long, "cancelled", null, fees)).toBeNull();
  });
});

const record = (over: Partial<TubeRecord>): TubeRecord => ({
  id: 1,
  created_at: "2026-11-01T00:04:00Z",
  symbol: "ETHUSDT",
  side: "long",
  bias: "neutral",
  near: null,
  rank: 1,
  price: 100,
  entry: 96,
  stop: 92,
  target: 100,
  status: "pending",
  filled_at: null,
  resolved_at: null,
  exit_price: null,
  result_r: null,
  fee_r: null,
  ...over,
});

describe("облік бота", () => {
  it("R після комісій і результат угоди", () => {
    expect(netR(record({ status: "target", result_r: 1, fee_r: 0.01 }))).toBe(0.99);
    expect(netR(record({ status: "open", result_r: null }))).toBeNull();
    expect(outcomeOf(record({ status: "timeout", result_r: 0.005, fee_r: 0.01 }))).toBe("loss");
    expect(outcomeOf(record({ status: "timeout", result_r: 0.3, fee_r: 0.01 }))).toBe("win");
    expect(outcomeOf(record({ status: "cancelled" }))).toBe("cancelled");
  });

  it("групи: виконані, зняті, частка виконаних, розріз за ближчою й дальньою ліміткою", () => {
    const rows = [
      record({ status: "target", filled_at: "x", result_r: 0.5, fee_r: 0.01, near: 1, bias: "bull", side: "short" }),
      record({ status: "stop", filled_at: "x", result_r: -1, fee_r: 0.02, near: 0, bias: "bull" }),
      record({ status: "open", filled_at: "x" }),
      record({ status: "cancelled" }),
      record({ status: "cancelled" }),
      record({ status: "pending" }),
    ];
    const g = tubeGroup(rows);
    expect(g).toMatchObject({ orders: 6, filled: 3, cancelled: 2, pending: 1, open: 1, closed: 2, wins: 1, losses: 1, target: 1, stop: 1, totalR: -0.53 });
    expect(g.fillRate).toBeCloseTo(0.6, 6);
    const s = tubeSummarize(rows);
    expect(s.byDistance.near.wins).toBe(1);
    expect(s.byDistance.far.losses).toBe(1);
    expect(s.bySide.short.totalR).toBe(0.49);
    expect(s.bySymbol.map((x) => x.symbol)).toEqual(["ETHUSDT"]);
  });
});

describe("список монет бота", () => {
  const row = (symbol: string, rank: number, name = symbol, price = 10): CapRow => ({ symbol, name, current_price: price, market_cap_rank: rank });

  it("без стейблкоїнів, золота й обгорток", () => {
    expect(isTradableCoin(row("usdt", 3, "Tether", 1))).toBe(false);
    expect(isTradableCoin(row("usdx2", 30, "Some USD Coin", 1.001))).toBe(false);
    expect(isTradableCoin(row("xaut", 29, "Tether Gold", 4000))).toBe(false);
    expect(isTradableCoin(row("wbtc", 12, "Wrapped Bitcoin", 90000))).toBe(false);
    expect(isTradableCoin(row("steth", 8, "Lido Staked Ether", 3000))).toBe(false);
    expect(isTradableCoin(row("doge", 9, "Dogecoin", 0.2))).toBe(true);
  });

  it("топ за капіталізацією з контрактом на Bybit, з множниками в назвах", () => {
    const caps = [row("btc", 1), row("usdt", 2, "Tether", 1), row("shib", 4), row("leo", 3), row("eth", 2), row("pepe", 5)];
    const instruments = [
      { symbol: "BTCUSDT", baseCoin: "BTC" },
      { symbol: "ETHUSDT", baseCoin: "ETH" },
      { symbol: "SHIB1000USDT", baseCoin: "SHIB1000" },
      { symbol: "1000PEPEUSDT", baseCoin: "1000PEPE" },
    ];
    expect(topUniverse(caps, instruments, 10)).toEqual(["BTCUSDT", "ETHUSDT", "SHIB1000USDT", "1000PEPEUSDT"]);
    expect(topUniverse(caps, instruments, 2)).toEqual(["BTCUSDT", "ETHUSDT"]);
  });

  it("контракти Bybit: лише безстрокові USDT, що торгуються, з усіх сторінок", async () => {
    const urls: string[] = [];
    const api = new BybitLinear(async (url) => {
      urls.push(url);
      const page = new URL(url).searchParams.get("cursor");
      const list = page
        ? [{ symbol: "SOLUSDT", status: "Trading", contractType: "LinearPerpetual", quoteCoin: "USDT", baseCoin: "SOL" }]
        : [
            { symbol: "BTCUSDT", status: "Trading", contractType: "LinearPerpetual", quoteCoin: "USDT", baseCoin: "BTC" },
            { symbol: "BTC-26DEC26", status: "Trading", contractType: "LinearFutures", quoteCoin: "USDT", baseCoin: "BTC" },
            { symbol: "ETHPERP", status: "Trading", contractType: "LinearPerpetual", quoteCoin: "USDC", baseCoin: "ETH" },
            { symbol: "OLDUSDT", status: "Closed", contractType: "LinearPerpetual", quoteCoin: "USDT", baseCoin: "OLD" },
            { symbol: "AAPLUSDT", status: "Trading", contractType: "LinearPerpetual", quoteCoin: "USDT", baseCoin: "AAPL", symbolType: "stock" },
          ];
      return Response.json({ retCode: 0, retMsg: "OK", result: { list, nextPageCursor: page ? "" : "next" } });
    });
    expect(await api.linearUsdt()).toEqual([
      { symbol: "BTCUSDT", baseCoin: "BTC" },
      { symbol: "SOLUSDT", baseCoin: "SOL" },
    ]);
    expect(urls).toHaveLength(2);
  });
});

describe("налаштування бота", () => {
  it("значення з бази, непридатні замінюються стартовими", () => {
    const c = tubeConfig({ [TUBE_KEYS.entryAtr]: 1.5, [TUBE_KEYS.pickN]: 2.5, [TUBE_KEYS.biasSide]: "trend", [TUBE_KEYS.stopAtr]: "3" });
    expect(c.entryAtr).toBe(1.5);
    expect(c.pickN).toBe(TUBE_DEFAULTS.pickN);
    expect(c.biasSide).toBe("trend");
    expect(c.stopAtr).toBe(TUBE_DEFAULTS.stopAtr);
  });

  it("схема перевіряє кожне поле бота", () => {
    const { values, errors } = validateSettings({ tube_enabled: "off", tube_entry_atr: 1.5, tube_bias_side: "trend", tube_pick_n: 9, tube_bias_ratio: "2" });
    expect(values).toEqual({ tube_enabled: "off", tube_entry_atr: 1.5, tube_bias_side: "trend" });
    expect(Object.keys(errors).sort()).toEqual(["tube_bias_ratio", "tube_pick_n"]);
  });

  it("бот має назву", () => {
    expect(BOTS.map((b) => b.name)).toEqual(["High Value Tube"]);
  });
});
