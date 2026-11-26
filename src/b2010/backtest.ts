/**
 * Чесний бектест пробою 20/10 на денних свічках Bybit. Ті самі evaluateEntry, channelStop, trailStop і sizePosition,
 * що й у paper/testnet/live. Порядок подій без підглядання:
 *   1) старт доби i: вхід за сигналом зі свічки i-1 за Open[i] з прослизанням (рішення бачить лише свічки до i-1);
 *   2) протягом доби i: стоп, чинний на її початок (зокрема в день входу), і фандинг;
 *   3) закриття доби i: новий стоп за 10 днями до i включно — діє лише з доби i+1; сигнал на свічці i.
 */
import { adverse, sizePosition, type SkipReason } from "./sizing";
import { dec, ZERO, type Dec } from "./decimal";
import { channelStop, consecutive, DAY_MS, evaluateEntry, HOUR_MS, isoDay, roundStop, stopReached, trailStop } from "./strategy";
import { entryOrderSide, exitOrderSide, sideSign, type Candle, type FundingRate, type InstrumentSpec, type Side } from "./types";

export interface BacktestConfig {
  /** Перша доба роботи бота (початок доби UTC, мс). */
  from: number;
  /** Остання доба (включно). */
  to: number;
  balance: Dec;
  riskFraction: Dec;
  takerFee: Dec;
  slippage: Dec;
  leverage: Dec;
  /** Обмеження ордера. Датованих значень API не дає: застосовуються сьогоднішні. */
  spec: InstrumentSpec;
  /** Комісія споту для порівняння з купівлею BTC. */
  spotFee: Dec;
}

export interface BacktestInput {
  daily: Candle[];
  hourly: Candle[];
  markHourly: Candle[];
  funding: FundingRate[];
  spotDaily: Candle[];
}

export type ExitReason = "stop" | "gap_stop";

export interface BtTrade {
  id: number;
  side: Side;
  signalDay: number;
  entryTime: number;
  entryBase: Dec;
  entryPrice: Dec;
  qty: Dec;
  initialStop: Dec;
  stop: Dec;
  plannedRisk: Dec;
  entryFee: Dec;
  exitFee: Dec;
  funding: Dec;
  slippage: Dec;
  exitTime: number | null;
  exitBase: Dec | null;
  exitPrice: Dec | null;
  exitReason: ExitReason | null;
  /** Ціновий результат від базових цін (без прослизання, комісій і фандингу). */
  priceResult: Dec;
  /** Чистий результат: ціновий − прослизання − комісії + фандинг. */
  net: Dec;
}

export type SignalStatus = "entered" | "skipped" | "ignored";
export type BtSkipReason = SkipReason | "price_beyond_stop" | "period_end" | "position_open";

export interface BtSignal {
  day: number;
  side: Side;
  close: Dec;
  upper: Dec;
  lower: Dec;
  status: SignalStatus;
  reason?: BtSkipReason;
  message?: string;
}

export interface BtFunding {
  ts: number;
  tradeId: number;
  rate: Dec;
  mark: Dec;
  markSource: "mark" | "trade" | "daily";
  /** Грошовий потік для бота: від'ємний — сплачено. */
  amount: Dec;
  /** Годинні свічки не дали визначити, що було раніше: стоп чи нарахування. */
  ambiguous: boolean;
  /** Чи враховано (за неоднозначності — лише якщо це витрата). */
  applied: boolean;
}

export interface EquityPoint {
  day: number;
  equity: Dec;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: BtTrade[];
  signals: BtSignal[];
  equity: EquityPoint[];
  funding: BtFunding[];
  /** Позиція, відкрита на кінець тесту, з нереалізованим результатом за Close останньої доби. */
  open: (BtTrade & { lastClose: Dec; unrealized: Dec }) | null;
  /** Доби зі стопом, для яких немає годинних свічок: увесь фандинг доби вважався неоднозначним. */
  hourlyMissingDays: number[];
  spot: { qty: Dec; buyPrice: Dec; endPrice: Dec; end: Dec; source: "spot" | "perp" } | null;
  warnings: string[];
}

export class DataGapError extends Error {}

const byOpenTime = (candles: Candle[]) => new Map(candles.map((c) => [c.openTime, c]));

