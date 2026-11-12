import { MarketDataError, type MarketData, type Timeframe } from "./types";

/** Статуси, якими біржа відмовляє за локацією: 451 у Binance, 403 у CloudFront перед Bybit. */
const GEO_BLOCK = new Set([403, 451]);

export const isGeoBlock = (e: unknown) => e instanceof MarketDataError && e.status !== null && GEO_BLOCK.has(e.status);

/**
 * Основна біржа із запасною. Якщо основна відмовляє за локацією, адаптер назавжди (до перезапуску рушія)
 * переходить на запасну й повторює запит там. Інші помилки не перемикають джерело.
 */
export class FailoverMarket implements MarketData {
  private switched = false;
  /** Чому перемкнулись: текст помилки основної біржі. */
  reason: string | null = null;

  constructor(
    private readonly primary: MarketData,
    private readonly secondary: MarketData,
  ) {}

  get name(): string {
    return this.switched ? this.secondary.name : this.primary.name;
  }

  private async run<T>(fn: (m: MarketData) => Promise<T>): Promise<T> {
    if (this.switched) return fn(this.secondary);
    try {
      return await fn(this.primary);
    } catch (e) {
      if (!isGeoBlock(e)) throw e;
      this.switched = true;
      this.reason = String(e);
      return fn(this.secondary);
    }
  }

  candles(symbol: string, timeframe: Timeframe, limit: number) {
    return this.run((m) => m.candles(symbol, timeframe, limit));
  }

  funding() {
    return this.run((m) => m.funding());
  }

  openInterest(symbol: string, points: number) {
    return this.run((m) => m.openInterest(symbol, points));
  }
}
