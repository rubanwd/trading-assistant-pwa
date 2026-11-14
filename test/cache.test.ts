import { describe, expect, it } from "vitest";
import { CachedMarket, KEEP, mergeCandles, newlyClosed, type CandleStorage } from "../src/worker/market/cache";
import type { Candle, MarketData, Timeframe } from "../src/worker/market/types";

const H = 3_600_000;
const bar = (i: number, close = 100 + i): Candle => ({ openTime: i * H, closeTime: (i + 1) * H - 1, open: close, high: close + 1, low: close - 1, close, volume: 1 });
const bars = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => bar(from + k));

describe("кеш свічок: логіка", () => {
  it("рахує, скільки свічок закрилось після останньої збереженої", () => {
    const lastClose = 10 * H - 1; // закрилась свічка 9
    expect(newlyClosed(lastClose, "1h", 10 * H - 1)).toBe(0);
    expect(newlyClosed(lastClose, "1h", 10 * H + 30 * 60_000)).toBe(0); // свічка 10 ще відкрита
    expect(newlyClosed(lastClose, "1h", 11 * H)).toBe(1); // свічка 10 закрилась
    expect(newlyClosed(lastClose, "1h", 13 * H + 5)).toBe(3);
  });

  it("зливає нові свічки зі збереженими, нові перекривають старі", () => {
    const merged = mergeCandles(bars(0, 5), [bar(4, 999), bar(5), bar(6)], "1h")!;
    expect(merged.map((c) => c.openTime / H)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(merged[4]!.close).toBe(999);
  });

  it("розрив між збереженими й новими: треба качати заново", () => {
    expect(mergeCandles(bars(0, 5), [bar(7), bar(8)], "1h")).toBeNull();
  });

  it("тримає не більше KEEP свічок", () => {
    expect(mergeCandles(bars(0, KEEP), [bar(KEEP), bar(KEEP + 1)], "1h")!).toHaveLength(KEEP);
  });
});

describe("кеш свічок: запити до біржі", () => {
  function setup(now: { t: number }) {
    const calls: { tf: Timeframe; limit: number }[] = [];
    const inner: MarketData = {
      name: "fake",
      async candles(_symbol, tf, limit) {
        calls.push({ tf, limit });
        // Біржа віддає останні limit закритих свічок на момент now.
        const lastClosed = Math.floor(now.t / H) - 1;
        return bars(lastClosed - limit + 1, lastClosed + 1);
      },
      funding: async () => new Map(),
      openInterest: async () => [],
    };
    const store = new Map<string, Candle[]>();
    const storage: CandleStorage = {
      load: (s, tf) => store.get(`${s}|${tf}`) ?? null,
      save: (s, tf, c) => void store.set(`${s}|${tf}`, c),
    };
    return { calls, storage, market: new CachedMarket(inner, storage, () => now.t) };
  }

  it("перший раз качає історію, далі лише нові свічки, без нових не питає біржу зовсім", async () => {
    const now = { t: 1000 * H + 60_000 };
    const { calls, market } = setup(now);
    const first = await market.candles("BTCUSDT", "1h", 498);
    expect(first).toHaveLength(498);
    expect(calls).toEqual([{ tf: "1h", limit: 498 }]);

    // Те саме в межах години: біржу не питаємо.
    now.t += 20 * 60_000;
    await market.candles("BTCUSDT", "1h", 498);
    expect(calls).toHaveLength(1);

    // Закрилась одна нова свічка: маленький запит із перекриттям.
    now.t += 60 * 60_000;
    const next = await market.candles("BTCUSDT", "1h", 498);
    expect(calls[1]).toEqual({ tf: "1h", limit: 3 });
    expect(next.at(-1)!.openTime).toBe(first.at(-1)!.openTime + H);
    expect(next).toHaveLength(498);
  });

  it("після перезапуску рушія бере свічки зі сховища, а не з біржі", async () => {
    const now = { t: 1000 * H + 60_000 };
    const a = setup(now);
    await a.market.candles("BTCUSDT", "1h", 498);
    const restarted = new CachedMarket(
      { name: "fake", candles: async () => { throw new Error("не мало бути запиту"); }, funding: async () => new Map(), openInterest: async () => [] },
      a.storage,
      () => now.t,
    );
    expect(await restarted.candles("BTCUSDT", "1h", 100)).toHaveLength(100);
  });

  it("після довгої перерви качає історію заново", async () => {
    const now = { t: 1000 * H + 60_000 };
    const { calls, market } = setup(now);
    await market.candles("BTCUSDT", "1h", 498);
    now.t += 600 * H;
    await market.candles("BTCUSDT", "1h", 498);
    expect(calls[1]).toEqual({ tf: "1h", limit: 498 });
  });
});
