/**
 * Спільний інтерфейс виконання для paper, testnet і live. Рушій (runner.ts) працює лише через нього,
 * тож правила сигналу, стопа й обсягу однакові в усіх режимах; різняться дані й виконання.
 */
import { BybitMarket } from "./bybit";
import { dec, type Dec } from "./decimal";
import { DAY_MS } from "./strategy";
import type { Candle, FundingRate, InstrumentSpec, OrderSide, Side, Ticker } from "./types";

export type OrderStatus = "New" | "PartiallyFilled" | "Filled" | "Cancelled" | "PartiallyFilledCanceled" | "Rejected" | "Deactivated" | "Untriggered" | string;
export const FINAL_STATUSES = new Set(["Filled", "Cancelled", "PartiallyFilledCanceled", "Rejected", "Deactivated"]);

export interface OrderState {
  orderId: string;
  orderLinkId: string;
  status: OrderStatus;
  side: OrderSide;
  qty: Dec;
  cumExecQty: Dec;
  reduceOnly: boolean;
  /** StopLoss, TakeProfit тощо для умовних ордерів захисту позиції. */
  stopOrderType: string;
  rejectReason: string;
}

export interface Fill {
  execId: string;
  orderId: string;
  orderLinkId: string;
  side: OrderSide;
  qty: Dec;
  price: Dec;
  fee: Dec;
  time: number;
}

export interface ExchangePosition {
  side: Side | null;
  size: Dec;
  avgPrice: Dec;
  stopLoss: Dec | null;
  /** 0 — one-way; 1/2 — режим хеджування. */
  positionIdx: number;
}

export interface AccountCheck {
  ok: boolean;
  reasons: string[];
  /** Доступна маржа на акаунті, USDT. */
  available: Dec;
}

export interface FundingEvent {
  ts: number;
  /** Грошовий потік для бота: від'ємний — сплачено. */
  amount: Dec;
}

export interface PlaceRequest {
  side: OrderSide;
  qty: Dec;
  orderLinkId: string;
  stopLoss?: Dec;
  reduceOnly?: boolean;
}

/** Публічні дані контракту, з яких рушій бере свічки й ціни. */
export interface MarketFeed {
  readonly symbol: string;
  /** Завершені денні свічки, від старих до нових (не більше limit). */
  dailyClosed(now: number, limit: number): Promise<Candle[]>;
  ticker(): Promise<Ticker>;
  instrument(): Promise<InstrumentSpec>;
  minuteCandles(from: number, to: number): Promise<Candle[]>;
  fundingHistory(from: number, to: number): Promise<FundingRate[]>;
}

export interface Broker {
  readonly kind: "paper" | "testnet" | "live";
  /** Paper: перевірка стопа й фандингу за свіжою ціною. Біржа робить це сама. */
  tick(t: Ticker): Promise<void>;
  /** Paper після рестарту: що сталося з позицією, поки процес був вимкнений. */
  recover(now: number): Promise<void>;
  /** Режим позиції, плече, баланс; для біржі — виправлення режиму й плеча, якщо позицій немає. */
  account(): Promise<AccountCheck>;
  openOrders(): Promise<OrderState[]>;
  position(): Promise<ExchangePosition>;
  placeMarket(req: PlaceRequest): Promise<{ orderId: string }>;
  /** Ордер за orderLinkId: активний або закритий; null — біржа його не знає. */
  order(orderLinkId: string): Promise<OrderState | null>;
  fills(orderLinkId: string): Promise<Fill[]>;
  fillsSince(ts: number): Promise<Fill[]>;
  setStop(stop: Dec): Promise<void>;
  fundingSince(ts: number): Promise<FundingEvent[]>;
}

/** MarketFeed поверх публічного API Bybit. */
export function bybitFeed(market: BybitMarket): MarketFeed {
  return {
    symbol: market.symbol,
    async dailyClosed(now, limit) {
      const list = await market.kline("D", now - (limit + 1) * DAY_MS, now);
      return list.filter((c) => c.openTime + DAY_MS <= now).slice(-limit);
    },
    ticker: () => market.ticker(),
    instrument: () => market.instrument(),
    async minuteCandles(from, to) {
      const out: Candle[] = [];
      let start = from;
      for (let guard = 0; guard < 200 && start <= to; guard++) {
        const page = (await market.kline("1", start, to)).filter((c) => c.openTime >= start && c.openTime <= to);
        out.push(...page);
        if (page.length < 1000) break;
        start = page[page.length - 1].openTime + 60_000;
      }
      return out;
    },
    fundingHistory: (from, to) => market.fundingHistory(from, to),
  };
}

export const sumQty = (fills: Fill[]) => fills.reduce((s, f) => s.add(f.qty), dec(0));
export const sumFee = (fills: Fill[]) => fills.reduce((s, f) => s.add(f.fee), dec(0));
/** Середня ціна за фактичними виконаннями. */
export const avgPrice = (fills: Fill[]) => {
  const q = sumQty(fills);
  return q.isZero() ? dec(0) : fills.reduce((s, f) => s.add(f.price.mul(f.qty)), dec(0)).div(q);
};
