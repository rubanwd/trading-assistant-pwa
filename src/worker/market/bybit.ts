import { closedOnly } from "./binance";
import {
  MarketDataError,
  TIMEFRAME_MS,
  type Candle,
  type Funding,
  type MarketData,
  type OpenInterestPoint,
  type Timeframe,
} from "./types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const INTERVAL: Record<Timeframe, string> = { "15m": "15", "1h": "60", "4h": "240", "1d": "D" };

interface Envelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

/**
 * Запасна біржа: публічні дані лінійних безстрокових контрактів Bybit (v5). Ключі не потрібні.
 * Символи збігаються з Binance (BTCUSDT тощо).
 */
export class BybitLinear implements MarketData {
  readonly name = "bybit-linear";
  /** Ціна маркування з останнього запиту фандингу: потрібна, щоб перевести відкритий інтерес у USDT. */
  private markPrices = new Map<string, number>();

  constructor(
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
    private readonly base = "https://api.bybit.com",
    private readonly now: () => number = Date.now,
  ) {}

  async candles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const res = await this.get<{ list: string[][] }>("/v5/market/kline", {
      category: "linear",
      symbol,
      interval: INTERVAL[timeframe],
      limit: String(Math.min(limit + 1, 1000)),
    });
    const step = TIMEFRAME_MS[timeframe];
    // Bybit віддає від нових до старих і без часу закриття.
    const candles = res.list
      .map((k) => ({
        openTime: Number(k[0]),
        closeTime: Number(k[0]) + step - 1,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      }))
      .sort((a, b) => a.openTime - b.openTime);
    return closedOnly(candles, this.now()).slice(-limit);
  }

  async funding(): Promise<Map<string, Funding>> {
    const res = await this.get<{
      list: { symbol: string; markPrice: string; indexPrice: string; fundingRate: string; nextFundingTime: string }[];
    }>("/v5/market/tickers", { category: "linear" });
    const out = new Map<string, Funding>();
    for (const t of res.list) {
      const markPrice = Number(t.markPrice);
      this.markPrices.set(t.symbol, markPrice);
      if (t.fundingRate === "" || t.fundingRate === undefined) continue;
      out.set(t.symbol, {
        symbol: t.symbol,
        rate: Number(t.fundingRate),
        markPrice,
        indexPrice: Number(t.indexPrice),
        nextFundingTime: Number(t.nextFundingTime),
      });
    }
    return out;
  }

  async openInterest(symbol: string, points: number): Promise<OpenInterestPoint[]> {
    const res = await this.get<{ list: { openInterest: string; timestamp: string }[] }>("/v5/market/open-interest", {
      category: "linear",
      symbol,
      intervalTime: "15min",
      limit: String(Math.min(points, 200)),
    });
    const mark = this.markPrices.get(symbol) ?? null;
    return res.list
      .map((r) => {
        const contracts = Number(r.openInterest);
        return { ts: Number(r.timestamp), contracts, valueUsd: mark === null ? null : contracts * mark };
      })
      .sort((a, b) => a.ts - b.ts);
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${this.base}${path}?${new URLSearchParams(params)}`;
    let res: Response;
    try {
      res = await this.fetcher(url, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new MarketDataError(`${this.name} ${path}: ${String(e)}`, null);
    }
    if (!res.ok) {
      await res.body?.cancel();
      const note = res.status === 403 || res.status === 451 ? " (заборонена локація)" : "";
      throw new MarketDataError(`${this.name} ${path}: HTTP ${res.status}${note}`, res.status);
    }
    const body = (await res.json()) as Envelope<T>;
    if (body.retCode !== 0) throw new MarketDataError(`${this.name} ${path}: ${body.retCode} ${body.retMsg}`, res.status);
    return body.result;
  }
}
