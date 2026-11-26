/**
 * Рушій бота пробою 20/10 для paper, testnet і live: однаковий для всіх режимів, різниться лише Broker.
 *
 * Крок (step) кожні pollMs:
 *   1) звірка після старту чи обриву зв'язку: наміри ордерів, позиція, ордери, біржовий стоп;
 *   2) тікер → broker.tick (paper: стоп за LastPrice і фандинг);
 *   3) вихід із позиції, якщо біржа її закрила (стоп), і фандинг;
 *   4) нові завершені денні свічки по черзі: перерахунок стопа відкритої позиції, сигнал входу.
 * Сигнал обробляється один раз (таблиця signals, стабільний orderLinkId). Вхід лише у вікні entryWindowMs від початку доби;
 * пропущені через простій сигнали позначаються простроченими — позиції заднім числом не відкриваються.
 */
import { avgPrice, FINAL_STATUSES, sumFee, sumQty, type Broker, type Fill, type MarketFeed } from "./broker";
import { BybitApiError, UncertainError } from "./bybit";
import { dec, dmin, ZERO, type Dec } from "./decimal";
import { adverse, sizePosition } from "./sizing";
import type { IntentRow, SignalRow, Store, TradeRow } from "./store";
import { channelStop, DAY_MS, dayStart, evaluateEntry, isoDay, loosens, roundStop, stopReached, trailStop } from "./strategy";
import { entryOrderSide, exitOrderSide, sideSign, type Candle, type InstrumentSpec, type Side } from "./types";

export interface RunnerConfig {
  startBalance: Dec;
  riskFraction: Dec;
  takerFee: Dec;
  slippage: Dec;
  leverage: Dec;
  /** Вікно входу від початку нової доби UTC, мс (типово 120 с). */
  entryWindowMs: number;
  pollMs: number;
  /** Префікс orderLinkId: за ним бот відрізняє свої ордери від чужих. */
  linkPrefix: string;
}

/** Bybit: такий orderLinkId уже є — ордер існує, повтор не створює другого. */
const DUPLICATE_LINK = 110072;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

export class Runner {
  private reconciled = false;
  private spec: { value: InstrumentSpec; at: number } | null = null;
  private lastFundingSync = 0;
  private stopped = false;
  /** Однакова помилка пишеться в журнал не частіше разу на хвилину, щоб обрив зв'язку не засмічував події. */
  private lastError: { text: string; at: number } | null = null;
  private exitWaitLogged = 0;

