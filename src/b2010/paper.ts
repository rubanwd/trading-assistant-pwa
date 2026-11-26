/**
 * Paper: імітація біржі на публічних даних mainnet без приватного ключа. Купівля за ask, продаж за bid,
 * стоп за LastPrice, фандинг за ставкою й ціною маркування на момент нарахування. Стан — у SQLite рушія,
 * тож після рестарту позиція, ордери й виконання ті самі. Поки процес вимкнений, стоп «на біржі» відновлюється
 * за хвилинними свічками: ціна виходу — рівень стопа або Open хвилини, якщо вона відкрилась за ним, з прослизанням.
 */
import type { AccountCheck, Broker, ExchangePosition, Fill, FundingEvent, MarketFeed, OrderState, PlaceRequest } from "./broker";
import { BybitApiError } from "./bybit";
import { dec, dmin, ZERO, type Dec } from "./decimal";
import { adverse } from "./sizing";
import type { Store } from "./store";
import { stopReached } from "./strategy";
import { exitOrderSide, sideSign, type OrderSide, type Side, type Ticker } from "./types";

interface PaperPosition {
  side: Side;
  size: string;
  avgPrice: string;
  stopLoss: string | null;
  openedAt: number;
}

interface PaperOrder {
  orderId: string;
  orderLinkId: string;
  side: OrderSide;
  qty: string;
  cumExecQty: string;
  reduceOnly: boolean;
  status: string;
}

interface PaperFill {
  execId: string;
  orderId: string;
  orderLinkId: string;
  side: OrderSide;
  qty: string;
  price: string;
  fee: string;
  time: number;
}

interface PaperState {
  position: PaperPosition | null;
  orders: Record<string, PaperOrder>;
  fills: PaperFill[];
  funding: { ts: number; amount: string }[];
  lastTs: number;
  /** Ставка й ціна маркування з останнього тікера — їх застосовуємо в момент нарахування. */
  rate: string | null;
  mark: string | null;
  nextFundingTime: number | null;
  seq: number;
}

const KEY = "paper_state";
const EMPTY: PaperState = { position: null, orders: {}, fills: [], funding: [], lastTs: 0, rate: null, mark: null, nextFundingTime: null, seq: 0 };

export class PaperBroker implements Broker {
  readonly kind = "paper" as const;
  private last: Ticker | null = null;

  constructor(
    private readonly store: Store,
    private readonly feed: MarketFeed,
    private readonly takerFee: Dec,
    private readonly slippage: Dec,
    private readonly now: () => number = Date.now,
  ) {}

  private load(): PaperState {
    const raw = this.store.get(KEY);
    return raw ? (JSON.parse(raw) as PaperState) : structuredClone(EMPTY);
  }

  private save(s: PaperState) {
    this.store.set(KEY, JSON.stringify(s));
  }

  private fill(s: PaperState, o: PaperOrder, qty: Dec, price: Dec, time: number) {
    s.seq++;
    const f: PaperFill = {
      execId: `paper-${s.seq}`,
      orderId: o.orderId,
      orderLinkId: o.orderLinkId,
      side: o.side,
      qty: qty.toString(),
      price: price.toString(),
      fee: qty.mul(price).mul(this.takerFee).toString(),
      time,
    };
    s.fills.push(f);
    o.cumExecQty = dec(o.cumExecQty).add(qty).toString();
    const p = s.position;
    const buy = o.side === "Buy";
    if (!p) {
      s.position = { side: buy ? "long" : "short", size: qty.toString(), avgPrice: price.toString(), stopLoss: null, openedAt: time };
    } else if ((p.side === "long") === buy) {
      const size = dec(p.size).add(qty);
      p.avgPrice = dec(p.avgPrice).mul(dec(p.size)).add(price.mul(qty)).div(size).toString();
      p.size = size.toString();
    } else {
      const size = dec(p.size).sub(qty);
      if (size.lte(ZERO)) s.position = null;
      else p.size = size.toString();
    }
  }

  /** Вихід за стопом «біржею». */
  private stopOut(s: PaperState, price: Dec, time: number) {
    const p = s.position!;
    s.seq++;
    const o: PaperOrder = {
      orderId: `paper-o-${s.seq}`,
      orderLinkId: "",
      side: exitOrderSide(p.side),
      qty: p.size,
      cumExecQty: "0",
      reduceOnly: true,
      status: "Filled",
    };
    s.orders[o.orderId] = o;
    this.fill(s, o, dec(p.size), price, time);
  }

  private chargeFunding(s: PaperState, ts: number, rate: Dec, mark: Dec) {
    const p = s.position;
    if (!p || p.openedAt >= ts || s.funding.some((f) => f.ts === ts)) return;
    // Додатна ставка: лонг платить, шорт отримує.
    const amount = dec(p.size).mul(mark).mul(rate).mul(-sideSign(p.side));
    s.funding.push({ ts, amount: amount.toString() });
  }

  async tick(t: Ticker): Promise<void> {
    this.last = t;
    const s = this.load();
    const p = s.position;
    if (p && s.nextFundingTime !== null && t.ts >= s.nextFundingTime && s.rate !== null && s.mark !== null) this.chargeFunding(s, s.nextFundingTime, dec(s.rate), dec(s.mark));
    if (p && p.stopLoss !== null && s.position && stopReached(p.side, dec(p.stopLoss), t.last)) this.stopOut(s, p.side === "long" ? t.bid : t.ask, t.ts);
    s.rate = t.fundingRate.toString();
    s.mark = t.mark.toString();
    s.nextFundingTime = t.nextFundingTime;
    s.lastTs = t.ts;
    this.save(s);
  }

