/**
 * Мінімальний клієнт Bybit API V5: публічні ринкові дані й підписані приватні запити.
 * Ключі приходять лише з оточення, ніколи не пишуться в журнал, БД чи тексти помилок.
 */
import { createHmac } from "node:crypto";
import { dec } from "./decimal";
import type { Candle, FundingRate, InstrumentSpec, Ticker } from "./types";

export const MAINNET = "https://api.bybit.com";
export const TESTNET = "https://api-testnet.bybit.com";

/** Біржа відповіла кодом помилки: запит точно оброблено, результат відомий. */
export class BybitApiError extends Error {
  constructor(
    readonly code: number,
    readonly retMsg: string,
    readonly path: string,
  ) {
    super(`Bybit ${path}: ${code} ${retMsg}`);
  }
}

/** Таймаут, обрив зв'язку або 5xx: невідомо, чи біржа виконала запит. */
export class UncertainError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`Bybit ${path}: ${message}`);
  }
}

export interface Credentials {
  key: string;
  secret: string;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  base: string;
  credentials?: Credentials;
  fetcher?: Fetcher;
  timeoutMs?: number;
  recvWindow?: number;
  now?: () => number;
}

interface Envelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

/** Bybit: перевищено частоту запитів. */
const RATE_LIMITED = 10006;

export class BybitClient {
  readonly base: string;
  private readonly credentials?: Credentials;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;
  private readonly recvWindow: number;
  private readonly now: () => number;

  constructor(opts: ClientOptions) {
    this.base = opts.base;
    this.credentials = opts.credentials;
    this.fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.recvWindow = opts.recvWindow ?? 5_000;
    this.now = opts.now ?? Date.now;
  }

  get hasCredentials() {
    return !!this.credentials;
  }

  async publicGet<T>(path: string, params: Record<string, string>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request<T>("GET", path, params, undefined, false);
      } catch (e) {
        if (attempt < 3 && e instanceof BybitApiError && (e.code === RATE_LIMITED || e.code === 429)) {
          await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  privateGet<T>(path: string, params: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, params, undefined, true);
  }

  privatePost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", path, {}, body, true);
  }

  private async request<T>(method: "GET" | "POST", path: string, params: Record<string, string>, body: Record<string, unknown> | undefined, signed: boolean): Promise<T> {
    const query = new URLSearchParams(params).toString();
    const url = `${this.base}${path}${query ? `?${query}` : ""}`;
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signed) {
      if (!this.credentials) throw new Error(`Bybit ${path}: потрібні API-ключі`);
      const ts = String(this.now());
      const recv = String(this.recvWindow);
      const sign = createHmac("sha256", this.credentials.secret)
        .update(ts + this.credentials.key + recv + (method === "GET" ? query : payload))
        .digest("hex");
      headers["X-BAPI-API-KEY"] = this.credentials.key;
      headers["X-BAPI-TIMESTAMP"] = ts;
      headers["X-BAPI-RECV-WINDOW"] = recv;
      headers["X-BAPI-SIGN"] = sign;
    }
    let res: Response;
    try {
      res = await this.fetcher(url, { method, headers, body: method === "POST" ? payload : undefined, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new UncertainError(e instanceof Error ? `${e.name}: ${e.message}` : String(e), path);
    }
    const text = await res.text().catch(() => "");
    if (res.status === 429) throw new BybitApiError(429, "HTTP 429", path);
    if (res.status >= 500) throw new UncertainError(`HTTP ${res.status}`, path);
    if (!res.ok) throw new BybitApiError(res.status, `HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`, path);
    let env: Envelope<T>;
    try {
      env = JSON.parse(text) as Envelope<T>;
    } catch {
      throw new UncertainError(`не JSON: ${text.slice(0, 120)}`, path);
    }
    if (env.retCode !== 0) throw new BybitApiError(env.retCode, env.retMsg, path);
    return env.result;
  }
}

export type Category = "linear" | "spot";

const toCandle = (k: string[]): Candle => ({ openTime: Number(k[0]), open: dec(k[1]), high: dec(k[2]), low: dec(k[3]), close: dec(k[4]) });

/** Публічні ринкові дані одного контракту. */
export class BybitMarket {
  constructor(
    readonly client: BybitClient,
    readonly symbol: string,
  ) {}

