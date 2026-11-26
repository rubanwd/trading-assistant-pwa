import type { Side } from "../shared/risk";
import type { Candle } from "../worker/market/types";
import { fastTrend, rankPicks, resolvePick, shortMarket, type PickStatus, type PickStyle, type ShortMarket } from "../worker/pick";
import { netR } from "../worker/pickStats";
import type { Trend } from "../worker/regime";
import { CANDLE_LIMIT, marketFromSnapshots } from "../worker/scan";
import { buildSnapshot, type Snapshot } from "../worker/snapshot";
import type { SymbolCandles } from "./simulate";

/**
 * Бектест ідеї скану без моделі: щопів години знімки з історичних свічок (без фандингу й відкритого інтересу),
 * той самий бал `rankPicks`, найкращий варіант із входом за ринком (як verdict none) і той самий `resolvePick`.
 * Монета з відкритою ідеєю не береться знову, як у рушії.
 */

const HOUR = 3_600_000;

export interface PickBacktestConfig {
  from: number;
  to: number;
  style: PickStyle;
  horizonHours: number;
  minStopPct: number;
  /** Стоп: таймфрейм і кількість ATR; типово як у рушії для стилю. */
  stop?: { tf: "1h" | "4h"; atr: number };
  /** Крок скану, хв (30 як у рушії). */
  stepMinutes: number;
  makerPct: number;
  takerPct: number;
  leader: string;
}

export interface PickBtTrade {
  createdAt: number;
  symbol: string;
  side: Side;
  score: number;
  status: PickStatus;
  resultR: number | null;
  netR: number | null;
  /** Старший тренд монети (класичний, 1d) і швидкий тренд орієнтира на 1d у момент ідеї: для розбору «проти глобального». */
  coinTrend1d: Trend | null;
  leaderTrend1d: Trend | null;
  /** Ринок «зараз» (1h) і швидкий тренд монети на 1h і 4h у момент ідеї. */
  now: ShortMarket;
  coinFast1h: Trend | null;
  coinFast4h: Trend | null;
}

/** Курсор по свічках: скільки з них закрилось до моменту `t`. Час іде лише вперед. */
class Cursor {
  private i = 0;
  constructor(private readonly candles: Candle[]) {}
  window(t: number, limit = CANDLE_LIMIT): Candle[] {
    while (this.i < this.candles.length && this.candles[this.i]!.closeTime < t) this.i++;
    return this.candles.slice(Math.max(0, this.i - limit), this.i);
  }
}

/** Знімки всіх монет на кожен крок скану, по одному кроку: за роки всі знімки разом не вмістяться в пам'ять. */
export function* pickSnapshots(symbols: SymbolCandles[], from: number, to: number, stepMinutes: number): Generator<{ t: number; snapshots: Snapshot[] }> {
  const cursors = symbols.map((d) => ({ d, c: { "15m": new Cursor(d["15m"]), "1h": new Cursor(d["1h"]), "4h": new Cursor(d["4h"]), "1d": new Cursor(d["1d"]) } }));
  const step = stepMinutes * 60_000;
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    const snapshots: Snapshot[] = [];
    for (const { d, c } of cursors) {
      const candles = { "15m": c["15m"].window(t), "1h": c["1h"].window(t), "4h": c["4h"].window(t), "1d": c["1d"].window(t) };
      // Монета без свіжих свічок (ще не торгувалась або торги зупинені) у скан не йде.
      const lastClose = candles["15m"][candles["15m"].length - 1]?.closeTime ?? 0;
      if (t - lastClose > 30 * 60_000 || candles["1h"].length < 60 || candles["4h"].length < 60 || candles["1d"].length < 2) continue;
      snapshots.push(buildSnapshot({ symbol: d.symbol, now: t, candles, funding: null, openInterest: null }));
    }
    yield { t, snapshots };
  }
}

/**
 * Один прохід по кроках скану для кількох варіантів одразу: знімки рахуються раз на крок.
 * Повертає угоди кожного варіанта в тому ж порядку, що й `configs`.
 */