  constructor(
    readonly store: Store,
    private readonly feed: MarketFeed,
    readonly broker: Broker,
    private readonly cfg: RunnerConfig,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  linkId(day: string, side: Side) {
    return `${this.cfg.linkPrefix}-${day.replaceAll("-", "")}-${side === "long" ? "L" : "S"}`;
  }

  isOurs(link: string) {
    return link.startsWith(`${this.cfg.linkPrefix}-`);
  }

  async run(): Promise<void> {
    this.store.event("info", "start", `рушій ${this.broker.kind} запущено`);
    while (!this.stopped) {
      await this.step();
      if (!this.stopped) await this.sleep(this.cfg.pollMs);
    }
    this.store.event("info", "stop", `рушій ${this.broker.kind} зупинено`);
  }

  stop() {
    this.stopped = true;
  }

  /** Один крок циклу. Помилки не виходять назовні: після будь-якої наступний крок починається зі звірки. */
  async step(): Promise<void> {
    try {
      if (!this.reconciled) await this.reconcile();
      const t = await this.feed.ticker();
      await this.broker.tick(t);
      await this.syncTrade();
      if (!this.reconciled) return;
      await this.processDays(this.clock());
      this.lastError = null;
    } catch (e) {
      this.reconciled = false;
      const text = msg(e);
      const at = this.clock();
      if (this.lastError?.text !== text || at - this.lastError.at > 60_000) {
        this.store.event("warn", e instanceof UncertainError ? "connection" : "error", `${text}; наступний крок почнеться зі звірки`);
        this.lastError = { text, at };
      }
    }
  }

  private async instrument(): Promise<InstrumentSpec> {
    if (!this.spec || this.clock() - this.spec.at > 3_600_000) this.spec = { value: await this.feed.instrument(), at: this.clock() };
    return this.spec.value;
  }

  /** Звірка з біржею: наміри, позиція, ордери, стоп. Причини блокування нових входів перераховуються щоразу. */
  async reconcile(): Promise<void> {
    await this.broker.recover(this.clock());
    for (const i of this.store.unresolvedIntents()) await this.resolveIntent(i);
    const reasons = this.store.unresolvedIntents().map((i) => `невідомий стан ордера ${i.link_id}: входи заблоковано до звірки`);
    await this.syncTrade();
    const trade = this.store.openTrade();
    const pos = await this.broker.position();
    if (pos.positionIdx !== 0) reasons.push("рахунок у режимі хеджування, потрібен one-way");
    if (trade) {
      if (pos.size.gt(ZERO) && (pos.side !== trade.side || !pos.size.eq(dec(trade.qty))))
        reasons.push(`позиція на біржі ${pos.side} ${pos.size} не збігається з позицією бота ${trade.side} ${trade.qty}: чужою позицією бот не керує`);
      else if (pos.size.gt(ZERO)) await this.protect(trade.id);
    } else if (pos.size.gt(ZERO)) reasons.push(`стороння позиція ${pos.side} ${pos.size} по ${this.feed.symbol}`);
    const foreign = (await this.broker.openOrders()).filter((o) => !this.isOurs(o.orderLinkId) && !(trade && o.reduceOnly && o.stopOrderType));
    if (foreign.length) reasons.push(`невідомі ордери по ${this.feed.symbol}: ${foreign.map((o) => o.orderId).join(", ")}`);
    const before = this.store.blockReasons().join("|");
    this.store.setBlock(reasons);
    if (reasons.length && reasons.join("|") !== before) this.store.event("critical", "blocked", `нові входи зупинено: ${reasons.join("; ")}`);
    if (!reasons.length && before) this.store.event("info", "unblocked", "звірка пройшла, входи знову дозволені");
    this.reconciled = true;
  }

  /** Довести намір до кінцевого стану за даними біржі. Повтор відправлення — лише коли біржа ордера не знає. */
  async resolveIntent(intent: IntentRow): Promise<void> {
    const st = await this.broker.order(intent.link_id);
    const now = this.clock();
    if (!st) {
      if (intent.kind === "entry" && intent.signal_day) {
        const windowEnd = dayMs(intent.signal_day) + DAY_MS + this.cfg.entryWindowMs;
        if (now <= windowEnd) {
          await this.send(intent);
          return;
        }
        if (now > windowEnd + 60_000) {
          this.store.setIntent(intent.link_id, "failed", { detail: "біржа не знає ордера, вікно входу минуло" });
          this.store.setSignal(intent.signal_day, "skipped", "not_filled", "ордер не дійшов до біржі");
          this.store.event("warn", "entry", `${intent.link_id}: біржа не знає ордера, сигнал пропущено`);
        }
      } else if (now - Date.parse(intent.created_at) > 60_000) {
        this.store.setIntent(intent.link_id, "failed", { detail: "біржа не знає ордера" });
        this.store.event("critical", "close", `${intent.link_id}: ордер закриття не знайдено на біржі`);
      }
      return;
    }
    if (!FINAL_STATUSES.has(st.status)) {
      this.store.setIntent(intent.link_id, "sent", { order_id: st.orderId });
      return;
    }
    const fills = await this.broker.fills(intent.link_id);
    const qty = sumQty(fills);
    // Виконання ще не з'явились у журналі: повторимо на наступному кроці.
    if (qty.lt(st.cumExecQty)) {
      this.store.setIntent(intent.link_id, "sent", { order_id: st.orderId });
      return;
    }
    if (intent.kind === "close") {
      for (const f of fills) this.saveFill(f, intent.trade_id);
      this.store.setIntent(intent.link_id, "done", { order_id: st.orderId });
      return;
    }
    const day = intent.signal_day!;
    if (qty.isZero()) {
      this.store.setIntent(intent.link_id, "failed", { order_id: st.orderId, detail: `${st.status} ${st.rejectReason}`.trim() });
      this.store.setSignal(day, "skipped", "not_filled", `${st.status} ${st.rejectReason}`.trim());
      this.store.event("warn", "entry", `${intent.link_id}: ордер не виконано (${st.status} ${st.rejectReason})`);
      return;
    }
    const planned = dec(intent.planned_risk ?? "0").mul(qty).div(dec(intent.qty));
    const tradeId = this.store.insertTrade({
      signal_day: day,
      side: intent.side,
      qty: qty.toString(),
      entry_price: avgPrice(fills).toString(),
      entry_ref: intent.entry_ref ?? avgPrice(fills).toString(),
      entry_time: Math.min(...fills.map((f) => f.time)),
      entry_fee: sumFee(fills).toString(),
      initial_stop: intent.stop!,
      planned_risk: planned.toString(),
    });
    for (const f of fills) this.saveFill(f, tradeId);
    this.store.setIntent(intent.link_id, "done", { order_id: st.orderId, trade_id: tradeId });
    this.store.setSignal(day, "entered");
    this.store.event("info", "entry", `вхід ${intent.side} ${qty} за ${avgPrice(fills).toFixed(2)}, стоп ${intent.stop}`);
    if (qty.lt(dec(intent.qty)))
      this.store.event("warn", "partial", `${intent.link_id}: виконано ${qty} з ${intent.qty} (${st.status}); залишок не добирається`);
    await this.protect(tradeId);
  }

  private saveFill(f: Fill, tradeId: number | null) {
    this.store.insertFill({
      exec_id: f.execId,
      trade_id: tradeId,
      link_id: f.orderLinkId,
      side: f.side,
      qty: f.qty.toString(),
      price: f.price.toString(),
      fee: f.fee.toString(),
      time: f.time,
    });
  }

  /** Відправити ордер наміру. Таймаут — стан невідомий, входи блокуються до звірки. */
  private async send(intent: IntentRow): Promise<void> {
    const side = intent.kind === "entry" ? entryOrderSide(intent.side) : exitOrderSide(intent.side);
    try {
      const r = await this.broker.placeMarket({
        side,
        qty: dec(intent.qty),
        orderLinkId: intent.link_id,
        stopLoss: intent.kind === "entry" && intent.stop ? dec(intent.stop) : undefined,
        reduceOnly: intent.kind === "close",
      });
      this.store.setIntent(intent.link_id, "sent", { order_id: r.orderId });
    } catch (e) {
      if (e instanceof BybitApiError && e.code === DUPLICATE_LINK) {
        this.store.setIntent(intent.link_id, "sent");
        return;
      }
      if (e instanceof BybitApiError) {
        this.store.setIntent(intent.link_id, "failed", { detail: e.message });
        if (intent.kind === "entry") this.store.setSignal(intent.signal_day!, "skipped", "order_rejected", e.message);
        this.store.event(intent.kind === "entry" ? "warn" : "critical", intent.kind, `${intent.link_id}: біржа відхилила ордер: ${e.message}`);
        return;
      }
      this.store.setIntent(intent.link_id, "unknown", { detail: msg(e) });
      this.store.setBlock([...this.store.blockReasons(), `невідомий стан ордера ${intent.link_id}: входи заблоковано до звірки`]);
      this.store.event("warn", "uncertain", `${intent.link_id}: результат відправлення невідомий (${msg(e)}); перевіряю стан на біржі`);
      throw e;
    }
  }

  /** Чекати кінцевого стану наміру кілька секунд. */
  private async settle(link: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const intent = this.store.intent(link)!;
      if (intent.status === "done" || intent.status === "failed") return;
      await this.resolveIntent(intent);
      const after = this.store.intent(link)!;
      if (after.status === "done" || after.status === "failed") return;
      await this.sleep(500);
    }
    this.store.event("warn", "pending", `${link}: кінцевого стану ще немає, звірка триватиме`);
  }

