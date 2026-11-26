/**
 * Виконання на Bybit (testnet або live) через приватний API V5. Стоп живе на біржі (stopLoss позиції,
 * slTriggerBy=LastPrice, tpslMode=Full) і працює, коли процес бота вимкнений.
 * Модуль не логує ключів і не зберігає їх: вони лише в BybitClient.
 */
import type { AccountCheck, Broker, ExchangePosition, Fill, FundingEvent, OrderState, PlaceRequest } from "./broker";
import { BybitApiError, type BybitClient } from "./bybit";
import { dec, ZERO, type Dec } from "./decimal";
import { DAY_MS } from "./strategy";
import type { OrderSide, Ticker } from "./types";

/** Код «нічого не змінено» для set-leverage і switch-mode: це не помилка. */
const LEVERAGE_NOT_MODIFIED = 110043;
const MODE_NOT_MODIFIED = 110025;
/** Bybit дозволяє вікно не довше 7 діб для execution/list і transaction-log. */
const WINDOW = 7 * DAY_MS - 1;

interface RawOrder {
  orderId: string;
  orderLinkId: string;
  orderStatus: string;
  side: OrderSide;
  qty: string;
  cumExecQty: string;
  reduceOnly: boolean;
  stopOrderType: string;
  rejectReason: string;
}

const toOrder = (o: RawOrder): OrderState => ({
  orderId: o.orderId,
  orderLinkId: o.orderLinkId ?? "",
  status: o.orderStatus,
  side: o.side,
  qty: dec(o.qty || "0"),
  cumExecQty: dec(o.cumExecQty || "0"),
  reduceOnly: !!o.reduceOnly,
  stopOrderType: o.stopOrderType ?? "",
  rejectReason: o.rejectReason ?? "",
});

interface RawExec {
  execId: string;
  orderId: string;
  orderLinkId: string;
  side: OrderSide;
  execQty: string;
  execPrice: string;
  execFee: string;
  execTime: string;
  execType: string;
}

const toFill = (e: RawExec): Fill => ({
  execId: e.execId,
  orderId: e.orderId,
  orderLinkId: e.orderLinkId ?? "",
  side: e.side,
  qty: dec(e.execQty),
  price: dec(e.execPrice),
  fee: dec(e.execFee || "0"),
  time: Number(e.execTime),
});

export class BybitBroker implements Broker {
  constructor(
    readonly kind: "testnet" | "live",
    private readonly client: BybitClient,
    private readonly symbol: string,
    private readonly leverage: Dec,
    private readonly now: () => number = Date.now,
  ) {
    if (!client.hasCredentials) throw new Error(`${kind}: потрібні API-ключі в оточенні`);
  }

  async tick(_t: Ticker): Promise<void> {}
  async recover(_now: number): Promise<void> {}

  private async positions() {
    return (
      await this.client.privateGet<{ list: { positionIdx: number; side: string; size: string; avgPrice: string; stopLoss: string; leverage: string }[] }>(
        "/v5/position/list",
        { category: "linear", symbol: this.symbol },
      )
    ).list;
  }

  async account(): Promise<AccountCheck> {
    const reasons: string[] = [];
    let list = await this.positions();
    const busy = list.some((p) => dec(p.size || "0").gt(ZERO));
    if (list.some((p) => p.positionIdx !== 0)) {
      if (busy) reasons.push("режим хеджування з відкритою позицією: потрібен one-way");
      else {
        try {
          await this.client.privatePost("/v5/position/switch-mode", { category: "linear", symbol: this.symbol, mode: 0 });
        } catch (e) {
          if (!(e instanceof BybitApiError && e.code === MODE_NOT_MODIFIED)) reasons.push(`не вдалося ввімкнути one-way: ${(e as Error).message}`);
        }
        list = await this.positions();
        if (list.some((p) => p.positionIdx !== 0)) reasons.push("режим позиції не one-way");
      }
    }
    const lev = list[0]?.leverage;
    if (lev !== undefined && !dec(lev).eq(this.leverage)) {
      try {
        await this.client.privatePost("/v5/position/set-leverage", { category: "linear", symbol: this.symbol, buyLeverage: this.leverage.toString(), sellLeverage: this.leverage.toString() });
      } catch (e) {
        if (!(e instanceof BybitApiError && e.code === LEVERAGE_NOT_MODIFIED)) reasons.push(`не вдалося встановити плече ${this.leverage}x: ${(e as Error).message}`);
      }
    }
    const wallet = await this.client.privateGet<{ list: { totalAvailableBalance?: string; coin: { coin: string; walletBalance: string; availableToWithdraw?: string }[] }[] }>(
      "/v5/account/wallet-balance",
      { accountType: "UNIFIED" },
    );
    const acct = wallet.list[0];
    if (!acct) reasons.push("гаманець UNIFIED не знайдено");
    const usdt = acct?.coin.find((c) => c.coin === "USDT");
    const raw = acct?.totalAvailableBalance || usdt?.availableToWithdraw || "0";
    const available = dec(raw || "0");
    if (!available.gt(ZERO)) reasons.push("немає доступного балансу USDT");
    return { ok: reasons.length === 0, reasons, available };
  }