  async recover(now: number): Promise<void> {
    const s = this.load();
    const p = s.position;
    if (!p || !s.lastTs || now - s.lastTs < 60_000) return;
    const from = Math.floor(s.lastTs / 60_000) * 60_000;
    const candles = await this.feed.minuteCandles(from, now);
    let exitAt: number | null = null;
    if (p.stopLoss !== null) {
      const stop = dec(p.stopLoss);
      for (const c of candles) {
        const hit = p.side === "long" ? c.low.lte(stop) : c.high.gte(stop);
        if (!hit) continue;
        const base = stopReached(p.side, stop, c.open) ? c.open : stop;
        exitAt = c.openTime;
        // Фандинг до виходу: нарахування в хвилині виходу — консервативно (лише якщо це витрата).
        await this.recoverFunding(s, from, exitAt, candles);
        this.stopOut(s, adverse(base, exitOrderSide(p.side), this.slippage), c.openTime);
        break;
      }
    }
    if (exitAt === null) await this.recoverFunding(s, from, now, candles);
    s.lastTs = now;
    s.nextFundingTime = null;
    this.save(s);
  }

  private async recoverFunding(s: PaperState, from: number, to: number, candles: { openTime: number; open: Dec }[]) {
    const rates = await this.feed.fundingHistory(from, to);
    for (const r of rates) {
      if (r.ts <= from || r.ts > to) continue;
      const c = candles.find((x) => x.openTime === r.ts);
      const mark = c?.open ?? (s.mark ? dec(s.mark) : null);
      if (!mark) continue;
      const before = s.funding.length;
      this.chargeFunding(s, r.ts, r.rate, mark);
      // Вихід у ту саму хвилину, що й нарахування: дохід не беремо.
      if (r.ts === to && s.funding.length > before && dec(s.funding[s.funding.length - 1].amount).gt(ZERO)) s.funding.pop();
    }
  }

  async account(): Promise<AccountCheck> {
    // Капітал бота обмежує рушій; окремого балансу paper не має.
    return { ok: true, reasons: [], available: dec("1e15") };
  }

  async openOrders(): Promise<OrderState[]> {
    return [];
  }

  async position(): Promise<ExchangePosition> {
    const p = this.load().position;
    if (!p) return { side: null, size: ZERO, avgPrice: ZERO, stopLoss: null, positionIdx: 0 };
    return { side: p.side, size: dec(p.size), avgPrice: dec(p.avgPrice), stopLoss: p.stopLoss === null ? null : dec(p.stopLoss), positionIdx: 0 };
  }

  async placeMarket(req: PlaceRequest): Promise<{ orderId: string }> {
    const s = this.load();
    if (Object.values(s.orders).some((o) => o.orderLinkId === req.orderLinkId)) throw new BybitApiError(110072, "OrderLinkedID is duplicate", "/v5/order/create");
    const t = await this.feed.ticker();
    this.last = t;
    s.seq++;
    const o: PaperOrder = {
      orderId: `paper-o-${s.seq}`,
      orderLinkId: req.orderLinkId,
      side: req.side,
      qty: req.qty.toString(),
      cumExecQty: "0",
      reduceOnly: !!req.reduceOnly,
      status: "Filled",
    };
    s.orders[o.orderId] = o;
    let qty = req.qty;
    if (req.reduceOnly) {
      const p = s.position;
      if (!p || (p.side === "long") === (req.side === "Buy")) {
        o.status = "Rejected";
        this.save(s);
        throw new BybitApiError(110017, "reduce-only order has same side with current position", "/v5/order/create");
      }
      qty = dmin(qty, dec(p.size));
    }
    const price = req.side === "Buy" ? t.ask : t.bid;
    this.fill(s, o, qty, price, this.now());
    if (req.stopLoss && s.position) s.position.stopLoss = req.stopLoss.toString();
    this.save(s);
    return { orderId: o.orderId };
  }

  async order(orderLinkId: string): Promise<OrderState | null> {
    const o = Object.values(this.load().orders).find((x) => x.orderLinkId === orderLinkId);
    return o ? toState(o) : null;
  }

  async fills(orderLinkId: string): Promise<Fill[]> {
    return this.load().fills.filter((f) => f.orderLinkId === orderLinkId).map(toFill);
  }

  async fillsSince(ts: number): Promise<Fill[]> {
    return this.load().fills.filter((f) => f.time >= ts).map(toFill);
  }

  async setStop(stop: Dec): Promise<void> {
    const s = this.load();
    const p = s.position;
    if (!p) throw new BybitApiError(10001, "position not exists", "/v5/position/trading-stop");
    const last = this.last ?? (await this.feed.ticker());
    if (stopReached(p.side, stop, last.last)) throw new BybitApiError(10001, `StopLoss ${stop} beyond last price ${last.last}`, "/v5/position/trading-stop");
    p.stopLoss = stop.toString();
    this.save(s);
  }

  async fundingSince(ts: number): Promise<FundingEvent[]> {
    return this.load()
      .funding.filter((f) => f.ts >= ts)
      .map((f) => ({ ts: f.ts, amount: dec(f.amount) }));
  }
}

const toState = (o: PaperOrder): OrderState => ({
  orderId: o.orderId,
  orderLinkId: o.orderLinkId,
  status: o.status,
  side: o.side,
  qty: dec(o.qty),
  cumExecQty: dec(o.cumExecQty),
  reduceOnly: o.reduceOnly,
  stopOrderType: "",
  rejectReason: "",
});

const toFill = (f: PaperFill): Fill => ({
  execId: f.execId,
  orderId: f.orderId,
  orderLinkId: f.orderLinkId,
  side: f.side,
  qty: dec(f.qty),
  price: dec(f.price),
  fee: dec(f.fee),
  time: f.time,
});
