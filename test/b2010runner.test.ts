import { beforeEach, describe, expect, it } from "vitest";
import type { AccountCheck, Broker, ExchangePosition, Fill, FundingEvent, MarketFeed, OrderState, PlaceRequest } from "../src/b2010/broker";
import { BybitApiError, UncertainError } from "../src/b2010/bybit";
import { dec, ZERO, type Dec } from "../src/b2010/decimal";
import { PaperBroker } from "../src/b2010/paper";
import { Runner, type RunnerConfig } from "../src/b2010/runner";
import { Store } from "../src/b2010/store";
import { DAY_MS, HOUR_MS } from "../src/b2010/strategy";
import type { Candle, FundingRate, Ticker } from "../src/b2010/types";
import { d, daily, day, flat, SPEC } from "./b2010.helpers";

class FakeFeed implements MarketFeed {
  readonly symbol = "BTCUSDT";
  candles: Candle[] = daily([...flat(25), [100, 107, 99, 106]]);
  minute: Candle[] = [];
  funding: FundingRate[] = [];
  px = { last: d(107), bid: d("106.9"), ask: d("107.1"), mark: d(107), rate: d("0.0001"), next: day(26) + 8 * HOUR_MS };
  spec = { ...SPEC };
  constructor(private readonly clock: () => number) {}
  async dailyClosed(now: number, limit: number) {
    return this.candles.filter((c) => c.openTime + DAY_MS <= now).slice(-limit);
  }
  async ticker(): Promise<Ticker> {
    const p = this.px;
    return { ts: this.clock(), last: p.last, bid: p.bid, ask: p.ask, mark: p.mark, fundingRate: p.rate, nextFundingTime: p.next };
  }
  async instrument() {
    return this.spec;
  }
  async minuteCandles(from: number, to: number) {
    return this.minute.filter((c) => c.openTime >= from && c.openTime <= to);
  }
  async fundingHistory(from: number, to: number) {
    return this.funding.filter((f) => f.ts >= from && f.ts <= to);
  }
}

/** Біржа для перевірки збоїв: таймаут відправлення, часткове виконання, стоп, що не ставиться. */
class FakeBroker implements Broker {
  readonly kind = "testnet" as const;
  pos: ExchangePosition = { side: null, size: ZERO, avgPrice: ZERO, stopLoss: null, positionIdx: 0 };
  orders = new Map<string, OrderState>();
  fillList: Fill[] = [];
  placed: PlaceRequest[] = [];
  timeoutOnPlace = false;
  partial: Dec | null = null;
  dropStop = false;
  failSetStop = false;
  constructor(private readonly clock: () => number) {}
  async tick() {}
  async recover() {}
  async account(): Promise<AccountCheck> {
    return { ok: true, reasons: [], available: d(1_000_000) };
  }
  async openOrders() {
    return [];
  }
  async position() {
    return { ...this.pos };
  }
  async placeMarket(req: PlaceRequest) {
    this.placed.push(req);
    if (this.orders.has(req.orderLinkId)) throw new BybitApiError(110072, "OrderLinkedID is duplicate", "/v5/order/create");
    const qty = req.reduceOnly ? req.qty : (this.partial ?? req.qty);
    const price = req.side === "Buy" ? d("107.1") : d("106.9");
    const orderId = `o${this.orders.size + 1}`;
    this.orders.set(req.orderLinkId, {
      orderId,
      orderLinkId: req.orderLinkId,
      status: this.partial && !req.reduceOnly ? "PartiallyFilledCanceled" : "Filled",
      side: req.side,
      qty: req.qty,
      cumExecQty: qty,
      reduceOnly: !!req.reduceOnly,
      stopOrderType: "",
      rejectReason: "",
    });
    this.fillList.push({ execId: `e${this.fillList.length + 1}`, orderId, orderLinkId: req.orderLinkId, side: req.side, qty, price, fee: qty.mul(price).mul("0.00055"), time: this.clock() });
    if (req.reduceOnly) {
      const left = this.pos.size.sub(qty);
      this.pos = left.gt(0) ? { ...this.pos, size: left } : { side: null, size: ZERO, avgPrice: ZERO, stopLoss: null, positionIdx: 0 };
    } else this.pos = { side: req.side === "Buy" ? "long" : "short", size: qty, avgPrice: price, stopLoss: req.stopLoss && !this.dropStop ? req.stopLoss : null, positionIdx: 0 };
    if (this.timeoutOnPlace) throw new UncertainError("The operation was aborted due to timeout", "/v5/order/create");
    return { orderId };
  }
  async order(link: string) {
    return this.orders.get(link) ?? null;
  }
  async fills(link: string) {
    return this.fillList.filter((f) => f.orderLinkId === link);
  }
  async fillsSince(ts: number) {
    return this.fillList.filter((f) => f.time >= ts);
  }
  async setStop(stop: Dec) {
    if (this.failSetStop) throw new BybitApiError(10001, "set trading stop failed", "/v5/position/trading-stop");
    this.pos = { ...this.pos, stopLoss: stop };
  }
  async fundingSince(): Promise<FundingEvent[]> {
    return [];
  }
}

