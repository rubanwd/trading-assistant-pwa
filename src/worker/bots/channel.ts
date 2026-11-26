import type { ChannelConfig } from "../../shared/bots";
import { feeR, type Fees, type Side } from "../../shared/risk";
import type { Candle } from "../market/types";

/**
 * Бот Channel 20/10: денний пробій каналу. Чисті функції: їх викликають і рушій (паперова торгівля щогодини), і бектест.
 *
 * t — денна свічка UTC, що щойно закрилась. upper/lower — найбільший High і найменший Low свічок t-20…t-1 (t не входить).
 * Close[t] > upper — лонг, Close[t] < lower — шорт; рівність, дотик і пробій лише тінню входу не дають. Вхід за ринком —
 * за першою ціною після закриття. Стоп — найменший Low (лонг) / найбільший High (шорт) свічок t-9…t, далі після кожного
 * денного закриття лише в бік зменшення ризику. Тейка немає: позиція живе, поки ціна не дійде до стопа. Одна позиція.
 */

export const DAY_MS = 86_400_000;

export const dayStart = (ts: number) => Math.floor(ts / DAY_MS) * DAY_MS;

/** Чи йдуть денні свічки підряд без пропусків. */
export function consecutiveDays(candles: Candle[]): boolean {
  for (let i = 1; i < candles.length; i++) if (candles[i]!.openTime - candles[i - 1]!.openTime !== DAY_MS) return false;
  return true;
}

export interface ChannelSignal {
  /** Початок доби t, мс UTC. */
  day: number;
  side: Side | null;
  close: number;
  upper: number;
  lower: number;
}

/**
 * Сигнал на останній свічці daily (вона — t). null, якщо немає entryDays + 1 послідовних завершених свічок.
 * side = null — пробою немає.
 */
export function channelSignal(daily: Candle[], entryDays: number): ChannelSignal | null {
  if (daily.length < entryDays + 1) return null;
  const window = daily.slice(-(entryDays + 1));
  if (!consecutiveDays(window)) return null;
  const t = window[entryDays]!;
  let upper = -Infinity;
  let lower = Infinity;
  for (const c of window.slice(0, entryDays)) {
    upper = Math.max(upper, c.high);
    lower = Math.min(lower, c.low);
  }
  const side: Side | null = t.close > upper ? "long" : t.close < lower ? "short" : null;
  return { day: t.openTime, side, close: t.close, upper, lower };
}

/** Рівень каналу стопа з останніх exitDays завершених свічок. null — свічок замало або є пропуск. */
export function channelStop(daily: Candle[], side: Side, exitDays: number): number | null {
  if (daily.length < exitDays) return null;
  const window = daily.slice(-exitDays);
  if (!consecutiveDays(window)) return null;
  return side === "long" ? Math.min(...window.map((c) => c.low)) : Math.max(...window.map((c) => c.high));
}

/** Стоп рухається лише в бік зменшення ризику: лонг — max, шорт — min. */
export const trailStop = (side: Side, current: number, candidate: number) => (side === "long" ? Math.max(current, candidate) : Math.min(current, candidate));

/** Ціна вже дійшла до стопа або за нього: лонг — ≤, шорт — ≥. */
export const stopReached = (side: Side, stop: number, price: number) => (side === "long" ? price <= stop : price >= stop);

/**
 * Вихід у свічці проти чинного стопа: якщо свічка відкрилась за стопом (геп) — за її Open, якщо ціна дійшла до стопа
 * всередині — за стопом. null — стоп не зачеплено.
 */
export function candleExit(side: Side, stop: number, c: Candle): { price: number; gap: boolean } | null {
  if (stopReached(side, stop, c.open)) return { price: c.open, gap: true };
  if (side === "long" ? c.low <= stop : c.high >= stop) return { price: stop, gap: false };
  return null;
}

// ── Супровід позиції ───────────────────────────────────────────────────────

/** Стан відкритої позиції між запусками. */
export interface ChannelTrack {
  side: Side;
  entry: number;
  /** Стоп на момент входу: від нього рахується 1R. */
  initialStop: number;
  /** Чинний стоп. */
  stop: number;
  /** Ціни до цього моменту (мс UTC) уже перевірено проти стопа. */
  checkedTo: number;
  /** Початок останньої денної свічки, чиє закриття вже враховано в стопі. */
  trailedTo: number;
}