export function simulatePicks(steps: Iterable<{ t: number; snapshots: Snapshot[] }>, h1: Map<string, Candle[]>, configs: PickBacktestConfig[]): PickBtTrade[][] {
  const runs = configs.map((cfg) => ({ cfg, trades: [] as (PickBtTrade & { resolvedAt: number | null })[], busy: new Map<string, number>() }));
  for (const { t, snapshots } of steps) {
    if (!snapshots.length) continue;
    const market = marketFromSnapshots(snapshots, configs[0]?.leader);
    const now = shortMarket(snapshots, configs[0]?.leader);
    for (const run of runs) {
      const { cfg } = run;
      if (t < cfg.from || t > cfg.to) continue;
      // Монета зайнята, поки її ідея не закрилась свічкою, що закрилась до скану.
      for (const [symbol, until] of run.busy) if (until <= t) run.busy.delete(symbol);
      const [o] = rankPicks(snapshots, market, { minStopPct: cfg.minStopPct, exclude: new Set(run.busy.keys()), leader: cfg.leader, style: cfg.style, stop: cfg.stop, top: 1 });
      if (!o) continue;
      const horizonMs = cfg.horizonHours * HOUR;
      const lv = o.market;
      const res = resolvePick({ side: o.side, entryKind: "market", entry: lv.entry, stop: lv.stop, target: lv.target, createdAt: t, horizonMs }, slice1h(h1.get(o.symbol) ?? [], t, horizonMs), Number.MAX_SAFE_INTEGER);
      run.busy.set(o.symbol, res.resolvedAt ?? Number.MAX_SAFE_INTEGER);
      const snap = snapshots.find((s) => s.symbol === o.symbol)!;
      const lead = snapshots.find((s) => s.symbol === cfg.leader);
      run.trades.push({
        createdAt: t,
        symbol: o.symbol,
        side: o.side,
        score: o.score,
        status: res.status,
        resultR: res.resultR,
        netR: netR({ side: o.side, entry_kind: "market", entry: lv.entry, stop: lv.stop, status: res.status, result_r: res.resultR }, { makerPct: cfg.makerPct, takerPct: cfg.takerPct }),
        coinTrend1d: snap.regime.higherTrend,
        leaderTrend1d: lead ? fastTrend(lead.tf["1d"]) : null,
        now,
        coinFast1h: fastTrend(snap.tf["1h"]),
        coinFast4h: fastTrend(snap.tf["4h"]),
        resolvedAt: res.resolvedAt,
      });
    }
  }
  return runs.map((r) => r.trades.map(({ resolvedAt: _, ...x }) => x));
}

/** Свічки 1h від моменту ідеї до кінця горизонту (з запасом), щоб `resolvePick` не перебирав усю історію. */
function slice1h(candles: Candle[], t: number, horizonMs: number): Candle[] {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.closeTime <= t) lo = mid + 1;
    else hi = mid;
  }
  const end = t + horizonMs;
  let j = lo;
  while (j < candles.length && candles[j]!.openTime < end) j++;
  return candles.slice(lo, j);
}

export interface PickSummary {
  ideas: number;
  closed: number;
  wins: number;
  winRate: number | null;
  avgR: number | null;
  totalR: number;
  maxDrawdownR: number;
  longs: number;
  longAvgR: number | null;
  shorts: number;
  shortAvgR: number | null;
}

export function pickSummary(trades: PickBtTrade[]): PickSummary {
  const closed = trades.filter((x) => x.netR !== null);
  const wins = closed.filter((x) => x.status === "target" || (x.status === "expired" && (x.resultR ?? 0) > 0)).length;
  const total = closed.reduce((s, x) => s + x.netR!, 0);
  let peak = 0;
  let eq = 0;
  let dd = 0;
  for (const x of closed) {
    eq += x.netR!;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const avg = (xs: PickBtTrade[]) => (xs.length ? Number((xs.reduce((s, x) => s + x.netR!, 0) / xs.length).toFixed(3)) : null);
  const longs = closed.filter((x) => x.side === "long");
  const shorts = closed.filter((x) => x.side === "short");
  return {
    ideas: trades.length,
    closed: closed.length,
    wins,
    winRate: closed.length ? Number((wins / closed.length).toFixed(3)) : null,
    avgR: avg(closed),
    totalR: Number(total.toFixed(2)),
    maxDrawdownR: Number(dd.toFixed(2)),
    longs: longs.length,
    longAvgR: avg(longs),
    shorts: shorts.length,
    shortAvgR: avg(shorts),
  };
}

/** Підсумок за місяцями (YYYY-MM UTC): середнє R після комісій і частка лонгів. */
export function pickByMonth(trades: PickBtTrade[]): { month: string; n: number; avgR: number; longShare: number }[] {
  const groups = new Map<string, PickBtTrade[]>();
  for (const x of trades) {
    if (x.netR === null) continue;
    const m = new Date(x.createdAt).toISOString().slice(0, 7);
    groups.set(m, [...(groups.get(m) ?? []), x]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, xs]) => ({
      month,
      n: xs.length,
      avgR: Number((xs.reduce((s, x) => s + x.netR!, 0) / xs.length).toFixed(3)),
      longShare: Number((xs.filter((x) => x.side === "long").length / xs.length).toFixed(2)),
    }));
}