  /**
   * Захист позиції: біржовий стоп має дорівнювати стопу бота. Дві спроби; якщо стопа так і немає —
   * закрити належний боту залишок через reduceOnly і записати критичну подію.
   */
  async protect(tradeId: number): Promise<void> {
    this.store.set("protect_pending", String(tradeId));
    for (let attempt = 0; attempt < 2; attempt++) {
      const trade = this.store.trade(tradeId)!;
      if (trade.status !== "open") break;
      const pos = await this.broker.position();
      if (pos.size.isZero()) {
        await this.syncTrade();
        break;
      }
      if (pos.side !== trade.side || !pos.size.eq(dec(trade.qty))) {
        this.store.event("critical", "mismatch", `позиція на біржі ${pos.side} ${pos.size} ≠ позиції бота ${trade.side} ${trade.qty}`);
        this.reconciled = false;
        return;
      }
      if (pos.stopLoss && pos.stopLoss.eq(dec(trade.stop))) {
        this.store.set("protect_pending", null);
        return;
      }
      try {
        await this.broker.setStop(dec(trade.stop));
      } catch (e) {
        if (!(e instanceof BybitApiError)) throw e;
        this.store.event("warn", "stop", `не вдалося поставити стоп ${trade.stop}: ${e.message}`);
      }
    }
    const trade = this.store.trade(tradeId)!;
    if (trade.status !== "open") {
      this.store.set("protect_pending", null);
      return;
    }
    const pos = await this.broker.position();
    if (pos.stopLoss && pos.stopLoss.eq(dec(trade.stop))) {
      this.store.set("protect_pending", null);
      return;
    }
    this.store.event("critical", "unprotected", `позиція ${trade.side} ${trade.qty} без підтвердженого стопа ${trade.stop}: закриваю через reduceOnly`);
    await this.closeTrade(trade, "protect_close");
  }