export interface ChannelExit {
  price: number;
  /** Свічка, у якій спрацював стоп: точніше за неї час виходу невідомий. */
  from: number;
  to: number;
  gap: boolean;
  /** Стоп перевірено лише за денною свічкою (дрібніших свічок за той час уже немає). */
  daily: boolean;
}

export interface ChannelAdvance {
  track: ChannelTrack;
  exit: ChannelExit | null;
  /** Перерахунки стопа: доба (початок свічки) і новий рівень. */
  trailed: { day: number; stop: number }[];
}

/**
 * Довести позицію до моменту now. Ціни перевіряються по черзі за дрібнішими свічками (intraday: 15m у рушії, 1h у бектесті);
 * перед кожною свічкою враховуються закриття діб, що завершились раніше за її початок, — новий стоп не діє на ціни
 * тієї самої доби. Проміжок, для якого дрібніших свічок уже немає, перевіряється денними свічками (консервативно:
 * денна свічка, частину якої вже перевірено, теж може дати вихід). Свічки — лише завершені, від старих до нових.
 */
export function advanceChannel(track: ChannelTrack, daily: Candle[], intraday: Candle[], now: number, exitDays: number): ChannelAdvance {
  const t = { ...track };
  const trailed: ChannelAdvance["trailed"] = [];
  let di = lowerBound(daily, (c) => c.openTime > t.trailedTo);
  /** Врахувати закриття діб, що завершились до моменту upTo. */
  const trailUntil = (upTo: number) => {
    while (di < daily.length && daily[di]!.closeTime < upTo) {
      const level = channelStop(daily.slice(0, di + 1), t.side, exitDays);
      if (level !== null) {
        const next = trailStop(t.side, t.stop, level);
        if (next !== t.stop) trailed.push({ day: daily[di]!.openTime, stop: next });
        t.stop = next;
      }
      t.trailedTo = daily[di]!.openTime;
      di++;
    }
  };
  const done = (c: Candle, x: { price: number; gap: boolean }, isDaily: boolean): ChannelAdvance => {
    t.checkedTo = c.closeTime + 1;
    return { track: t, exit: { price: x.price, from: c.openTime, to: c.closeTime, gap: x.gap, daily: isDaily }, trailed };
  };
  let ii = lowerBound(intraday, (c) => c.openTime >= t.checkedTo);
  const firstIntra = intraday[ii]?.openTime ?? Infinity;
  // Діра без дрібніших свічок (рушій довго не працював, у бектесті — пропуск в архіві) — денними свічками.
  if (firstIntra > t.checkedTo) {
    for (let k = lowerBound(daily, (c) => c.closeTime >= t.checkedTo); k < daily.length; k++) {
      const d = daily[k]!;
      if (d.openTime >= firstIntra || d.closeTime >= now) break;
      trailUntil(d.openTime);
      const x = candleExit(t.side, t.stop, d);
      if (x) return done(d, x, true);
      t.checkedTo = d.closeTime + 1;
    }
  }
  ii = lowerBound(intraday, (c) => c.openTime >= t.checkedTo);
  for (; ii < intraday.length; ii++) {
    const c = intraday[ii]!;
    if (c.closeTime >= now) break;
    trailUntil(c.openTime);
    const x = candleExit(t.side, t.stop, c);
    if (x) return done(c, x, false);
    t.checkedTo = c.closeTime + 1;
  }
  trailUntil(now);
  return { track: t, exit: null, trailed };
}

