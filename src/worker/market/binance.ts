import {
  MarketDataError,
  type Candle,
  type Funding,
  type MarketData,
  type OpenInterestPoint,
  type Timeframe,
} from "./types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Рядок відповіді /fapi/v1/klines: числа приходять рядками. */
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

/** Прибирає свічку, що ще не закрилась. */
export function closedOnly(candles: Candle[], now: number): Candle[] {
  return candles.filter((c) => c.closeTime < now);
}

export function parseKlines(raw: RawKline[]): Candle[] {
  return raw.map((k) => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: k[6],
  }));
}

/** Публічні дані USDT-M ф'ючерсів Binance. Ключі не потрібні. */
export class BinanceFutures implements MarketData {
  readonly name = "binance-futures";

  constructor(
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
    private readonly base = "https://fapi.binance.com",
    private readonly now: () => number = Date.now,
  ) {}

  async candles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    // +1, бо остання свічка у відповіді ще відкрита.
    const raw = await this.get<RawKline[]>("/fapi/v1/klines", {
      symbol,
      interval: timeframe,
      limit: String(limit + 1),
    });
    return closedOnly(parseKlines(raw), this.now()).slice(-limit);
  }

  async funding(): Promise<Map<string, Funding>> {
    const raw = await this.get<
      { symbol: string; markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number }[]
    >("/fapi/v1/premiumIndex", {});
    return new Map(
      raw.map((r) => [
        r.symbol,
        {
          symbol: r.symbol,
          rate: Number(r.lastFundingRate),
          markPrice: Number(r.markPrice),
          indexPrice: Number(r.indexPrice),
          nextFundingTime: r.nextFundingTime,
        },
      ]),
    );
  }

  async openInterest(symbol: string, points: number): Promise<OpenInterestPoint[]> {
    const raw = await this.get<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }[]>(
      "/futures/data/openInterestHist",
      { symbol, period: "15m", limit: String(points) },
    );
    return raw
      .map((r) => ({ ts: r.timestamp, contracts: Number(r.sumOpenInterest), valueUsd: Number(r.sumOpenInterestValue) }))
      .sort((a, b) => a.ts - b.ts);
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const url = `${this.base}${path}${query ? `?${query}` : ""}`;
    let res: Response;
    try {
      res = await this.fetcher(url, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new MarketDataError(`${this.name} ${path}: ${String(e)}`, null);
    }
    if (!res.ok) {
      await res.body?.cancel();
      const note = res.status === 451 ? " (заборонена локація)" : "";
      throw new MarketDataError(`${this.name} ${path}: HTTP ${res.status}${note}`, res.status);
    }
    return (await res.json()) as T;
  }
}
