import type { Dec } from "./decimal";

export type Side = "long" | "short";
export type OrderSide = "Buy" | "Sell";

/** +1 для лонга, −1 для шорта. */
export const sideSign = (side: Side): 1 | -1 => (side === "long" ? 1 : -1);
export const entryOrderSide = (side: Side): OrderSide => (side === "long" ? "Buy" : "Sell");
export const exitOrderSide = (side: Side): OrderSide => (side === "long" ? "Sell" : "Buy");

/** Свічка торгових цін контракту. openTime — початок у мс UTC. */
export interface Candle {
  openTime: number;
  open: Dec;
  high: Dec;
  low: Dec;
  close: Dec;
}

/** Обмеження контракту з /v5/market/instruments-info. */
export interface InstrumentSpec {
  symbol: string;
  status: string;
  tickSize: Dec;
  qtyStep: Dec;
  minOrderQty: Dec;
  minNotional: Dec;
  maxMktOrderQty: Dec;
}

/** Ставка фандингу та момент нарахування. */
export interface FundingRate {
  ts: number;
  rate: Dec;
}

export interface Ticker {
  ts: number;
  last: Dec;
  bid: Dec;
  ask: Dec;
  mark: Dec;
  fundingRate: Dec;
  nextFundingTime: number;
}