/** Перший індекс, де pred істинний (масив упорядковано так, що pred монотонний). */
function lowerBound<T>(arr: T[], pred: (x: T) => boolean): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(arr[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ── Вхід ───────────────────────────────────────────────────────────────────

export type ChannelFill =
  | { status: "open"; filledAt: number; entry: number }
  | { status: "cancelled"; reason: "beyond_stop" | "no_price"; at: number; price: number | null }
  | { status: "pending" };

/**
 * Паперовий вхід за ринком: Open першої дрібнішої свічки, що почалась не раніше моменту постановки.
 * Якщо ціна вже за стопом — вхід пропускається. Немає ціни до expiresAt — ордер знімається.
 */
export function fillChannel(o: { side: Side; stop: number; placedAt: number; expiresAt: number }, intraday: Candle[], now: number): ChannelFill {
  const c = intraday[lowerBound(intraday, (x) => x.openTime >= o.placedAt)];
  if (c && c.openTime < o.expiresAt) {
    if (stopReached(o.side, o.stop, c.open)) return { status: "cancelled", reason: "beyond_stop", at: c.openTime, price: c.open };
    return { status: "open", filledAt: c.openTime, entry: c.open };
  }
  return now >= o.expiresAt ? { status: "cancelled", reason: "no_price", at: o.expiresAt, price: null } : { status: "pending" };
}

/** Початковий стан супроводу після входу: стоп каналу на свічці сигналу вже враховано. */
export const openTrack = (side: Side, entry: number, stop: number, filledAt: number, signalDay: number): ChannelTrack => ({
  side,
  entry,
  initialStop: stop,
  stop,
  checkedTo: filledAt,
  trailedTo: signalDay,
});

/** Результат у R до комісій: від стопа на момент входу. */
export function channelR(track: Pick<ChannelTrack, "side" | "entry" | "initialStop">, price: number): number {
  const risk = Math.abs(track.entry - track.initialStop);
  return risk === 0 ? 0 : Number((((price - track.entry) / risk) * (track.side === "long" ? 1 : -1)).toFixed(3));
}

/** Комісії в R: вхід і вихід за ринком (taker). */
export const channelFeeR = (track: Pick<ChannelTrack, "entry" | "initialStop">, exitPrice: number, fees: Fees) =>
  feeR({ price: track.entry, kind: "taker" }, track.initialStop, [{ price: exitPrice, share: 1, kind: "taker" }], fees);

// ── Фандинг ────────────────────────────────────────────────────────────────

export interface FundingEvent {
  at: number;
  rate: number;
}

export interface ChannelFunding {
  /** Грошовий потік у R: від'ємний — сплачено. */
  r: number;
  events: number;
  /** Нарахування в свічці виходу: невідомо, що було раніше, стоп чи нарахування; враховано лише як витрату. */
  ambiguous: number;
}

/**
 * Фандинг за час позиції в R. Додатна ставка: лонг платить, шорт отримує. Вартість позиції на 1 одиницю — ціна
 * в момент нарахування (priceAt). Нарахування в момент входу не належить позиції (вхід після нього).
 */
export function channelFunding(
  track: Pick<ChannelTrack, "side" | "entry" | "initialStop">,
  events: FundingEvent[],
  filledAt: number,
  exit: Pick<ChannelExit, "from" | "to"> | null,
  until: number,
  priceAt: (at: number) => number,
): ChannelFunding {
  const risk = Math.abs(track.entry - track.initialStop);
  const dir = track.side === "long" ? 1 : -1;
  let r = 0;
  let n = 0;
  let ambiguous = 0;
  if (risk === 0) return { r: 0, events: 0, ambiguous: 0 };
  for (const e of events) {
    if (e.at <= filledAt) continue;
    if (exit ? e.at > exit.to : e.at > until) continue;
    const flow = (-dir * e.rate * priceAt(e.at)) / risk;
    if (exit && e.at >= exit.from) {
      ambiguous++;
      if (flow >= 0) continue;
    }
    r += flow;
    n++;
  }
  return { r: Number(r.toFixed(4)), events: n, ambiguous };
}

/** Межі каналу на наступне закриття: попередні entryDays діб до сьогоднішньої включно і стоп, якби вхід був зараз. */
export function nextLevels(daily: Candle[], cfg: Pick<ChannelConfig, "entryDays" | "exitDays">) {
  const w = daily.slice(-cfg.entryDays);
  if (w.length < cfg.entryDays) return null;
  return {
    upper: Math.max(...w.map((c) => c.high)),
    lower: Math.min(...w.map((c) => c.low)),
    longStop: channelStop(daily, "long", cfg.exitDays),
    shortStop: channelStop(daily, "short", cfg.exitDays),
  };
}