export function runBacktest(input: BacktestInput, cfg: BacktestConfig): BacktestResult {
  const { daily } = input;
  const index = new Map(daily.map((c, i) => [c.openTime, i]));
  const iFrom = index.get(cfg.from);
  const iTo = index.get(cfg.to);
  if (iFrom === undefined) throw new DataGapError(`немає денної свічки на ${isoDay(cfg.from)}`);
  if (iTo === undefined) throw new DataGapError(`немає денної свічки на ${isoDay(cfg.to)}`);
  if (iFrom < 20) throw new DataGapError(`для розігріву каналу потрібно 20 свічок до ${isoDay(cfg.from)}, є ${iFrom}`);
  if (!consecutive(daily.slice(iFrom - 20, iTo + 1))) throw new DataGapError("пропуск у денних свічках у періоді тесту");

  const hourly = byOpenTime(input.hourly);
  const mark = byOpenTime(input.markHourly);
  const fundingByDay = new Map<number, FundingRate[]>();
  for (const f of input.funding) {
    const d = Math.floor(f.ts / DAY_MS) * DAY_MS;
    if (!fundingByDay.has(d)) fundingByDay.set(d, []);
    fundingByDay.get(d)!.push(f);
  }

  const { takerFee: fee, slippage: slip } = cfg;
  const trades: BtTrade[] = [];
  const signals: BtSignal[] = [];
  const equity: EquityPoint[] = [];
  const fundingLog: BtFunding[] = [];
  const hourlyMissingDays: number[] = [];
  const warnings: string[] = [];
  let cash = cfg.balance;
  let pos: BtTrade | null = null;
  let pending: BtSignal | null = null;

  const markAt = (ts: number, day: Candle): { price: Dec; source: BtFunding["markSource"] } => {
    const m = mark.get(ts);
    if (m) return { price: m.open, source: "mark" };
    const h = hourly.get(ts);
    if (h) return { price: h.open, source: "trade" };
    return { price: day.open, source: "daily" };
  };

  const applyFunding = (p: BtTrade, f: FundingRate, day: Candle, ambiguous: boolean) => {
    const m = markAt(f.ts, day);
    // Додатна ставка: лонг платить, шорт отримує.
    const amount = p.qty.mul(m.price).mul(f.rate).mul(-sideSign(p.side));
    const applied = !ambiguous || amount.lt(ZERO);
    fundingLog.push({ ts: f.ts, tradeId: p.id, rate: f.rate, mark: m.price, markSource: m.source, amount, ambiguous, applied });
    if (applied) {
      p.funding = p.funding.add(amount);
      cash = cash.add(amount);
    }
  };

  for (let i = iFrom; i <= iTo; i++) {
    const c = daily[i];
    const T = c.openTime;

    // 1) Вхід на старті доби за сигналом зі свічки i-1.
    if (pending && !pos) {
      const sig: BtSignal = pending;
      pending = null;
      const side = sig.side;
      const raw = channelStop(daily.slice(i - 10, i), side)!;
      const stop = roundStop(side, raw, cfg.spec.tickSize);
      const base = c.open;
      if (stopReached(side, stop, base)) {
        sig.status = "skipped";
        sig.reason = "price_beyond_stop";
        sig.message = `Open ${base} уже за стопом ${stop}`;
      } else {
        const E = adverse(base, entryOrderSide(side), slip);
        const X = adverse(stop, exitOrderSide(side), slip);
        const size = sizePosition({ side, equity: cash, riskFraction: cfg.riskFraction, entry: E, stopExec: X, fee, availableMargin: cash, leverage: cfg.leverage, spec: cfg.spec });
        if (!size.ok) {
          sig.status = "skipped";
          sig.reason = size.reason;
          sig.message = size.message;
        } else {
          const entryFee = size.qty.mul(E).mul(fee);
          cash = cash.sub(entryFee);
          sig.status = "entered";
          pos = {
            id: trades.length + 1,
            side,
            signalDay: sig.day,
            entryTime: T,
            entryBase: base,
            entryPrice: E,
            qty: size.qty,
            initialStop: stop,
            stop,
            plannedRisk: size.plannedLoss,
            entryFee,
            exitFee: ZERO,
            funding: ZERO,
            slippage: size.qty.mul(E.sub(base).abs()),
            exitTime: null,
            exitBase: null,
            exitPrice: null,
            exitReason: null,
            priceResult: ZERO,
            net: ZERO,
          };
          trades.push(pos);
        }
      }
    }

    // 2) Протягом доби: стоп, чинний на її початок, і фандинг.
    if (pos) {
      const p: BtTrade = pos;
      const dayFunding = (fundingByDay.get(T) ?? []).filter((f) => f.ts > p.entryTime);
      const hit = p.side === "long" ? c.low.lte(p.stop) : c.high.gte(p.stop);
      if (hit) {
        const gap = stopReached(p.side, p.stop, c.open);
        const exitBase = gap ? c.open : p.stop;
        // Година, у якій ціна дійшла до стопа: фандинг до неї нараховано, після — ні, всередині — неоднозначно.
        let hitHour: number | null = null;
        for (let h = T; h < T + DAY_MS; h += HOUR_MS) {
          const hc = hourly.get(h);
          if (!hc) continue;
          if (p.side === "long" ? hc.low.lte(p.stop) : hc.high.gte(p.stop)) {
            hitHour = h;
            break;
          }
        }
        if (hitHour === null && dayFunding.length) hourlyMissingDays.push(T);
        for (const f of dayFunding) {
          if (hitHour === null) applyFunding(p, f, c, true);
          else if (f.ts < hitHour) applyFunding(p, f, c, false);
          else if (f.ts < hitHour + HOUR_MS) applyFunding(p, f, c, true);
        }
        const exitPrice = adverse(exitBase, exitOrderSide(p.side), slip);
        const exitFee = p.qty.mul(exitPrice).mul(fee);
        const sign = sideSign(p.side);
        const gross = p.qty.mul(exitPrice.sub(p.entryPrice)).mul(sign);
        cash = cash.add(gross).sub(exitFee);
        p.exitTime = hitHour ?? T;
        p.exitBase = exitBase;
        p.exitPrice = exitPrice;
        p.exitReason = gap ? "gap_stop" : "stop";
        p.exitFee = exitFee;
        p.slippage = p.slippage.add(p.qty.mul(exitPrice.sub(exitBase).abs()));
        p.priceResult = p.qty.mul(exitBase.sub(p.entryBase)).mul(sign);
        p.net = gross.sub(p.entryFee).sub(exitFee).add(p.funding);
        pos = null;
      } else {
        for (const f of dayFunding) applyFunding(p, f, c, false);
      }
    }

    // 3) Закриття доби: перерахунок стопа (діє з наступної доби), equity, сигнал.
    if (pos) {
      const raw = channelStop(daily.slice(i - 9, i + 1), pos.side)!;
      pos.stop = trailStop(pos.side, pos.stop, roundStop(pos.side, raw, cfg.spec.tickSize));
    }
    const unrealized = pos ? pos.qty.mul(c.close.sub(pos.entryPrice)).mul(sideSign(pos.side)) : ZERO;
    equity.push({ day: T, equity: cash.add(unrealized) });

    const ev = evaluateEntry(daily.slice(i - 20, i + 1));
    if (ev.kind === "signal") {
      const sig: BtSignal = { day: T, side: ev.side, close: ev.close, upper: ev.upper, lower: ev.lower, status: "skipped" };
      signals.push(sig);
      if (pos) {
        sig.status = "ignored";
        sig.reason = "position_open";
      } else if (i === iTo) {
        sig.reason = "period_end";
        sig.message = "вхід припав би на добу після кінця тесту";
      } else pending = sig;
    }
  }

  let open: BacktestResult["open"] = null;
  if (pos) {
    const lastClose = daily[iTo].close;
    const unrealized = pos.qty.mul(lastClose.sub(pos.entryPrice)).mul(sideSign(pos.side));
    open = { ...pos, lastClose, unrealized };
  }

  // Купівля BTC на споті на старті з тим самим капіталом.
  let spot: BacktestResult["spot"] = null;
  const spotMap = byOpenTime(input.spotDaily);
  let source: "spot" | "perp" = "spot";
  let first = spotMap.get(cfg.from);
  let last = spotMap.get(cfg.to);
  if (!first || !last) {
    source = "perp";
    first = daily[iFrom];
    last = daily[iTo];
    warnings.push("немає денних свічок споту на межах періоду: купівлю BTC оцінено за цінами безстрокового контракту");
  }
  const buyPrice = adverse(first.open, "Buy", slip);
  const qty = cfg.balance.mul(dec(1).sub(cfg.spotFee)).div(buyPrice);
  spot = { qty, buyPrice, endPrice: last.close, end: qty.mul(last.close), source };

  return { config: cfg, trades, signals, equity, funding: fundingLog, open, hourlyMissingDays, spot, warnings };
}