  /** Закрити належний боту залишок ринковим reduceOnly і перевірити закриття. */
  async closeTrade(trade: TradeRow, reason: string): Promise<void> {
    const n = this.store.intentsForTrade(trade.id).filter((i) => i.kind === "close").length + 1;
    const link = `${this.cfg.linkPrefix}-x${trade.id}-${n}`;
    const t = await this.feed.ticker();
    this.store.insertIntent({
      link_id: link,
      kind: "close",
      signal_day: trade.signal_day,
      trade_id: trade.id,
      side: trade.side,
      qty: trade.qty,
      stop: null,
      planned_risk: null,
      entry_ref: t.bid.add(t.ask).div(2).toString(),
    });
    this.store.setIntent(link, "pending", { detail: reason });
    await this.send(this.store.intent(link)!);
    await this.settle(link);
    const pos = await this.broker.position();
    if (pos.size.isZero()) {
      await this.syncTrade();
      this.store.set("protect_pending", null);
    } else {
      this.store.event("critical", "close", `після ${link} на біржі лишилось ${pos.side} ${pos.size}; потрібне втручання`);
      this.store.setBlock([...this.store.blockReasons(), `не вдалося закрити позицію (${link})`]);
    }
  }

  /** Якщо біржа закрила позицію (стоп або наш reduceOnly) — записати вихід за фактичними виконаннями. */
  async syncTrade(): Promise<void> {
    const trade = this.store.openTrade();
    if (!trade) return;
    const pos = await this.broker.position();
    const now = this.clock();
    if (pos.size.gt(ZERO)) {
      if (pos.side !== trade.side || !pos.size.eq(dec(trade.qty))) this.reconciled = false;
      if (now - this.lastFundingSync > 600_000) await this.syncFunding(trade, null);
      return;
    }
    const exitSide = exitOrderSide(trade.side);
    const fills = (await this.broker.fillsSince(trade.entry_time)).filter((f) => f.side === exitSide);
    if (!fills.length) {
      if (now - this.exitWaitLogged > 60_000) {
        this.store.event("warn", "exit", `позиція ${trade.side} закрита на біржі, виконань ще немає; повторю`);
        this.exitWaitLogged = now;
      }
      return;
    }
    const exitTime = Math.max(...fills.map((f) => f.time));
    await this.syncFunding(trade, exitTime);
    for (const f of fills) this.saveFill(f, trade.id);
    const closes = this.store.intentsForTrade(trade.id).filter((i) => i.kind === "close");
    const ours = closes.find((i) => fills.some((f) => f.orderLinkId === i.link_id));
    const reason = ours?.detail ?? "stop";
    const qty = sumQty(fills);
    const price = avgPrice(fills);
    const exitFee = sumFee(fills);
    const funding = dec(this.store.trade(trade.id)!.funding);
    const gross = dmin(qty, dec(trade.qty)).mul(price.sub(dec(trade.entry_price))).mul(sideSign(trade.side));
    const net = gross.sub(dec(trade.entry_fee)).sub(exitFee).add(funding);
    this.store.closeTrade(trade.id, {
      exit_price: price.toString(),
      exit_ref: ours?.entry_ref ?? trade.stop,
      exit_time: exitTime,
      exit_fee: exitFee.toString(),
      exit_reason: reason,
      net: net.toString(),
    });
    this.store.set("protect_pending", null);
    if (!qty.eq(dec(trade.qty))) this.store.event("warn", "exit", `виконань виходу ${qty} ≠ позиції ${trade.qty}`);
    this.store.event("info", "exit", `вихід ${trade.side} ${qty} за ${price.toFixed(2)} (${reason}), результат ${net.toFixed(2)} USDT`);
  }