  async openOrders(): Promise<OrderState[]> {
    const res = await this.client.privateGet<{ list: RawOrder[] }>("/v5/order/realtime", { category: "linear", symbol: this.symbol, limit: "50" });
    return res.list.map(toOrder);
  }

  async position(): Promise<ExchangePosition> {
    const list = await this.positions();
    const p = list.find((x) => dec(x.size || "0").gt(ZERO)) ?? list[0];
    if (!p || !dec(p.size || "0").gt(ZERO)) return { side: null, size: ZERO, avgPrice: ZERO, stopLoss: null, positionIdx: p?.positionIdx ?? 0 };
    const sl = p.stopLoss && dec(p.stopLoss).gt(ZERO) ? dec(p.stopLoss) : null;
    return { side: p.side === "Buy" ? "long" : "short", size: dec(p.size), avgPrice: dec(p.avgPrice), stopLoss: sl, positionIdx: p.positionIdx };
  }

  async placeMarket(req: PlaceRequest): Promise<{ orderId: string }> {
    const body: Record<string, unknown> = {
      category: "linear",
      symbol: this.symbol,
      side: req.side,
      orderType: "Market",
      qty: req.qty.toString(),
      positionIdx: 0,
      orderLinkId: req.orderLinkId,
      timeInForce: "IOC",
    };
    if (req.reduceOnly) body.reduceOnly = true;
    if (req.stopLoss) Object.assign(body, { stopLoss: req.stopLoss.toString(), slTriggerBy: "LastPrice", tpslMode: "Full", slOrderType: "Market" });
    const res = await this.client.privatePost<{ orderId: string }>("/v5/order/create", body);
    return { orderId: res.orderId };
  }

  async order(orderLinkId: string): Promise<OrderState | null> {
    const live = await this.client.privateGet<{ list: RawOrder[] }>("/v5/order/realtime", { category: "linear", symbol: this.symbol, orderLinkId });
    if (live.list[0]) return toOrder(live.list[0]);
    const hist = await this.client.privateGet<{ list: RawOrder[] }>("/v5/order/history", { category: "linear", symbol: this.symbol, orderLinkId });
    return hist.list[0] ? toOrder(hist.list[0]) : null;
  }

  async fills(orderLinkId: string): Promise<Fill[]> {
    const res = await this.client.privateGet<{ list: RawExec[] }>("/v5/execution/list", { category: "linear", symbol: this.symbol, orderLinkId, limit: "100" });
    return res.list.filter((e) => e.execType === "Trade").map(toFill);
  }

  async fillsSince(ts: number): Promise<Fill[]> {
    const out: Fill[] = [];
    const end = this.now();
    for (let start = ts; start <= end; start += WINDOW + 1) {
      let cursor = "";
      for (let page = 0; page < 20; page++) {
        const res = await this.client.privateGet<{ list: RawExec[]; nextPageCursor?: string }>("/v5/execution/list", {
          category: "linear",
          symbol: this.symbol,
          startTime: String(start),
          endTime: String(Math.min(start + WINDOW, end)),
          limit: "100",
          ...(cursor ? { cursor } : {}),
        });
        out.push(...res.list.filter((e) => e.execType === "Trade").map(toFill));
        cursor = res.nextPageCursor ?? "";
        if (!cursor) break;
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  async setStop(stop: Dec): Promise<void> {
    await this.client.privatePost("/v5/position/trading-stop", {
      category: "linear",
      symbol: this.symbol,
      tpslMode: "Full",
      positionIdx: 0,
      stopLoss: stop.toString(),
      slTriggerBy: "LastPrice",
      slOrderType: "Market",
    });
  }

  /**
   * Фандинг з журналу транзакцій UTA (type=SETTLEMENT). У полі funding додатне значення — витрата,
   * від'ємне — дохід; переводимо в грошовий потік для бота. Перевірити знак на testnet перед live.
   */
  async fundingSince(ts: number): Promise<FundingEvent[]> {
    const out: FundingEvent[] = [];
    const end = this.now();
    for (let start = ts; start <= end; start += WINDOW + 1) {
      let cursor = "";
      for (let page = 0; page < 20; page++) {
        const res = await this.client.privateGet<{ list: { symbol: string; funding: string; transactionTime: string }[]; nextPageCursor?: string }>(
          "/v5/account/transaction-log",
          {
            accountType: "UNIFIED",
            category: "linear",
            currency: "USDT",
            type: "SETTLEMENT",
            startTime: String(start),
            endTime: String(Math.min(start + WINDOW, end)),
            limit: "50",
            ...(cursor ? { cursor } : {}),
          },
        );
        for (const r of res.list) if (r.symbol === this.symbol && r.funding) out.push({ ts: Number(r.transactionTime), amount: dec(r.funding).neg() });
        cursor = res.nextPageCursor ?? "";
        if (!cursor) break;
      }
    }
    return out;
  }
}
