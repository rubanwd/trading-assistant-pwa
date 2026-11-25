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

/** Bybit: «Too many visits. Exceeded the API Rate Limit.» */
const RATE_LIMITED = 10006;
/** Паузи перед повторами, мс, якщо біржа не сказала, коли скинеться ліміт. */
const RETRY_DELAYS = [1_000, 2_500];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
    /**
     * Чи можна ще повторити запит після відмови за частотою. Рушій відповідає «ні», коли крок
     * наближається до ліміту 50 зовнішніх запитів: краще втратити одну монету, ніж увесь крок.
     */
    private readonly canRetry: () => boolean = () => true,
    private readonly sleep: (ms: number) => Promise<void> = wait,
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

  /**
   * Символи лінійних контрактів одного типу, що зараз торгуються: stock (акції США), ETF тощо.
   * Режим акцій бере stock і ETF, щоб відсіяти зі списку символи без контракту.
   */
  async instruments(symbolType: "stock" | "ETF"): Promise<string[]> {
    const res = await this.get<{ list: { symbol: string; status: string }[] }>("/v5/market/instruments-info", {
      category: "linear",
      symbolType,
      limit: "1000",
    });
    return res.list.filter((i) => i.status === "Trading").map((i) => i.symbol);
  }

  /**
   * Безстрокові USDT-контракти на криптовалюти, що зараз торгуються, з назвою базової монети (SHIB1000 для SHIB1000USDT).
   * Біржа віддає до 1000 контрактів на сторінку; беремо не більше трьох сторінок.
   */
  async linearUsdt(): Promise<{ symbol: string; baseCoin: string }[]> {
    const out: { symbol: string; baseCoin: string }[] = [];
    let cursor = "";
    for (let page = 0; page < 3; page++) {
      const res = await this.get<{
        list: { symbol: string; status: string; contractType?: string; quoteCoin?: string; baseCoin?: string; symbolType?: string }[];
        nextPageCursor?: string;
      }>("/v5/market/instruments-info", { category: "linear", limit: "1000", ...(cursor ? { cursor } : {}) });
      for (const i of res.list) {
        if (i.status !== "Trading" || i.contractType !== "LinearPerpetual" || i.quoteCoin !== "USDT" || !i.baseCoin) continue;
        if (i.symbolType === "stock" || i.symbolType === "ETF") continue;
        out.push({ symbol: i.symbol, baseCoin: i.baseCoin });
      }
      cursor = res.nextPageCursor ?? "";
      if (!cursor) break;
    }
    return out;
  }

  /**
   * Запит із повторами після відмови за частотою (код 10006 або HTTP 429). Публічні ліміти Bybit рахуються на IP,
   * а вихідні адреси Cloudflare спільні з іншими клієнтами, тож ліміт буває вичерпаний не нами й скидається за секунди.
   */
  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(path, params);
      } catch (e) {
        const limited = e instanceof MarketDataError && (e.rateLimited || e.status === 429);
        if (!limited || attempt >= RETRY_DELAYS.length || !this.canRetry()) throw e;
        const resetAt = (e as MarketDataError).resetAt;
        const delay = resetAt ? Math.min(Math.max(resetAt - this.now(), 200), 3_000) : RETRY_DELAYS[attempt]!;
        await this.sleep(delay);
      }
    }
  }

  private async once<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${this.base}${path}?${new URLSearchParams(params)}`;
    let res: Response;
    try {
      res = await this.fetcher(url, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new MarketDataError(`${this.name} ${path}: ${String(e)}`, null);
    }
    if (!res.ok) {
      await res.body?.cancel();
      const note = res.status === 403 || res.status === 451 ? " (заборонена локація)" : res.status === 429 ? " (забагато запитів)" : "";
      throw new MarketDataError(`${this.name} ${path}: HTTP ${res.status}${note}`, res.status);
    }
    const body = (await res.json()) as Envelope<T>;
    if (body.retCode !== 0) {
      const err = new MarketDataError(`${this.name} ${path}: ${body.retCode} ${body.retMsg}`, res.status);
      if (body.retCode === RATE_LIMITED) {
        err.rateLimited = true;
        // Bybit може сказати, коли скинеться ліміт (мс від епохи).
        const reset = Number(res.headers.get("x-bapi-limit-reset-timestamp"));
        if (Number.isFinite(reset) && reset > 0) err.resetAt = reset;
      }
      throw err;
    }
    return body.result;
  }
}
