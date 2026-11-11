import { TIMEFRAMES, type Candle, type Funding, type MarketData, type Timeframe } from "./market/types";
import { marketRegime, type MarketRegime } from "./regime";
import { buildSnapshot, type Snapshot } from "./snapshot";

/**
 * Скільки закритих свічок беремо на таймфрейм. EMA200 потребує запасу на розгін;
 * 498 (+1 відкрита) тримає запит у дешевшій ваговій категорії Binance (до 500).
 */
export const CANDLE_LIMIT = 498;
/** 24 години з кроком 15 хв плюс поточна точка. */
const OI_POINTS = 97;
/** Одночасно опитуємо не більше стількох монет (по 5 запитів на кожну). */
const CONCURRENCY = 3;

export interface ScanResult {
  snapshots: Snapshot[];
  market: MarketRegime;
  /** Монети без знімка та некритичні збої (фандинг, відкритий інтерес). */
  errors: { symbol: string | null; message: string }[];
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Збирає дані й рахує знімки ознак. Без моделі та без запису в базу. */
export async function scan(market: MarketData, symbols: string[], now: number): Promise<ScanResult> {
  const errors: ScanResult["errors"] = [];

  let funding = new Map<string, Funding>();
  try {
    funding = await market.funding();
  } catch (e) {
    errors.push({ symbol: null, message: `фандинг: ${String(e)}` });
  }

  const results = await pool(symbols, CONCURRENCY, async (symbol): Promise<Snapshot | null> => {
    // Збій відкритого інтересу некритичний; пишемо його, лише якщо знімок таки вийшов.
    let oiError: string | null = null;
    try {
      const [series, openInterest] = await Promise.all([
        Promise.all(TIMEFRAMES.map((tf) => market.candles(symbol, tf, CANDLE_LIMIT))),
        market.openInterest(symbol, OI_POINTS).catch((e) => {
          oiError = `відкритий інтерес: ${String(e)}`;
          return null;
        }),
      ]);
      const candles = Object.fromEntries(TIMEFRAMES.map((tf, i) => [tf, series[i]!])) as Record<Timeframe, Candle[]>;
      const snapshot = buildSnapshot({ symbol, now, candles, funding: funding.get(symbol) ?? null, openInterest });
      if (oiError) errors.push({ symbol, message: oiError });
      return snapshot;
    } catch (e) {
      errors.push({ symbol, message: String(e) });
      return null;
    }
  });

  const snapshots = results.filter((s): s is Snapshot => s !== null);
  const btc = snapshots.find((s) => s.symbol === "BTCUSDT");
  const market_ = marketRegime(
    btc?.regime.trend ?? null,
    snapshots.map((s) => (s.tf["4h"].ema200 === null ? null : s.tf["4h"].close > s.tf["4h"].ema200)),
  );
  return { snapshots, market: market_, errors };
}