  private async syncFunding(trade: TradeRow, until: number | null) {
    this.lastFundingSync = this.clock();
    for (const f of await this.broker.fundingSince(trade.entry_time)) {
      if (f.ts <= trade.entry_time || (until !== null && f.ts > until)) continue;
      if (this.store.addFunding(trade.id, f.ts, f.amount)) this.store.event("info", "funding", `фандинг ${f.amount.toFixed(4)} USDT`);
    }
  }

  /** Нові завершені денні свічки по черзі. */
  async processDays(now: number): Promise<void> {
    const last = dayStart(now) - DAY_MS;
    const stored = this.store.get("last_day");
    const lastProcessed = stored === null ? null : Number(stored);
    if (lastProcessed !== null && lastProcessed >= last) return;
    const candles = await this.feed.dailyClosed(now, 60);
    // Свічка t ще не з'явилась як завершена — спробуємо на наступному кроці.
    if (!candles.length || candles[candles.length - 1].openTime !== last) return;
    const days = candles.map((c) => c.openTime).filter((d) => (lastProcessed === null ? d === last : d > lastProcessed));
    for (const d of days) {
      const hist = candles.filter((c) => c.openTime <= d);
      const trade = this.store.openTrade();
      if (trade && trade.entry_time < d + DAY_MS) await this.trail(trade, hist);
      const ev = evaluateEntry(hist);
      if (ev.kind === "insufficient") this.store.event("warn", "history", `${isoDay(d)}: сигнал не перевірено (${ev.reason})`);
      if (ev.kind === "signal") {
        const day = isoDay(d);
        this.store.insertSignal({ day, side: ev.side, close: ev.close.toString(), upper: ev.upper.toString(), lower: ev.lower.toString() });
        const row = this.store.signal(day)!;
        if (row.status === "detected") {
          this.store.event("info", "signal", `${day}: сигнал ${ev.side}, Close ${ev.close}, канал ${ev.lower} … ${ev.upper}`);
          if (trade) this.store.setSignal(day, "ignored", "position_open", "сигнал за відкритої позиції");
          else if (this.clock() > d + DAY_MS + this.cfg.entryWindowMs)
            this.store.setSignal(day, "expired", "expired", "вікно входу минуло; позиції заднім числом не відкриваються");
          else await this.enter(row, hist, d);
        }
      }
      this.snapshot(d, hist[hist.length - 1]);
      this.store.set("last_day", String(d));
    }
  }

  private snapshot(d: number, candle: Candle) {
    const trade = this.store.openTrade();
    const unrealized = trade ? dec(trade.qty).mul(candle.close.sub(dec(trade.entry_price))).mul(sideSign(trade.side)) : ZERO;
    this.store.setEquity(isoDay(d), this.store.equity(this.cfg.startBalance).add(unrealized));
  }