const CFG: RunnerConfig = {
  startBalance: dec(500),
  riskFraction: dec("0.005"),
  takerFee: dec("0.00055"),
  slippage: dec("0.0005"),
  leverage: dec(1),
  entryWindowMs: 120_000,
  pollMs: 1000,
  linkPrefix: "b2010",
};

let now = 0;
const clock = () => now;
const noSleep = async () => {};
let store: Store;
let feed: FakeFeed;

beforeEach(() => {
  now = day(26) + 5_000;
  store = new Store(":memory:", clock);
  feed = new FakeFeed(clock);
});

const paper = () => new PaperBroker(store, feed, CFG.takerFee, CFG.slippage, clock);
const runner = (broker: Broker, cfg: Partial<RunnerConfig> = {}) => new Runner(store, feed, broker, { ...CFG, ...cfg }, clock, noSleep);

describe("b2010 paper: вхід і супровід", () => {
  it("лонг: вхід за ask у вікні після закриття, стоп 10 днів, сигнал обробляється один раз", async () => {
    const r = runner(paper());
    await r.step();
    const t = store.openTrade()!;
    expect(t.side).toBe("long");
    expect(t.entry_price).toBe("107.1");
    expect(t.stop).toBe("95");
    expect(store.signal("2026-01-26")!.status).toBe("entered");
    expect((await r.broker.position()).stopLoss!.toString()).toBe("95");
    // Повтор події і рестарт: той самий сигнал не дає другого ордера.
    await r.step();
    await runner(paper()).step();
    expect(store.trades()).toHaveLength(1);
    expect(store.signals()).toHaveLength(1);
  });

  it("після вікна входу сигнал прострочений, позиція заднім числом не відкривається", async () => {
    now = day(26) + 200_000;
    await runner(paper()).step();
    expect(store.trades()).toHaveLength(0);
    expect(store.signal("2026-01-26")).toMatchObject({ status: "expired", reason: "expired" });
  });

  it("стоп за LastPrice: вихід за bid", async () => {
    const r = runner(paper());
    await r.step();
    feed.px = { ...feed.px, last: d(95), bid: d("94.9"), ask: d(95) };
    now += 60_000;
    await r.step();
    const t = store.trades()[0];
    expect(t.status).toBe("closed");
    expect(t.exit_reason).toBe("stop");
    expect(t.exit_price).toBe("94.9");
    expect(dec(t.net!).lt(0)).toBe(true);
  });

  it("стоп не послаблюється після нового денного закриття", async () => {
    const r = runner(paper());
    await r.step();
    const t = store.openTrade()!;
    store.setStop(t.id, "99");
    await r.protect(t.id);
    feed.candles.push(...daily([[107, 108, 104, 107]], 26));
    now = day(27) + 5_000;
    await r.step();
    expect(store.openTrade()!.stop).toBe("99");
    expect((await r.broker.position()).stopLoss!.toString()).toBe("99");
  });

  it("новий стоп уже пройдено — закриття через reduceOnly", async () => {
    const r = runner(paper());
    await r.step();
    feed.candles.push(...daily(Array.from({ length: 11 }, () => [106, 106, 104, 106] as [number, number, number, number]), 26));
    feed.px = { ...feed.px, last: d(103), bid: d("102.9"), ask: d("103.1") };
    now = day(37) + 5_000;
    await r.step();
    const t = store.trades()[0];
    expect(t.status).toBe("closed");
    expect(t.exit_reason).toBe("trail_close");
    expect(t.stop).toBe("104");
    expect(t.exit_price).toBe("102.9");
  });

  it("фандинг: лонг платить за додатної ставки", async () => {
    const r = runner(paper());
    await r.step();
    const t = store.openTrade()!;
    now = day(26) + 8 * HOUR_MS + 1_000;
    feed.px = { ...feed.px, next: day(26) + 16 * HOUR_MS };
    await r.step();
    const funding = dec(store.trade(t.id)!.funding);
    expect(funding.toString()).toBe(dec(t.qty).mul(107).mul("0.0001").neg().toString());
  });

  it("рестарт paper: стоп, пропущений поки процес не працював, відновлюється за хвилинними свічками", async () => {
    await runner(paper()).step();
    now += 2 * HOUR_MS;
    feed.minute = [{ openTime: day(26) + HOUR_MS, open: d(97), high: d(97), low: d(94), close: d(96) }];
    await runner(paper()).step();
    const t = store.trades()[0];
    expect(t.exit_reason).toBe("stop");
    expect(t.exit_price).toBe(dec(95).mul("0.9995").toString());
  });

  it("замалий ордер — пропуск із причиною", async () => {
    await runner(paper(), { startBalance: dec("0.5") }).step();
    expect(store.trades()).toHaveLength(0);
    expect(store.signal("2026-01-26")).toMatchObject({ status: "skipped", reason: "qty_below_min" });
  });
});

