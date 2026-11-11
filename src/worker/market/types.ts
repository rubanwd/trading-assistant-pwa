/** Таймфрейми, з якими працює рушій. */
export const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export interface Candle {
  /** Час відкриття, мс UTC. */
  openTime: number;
  /** Час закриття, мс UTC. */
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Funding {
  symbol: string;
  /** Остання ставка фандингу, частка (0.0001 = 0.01%). */
  rate: number;
  markPrice: number;
  indexPrice: number;
  nextFundingTime: number;
}

export interface OpenInterestPoint {
  ts: number;
  /** Відкритий інтерес у контрактах (базова монета). */
  contracts: number;
  /** Відкритий інтерес у USDT. */
  valueUsd: number;
}

/**
 * Адаптер ринкових даних. Лише публічні дані, жодних торгових ключів.
 * Реалізації викликаються тільки з рушія (Durable Object у юрисдикції eu).
 * Якщо біржа недоступна з ЄС (451), запасна біржа реалізує цей самий інтерфейс.
 */
export interface MarketData {
  readonly name: string;
  /** Тільки закриті свічки, від старих до нових. */
  candles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  /** Фандинг і ціна маркування для всіх інструментів одним запитом. */
  funding(): Promise<Map<string, Funding>>;
  /** Історія відкритого інтересу з кроком 15 хв, від старих до нових. */
  openInterest(symbol: string, points: number): Promise<OpenInterestPoint[]>;
}

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}