  /** Після денного закриття: стоп лише в бік зменшення ризику; якщо новий рівень уже пройдено — закрити. */
  async trail(trade: TradeRow, hist: Candle[]): Promise<void> {
    const raw = channelStop(hist, trade.side);
    if (!raw) {
      this.store.event("warn", "trail", "замало свічок для перерахунку стопа");
      return;
    }
    const spec = await this.instrument();
    const current = dec(trade.stop);
    const next = trailStop(trade.side, current, roundStop(trade.side, raw, spec.tickSize));
    if (next.eq(current)) return;
    if (loosens(trade.side, current, next)) throw new Error("спроба послабити стоп");
    this.store.setStop(trade.id, next.toString());
    this.store.event("info", "trail", `стоп ${current} → ${next}`);
    const t = await this.feed.ticker();
    if (stopReached(trade.side, next, t.last)) {
      this.store.event("warn", "trail", `ціна ${t.last} уже за новим стопом ${next}: закриваю через reduceOnly`);
      await this.closeTrade(this.store.trade(trade.id)!, "trail_close");
    } else await this.protect(trade.id);
  }

  /** Вхід за сигналом: перевірки, розмір, намір у SQLite, ринковий ордер зі стопом, підтвердження за виконаннями. */
  async enter(sig: SignalRow, hist: Candle[], d: number): Promise<void> {
    const { day, side } = sig;
    const skip = (reason: string, message: string) => {
      this.store.setSignal(day, "skipped", reason, message);
      this.store.event("info", "skip", `${day}: вхід пропущено (${reason}): ${message}`);
    };
    const windowEnd = d + DAY_MS + this.cfg.entryWindowMs;
    const blocked = this.store.blockReasons();
    if (blocked.length) return skip("blocked", blocked.join("; "));
    const spec = await this.instrument();
    if (spec.status !== "Trading") return skip("instrument_not_trading", `статус контракту ${spec.status}`);
    const acct = await this.broker.account();
    if (!acct.ok) return skip("preflight", acct.reasons.join("; "));
    const pos = await this.broker.position();
    const foreign = (await this.broker.openOrders()).filter((o) => !this.isOurs(o.orderLinkId));
    if (pos.size.gt(ZERO) || foreign.length) {
      const why = pos.size.gt(ZERO) ? `стороння позиція ${pos.side} ${pos.size}` : `невідомі ордери: ${foreign.map((o) => o.orderId).join(", ")}`;
      this.store.setBlock([...blocked, why]);
      this.store.event("critical", "blocked", `нові входи зупинено: ${why}`);
      return skip("preflight", why);
    }
    const stop = roundStop(side, channelStop(hist, side)!, spec.tickSize);
    const t = await this.feed.ticker();
    if (this.clock() > windowEnd) {
      this.store.setSignal(day, "expired", "expired", "вікно входу минуло під час перевірок");
      return;
    }
    if (stopReached(side, stop, t.last)) return skip("price_beyond_stop", `LastPrice ${t.last} уже за стопом ${stop}`);
    const ref = side === "long" ? t.ask : t.bid;
    const E = adverse(ref, entryOrderSide(side), this.cfg.slippage);
    const X = adverse(stop, exitOrderSide(side), this.cfg.slippage);
    const equity = this.store.realizedEquity(this.cfg.startBalance);
    const size = sizePosition({
      side,
      equity,
      riskFraction: this.cfg.riskFraction,
      entry: E,
      stopExec: X,
      fee: this.cfg.takerFee,
      availableMargin: dmin(equity, acct.available),
      leverage: this.cfg.leverage,
      spec,
    });
    if (!size.ok) return skip(size.reason, size.message);
    const link = this.linkId(day, side);
    // Намір — у SQLite до відправлення. Той самий сигнал дає той самий orderLinkId: другого ордера не буде.
    if (
      !this.store.insertIntent({
        link_id: link,
        kind: "entry",
        signal_day: day,
        trade_id: null,
        side,
        qty: size.qty.toString(),
        stop: stop.toString(),
        planned_risk: size.plannedLoss.toString(),
        entry_ref: t.bid.add(t.ask).div(2).toString(),
      })
    )
      return;
    this.store.setSignal(day, "entering");
    this.store.event("info", "order", `${link}: ${entryOrderSide(side)} ${size.qty} ринком, стоп ${stop}, ризик ${size.plannedLoss.toFixed(2)} USDT`);
    await this.send(this.store.intent(link)!);
    await this.settle(link);
  }
}