describe("b2010 біржа: збої виконання", () => {
  it("рестарт після відправлення ордера: стан звіряється з біржею, другого ордера немає", async () => {
    const b = new FakeBroker(clock);
    b.timeoutOnPlace = true;
    await runner(b).step();
    expect(store.trades()).toHaveLength(0);
    expect(store.intent("b2010-20260126-L")!.status).toBe("unknown");
    expect(store.blockReasons().length).toBeGreaterThan(0);
    b.timeoutOnPlace = false;
    now += 3_000;
    await runner(b).step();
    expect(b.placed).toHaveLength(1);
    expect(store.trades()).toHaveLength(1);
    expect(store.openTrade()!.qty).toBe(b.pos.size.toString());
    expect(store.intent("b2010-20260126-L")!.status).toBe("done");
    expect(store.blockReasons()).toEqual([]);
  });

  it("часткове виконання без підтвердженого стопа: залишок не добирається, позиція закривається reduceOnly", async () => {
    const b = new FakeBroker(clock);
    b.partial = d("0.1");
    b.dropStop = true;
    b.failSetStop = true;
    await runner(b).step();
    expect(b.placed).toHaveLength(2);
    expect(b.placed[1]).toMatchObject({ reduceOnly: true, side: "Sell" });
    expect(b.placed[1].qty.toString()).toBe("0.1");
    const t = store.trades()[0];
    expect(t.qty).toBe("0.1");
    expect(t.status).toBe("closed");
    expect(t.exit_reason).toBe("protect_close");
    const kinds = store.events(50).map((e) => `${e.level}:${e.kind}`);
    expect(kinds).toContain("warn:partial");
    expect(kinds).toContain("critical:unprotected");
  });

  it("часткове виконання, стоп відновлено повторним Set Trading Stop", async () => {
    const b = new FakeBroker(clock);
    b.partial = d("0.1");
    b.dropStop = true;
    await runner(b).step();
    expect(b.placed).toHaveLength(1);
    expect(store.openTrade()!.qty).toBe("0.1");
    expect(b.pos.stopLoss!.toString()).toBe("95");
  });

  it("стороння позиція: нові входи зупинено, чужою позицією бот не керує", async () => {
    const b = new FakeBroker(clock);
    b.pos = { side: "long", size: d(1), avgPrice: d(100), stopLoss: null, positionIdx: 0 };
    await runner(b).step();
    expect(b.placed).toHaveLength(0);
    expect(store.signal("2026-01-26")).toMatchObject({ status: "skipped", reason: "blocked" });
    expect(store.blockReasons()[0]).toContain("стороння позиція");
  });
});