  /** Свічки з початком у [start, end], від старих до нових. interval: "D", "60", "1" тощо. До 1000 за запит. */
  async kline(interval: string, start: number, end: number, category: Category = "linear"): Promise<Candle[]> {
    const res = await this.client.publicGet<{ list: string[][] }>("/v5/market/kline", {
      category,
      symbol: this.symbol,
      interval,
      start: String(start),
      end: String(end),
      limit: "1000",
    });
    return res.list.map(toCandle).sort((a, b) => a.openTime - b.openTime);
  }

  /** Свічки ціни маркування (для оцінки фандингу). */
  async markKline(interval: string, start: number, end: number): Promise<Candle[]> {
    const res = await this.client.publicGet<{ list: string[][] }>("/v5/market/mark-price-kline", {
      category: "linear",
      symbol: this.symbol,
      interval,
      start: String(start),
      end: String(end),
      limit: "1000",
    });
    return res.list.map(toCandle).sort((a, b) => a.openTime - b.openTime);
  }

  /** Історичні ставки фандингу з моментом нарахування в [start, end]. До 200 за запит. */
  async fundingHistory(start: number, end: number): Promise<FundingRate[]> {
    const res = await this.client.publicGet<{ list: { fundingRate: string; fundingRateTimestamp: string }[] }>("/v5/market/funding/history", {
      category: "linear",
      symbol: this.symbol,
      startTime: String(start),
      endTime: String(end),
      limit: "200",
    });
    return res.list.map((r) => ({ ts: Number(r.fundingRateTimestamp), rate: dec(r.fundingRate) })).sort((a, b) => a.ts - b.ts);
  }

  async instrument(): Promise<InstrumentSpec> {
    const res = await this.client.publicGet<{
      list: {
        symbol: string;
        status: string;
        priceFilter: { tickSize: string };
        lotSizeFilter: { qtyStep: string; minOrderQty: string; minNotionalValue?: string; maxMktOrderQty?: string; maxOrderQty: string };
      }[];
    }>("/v5/market/instruments-info", { category: "linear", symbol: this.symbol });
    const i = res.list[0];
    if (!i) throw new Error(`контракт ${this.symbol} не знайдено`);
    return {
      symbol: i.symbol,
      status: i.status,
      tickSize: dec(i.priceFilter.tickSize),
      qtyStep: dec(i.lotSizeFilter.qtyStep),
      minOrderQty: dec(i.lotSizeFilter.minOrderQty),
      minNotional: dec(i.lotSizeFilter.minNotionalValue ?? "0"),
      maxMktOrderQty: dec(i.lotSizeFilter.maxMktOrderQty ?? i.lotSizeFilter.maxOrderQty),
    };
  }

  async ticker(): Promise<Ticker> {
    const res = await this.client.publicGet<{
      list: { lastPrice: string; bid1Price: string; ask1Price: string; markPrice: string; fundingRate: string; nextFundingTime: string }[];
      time?: number;
    }>("/v5/market/tickers", { category: "linear", symbol: this.symbol });
    const t = res.list[0];
    if (!t) throw new Error(`тікер ${this.symbol} не знайдено`);
    return {
      ts: Date.now(),
      last: dec(t.lastPrice),
      bid: dec(t.bid1Price),
      ask: dec(t.ask1Price),
      mark: dec(t.markPrice),
      fundingRate: dec(t.fundingRate || "0"),
      nextFundingTime: Number(t.nextFundingTime),
    };
  }
}
