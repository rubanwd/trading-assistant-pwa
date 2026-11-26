import type { Side } from "../shared/risk";
import type { Candle } from "../worker/market/types";
import { fastTrend, rankPicks, resolvePick, shortMarket, type PickStatus, type PickStyle, type ShortMarket } from "../worker/pick";
import { netR } from "../worker/pickStats";
import { atr, percentileOfLast } from "../worker/indicators";
import { trend, type MarketRegime, type Trend } from "../worker/regime";
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
  /** Фільтр імпульсу, як `pick_min_rsi_1h` у рушії; 0 або без нього — вимкнено. */
  minRsi1h?: number;
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
  /** Ознаки для розбору: числа з боку угоди (плюс — на користь угоди). */
  f: Record<string, number | string | null>;
  /** Той самий варіант із лімітним входом на відкаті: null, якщо лімітки немає або вона не виконалась. */
  pullbackNetR: number | null;
  pullbackStatus: PickStatus | null;
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

export interface PickStep {
  t: number;
  snapshots: Snapshot[];
  /** Місце ATR% 4h серед останніх 480 свічок 4h (80 днів), 0..1. */
  atrRank4h?: Map<string, number | null>;
}

/** Знімки всіх монет на кожен крок скану, по одному кроку: за роки всі знімки разом не вмістяться в пам'ять. */
export function* pickSnapshots(symbols: SymbolCandles[], from: number, to: number, stepMinutes: number): Generator<PickStep> {
  const cursors = symbols.map((d) => ({ d, c: { "15m": new Cursor(d["15m"]), "1h": new Cursor(d["1h"]), "4h": new Cursor(d["4h"]), "1d": new Cursor(d["1d"]) } }));
  const step = stepMinutes * 60_000;
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    const snapshots: Snapshot[] = [];
    const atrRank4h = new Map<string, number | null>();
    for (const { d, c } of cursors) {
      const candles = { "15m": c["15m"].window(t), "1h": c["1h"].window(t), "4h": c["4h"].window(t), "1d": c["1d"].window(t) };
      // Монета без свіжих свічок (ще не торгувалась або торги зупинені) у скан не йде.
      const lastClose = candles["15m"][candles["15m"].length - 1]?.closeTime ?? 0;
      if (t - lastClose > 30 * 60_000 || candles["1h"].length < 60 || candles["4h"].length < 60 || candles["1d"].length < 2) continue;
      snapshots.push(buildSnapshot({ symbol: d.symbol, now: t, candles, funding: null, openInterest: null }));
      const h4 = candles["4h"];
      atrRank4h.set(d.symbol, percentileOfLast(atr(h4, 14).map((a, i) => a / h4[i]!.close), 480));
    }
    yield { t, snapshots, atrRank4h };
  }
}

/**
 * Один прохід по кроках скану для кількох варіантів одразу: знімки рахуються раз на крок.
 * Повертає угоди кожного варіанта в тому ж порядку, що й `configs`.
 */
export function simulatePicks(steps: Iterable<PickStep>, h1: Map<string, Candle[]>, configs: PickBacktestConfig[]): PickBtTrade[][] {
  const runs = configs.map((cfg) => ({ cfg, trades: [] as (PickBtTrade & { resolvedAt: number | null })[], busy: new Map<string, number>() }));
  for (const { t, snapshots, atrRank4h } of steps) {
    if (!snapshots.length) continue;
    const market = marketFromSnapshots(snapshots, configs[0]?.leader);
    const now = shortMarket(snapshots, configs[0]?.leader);
    for (const run of runs) {
      const { cfg } = run;
      if (t < cfg.from || t > cfg.to) continue;
      // Монета зайнята, поки її ідея не закрилась свічкою, що закрилась до скану.
      for (const [symbol, until] of run.busy) if (until <= t) run.busy.delete(symbol);
      const [o] = rankPicks(snapshots, market, { minStopPct: cfg.minStopPct, exclude: new Set(run.busy.keys()), leader: cfg.leader, style: cfg.style, stop: cfg.stop, minRsi1h: cfg.minRsi1h, top: 1 });
      if (!o) continue;
      const horizonMs = cfg.horizonHours * HOUR;
      const lv = o.market;
      const res = resolvePick({ side: o.side, entryKind: "market", entry: lv.entry, stop: lv.stop, target: lv.target, createdAt: t, horizonMs }, slice1h(h1.get(o.symbol) ?? [], t, horizonMs), Number.MAX_SAFE_INTEGER);
      run.busy.set(o.symbol, res.resolvedAt ?? Number.MAX_SAFE_INTEGER);
      const snap = snapshots.find((s) => s.symbol === o.symbol)!;
      const lead = snapshots.find((s) => s.symbol === cfg.leader);
      const fees = { makerPct: cfg.makerPct, takerPct: cfg.takerPct };
      let pullbackNetR: number | null = null;
      let pullbackStatus: PickStatus | null = null;
      if (o.pullback) {
        const p = o.pullback;
        const pr = resolvePick({ side: o.side, entryKind: "pullback", entry: p.entry, stop: p.stop, target: p.target, createdAt: t, horizonMs }, slice1h(h1.get(o.symbol) ?? [], t, horizonMs), Number.MAX_SAFE_INTEGER);
        pullbackStatus = pr.status;
        pullbackNetR = netR({ side: o.side, entry_kind: "pullback", entry: p.entry, stop: p.stop, status: pr.status, result_r: pr.resultR }, fees);
      }
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
        f: features(snap, o.side, o.roomAtr, market, now, lead ?? null, atrRank4h?.get(o.symbol) ?? null, t),
        pullbackNetR,
        pullbackStatus,
        resolvedAt: res.resolvedAt,
      });
    }
  }
  return runs.map((r) => r.trades.map(({ resolvedAt: _, ...x }) => x));
}

/** Ознаки ідеї для розбору, з боку угоди: тренд «with»/«against»/«range», числа з плюсом на користь угоди. */
function features(s: Snapshot, side: Side, roomAtr: number | null, market: MarketRegime, now: ShortMarket, lead: Snapshot | null, atrRank4h: number | null, t: number) {
  const dir = side === "long" ? 1 : -1;
  const rel = (x: Trend | null) => (x === null ? null : x === "range" ? "range" : (x === "up") === (side === "long") ? "with" : "against");
  const moodRel = (m: MarketRegime["mood"]) => (m === "mixed" ? "mixed" : (m === "risk_on") === (side === "long") ? "with" : "against");
  const ext = (tf: "1h" | "4h") => {
    const f = s.tf[tf];
    return f.atr14 && f.ema20 !== null ? Number((((s.price - f.ema20) / f.atr14) * dir).toFixed(2)) : null;
  };
  const rsi = (tf: "1h" | "4h") => (s.tf[tf].rsi14 === null ? null : side === "long" ? s.tf[tf].rsi14 : 100 - s.tf[tf].rsi14!);
  const d = new Date(t);
  return {
    mood: moodRel(market.mood),
    btc4h: s.symbol === lead?.symbol ? null : rel(market.btcTrend),
    breadth4h: market.breadth === null ? null : Number(((side === "long" ? market.breadth : 1 - market.breadth)).toFixed(2)),
    trend1d: rel(s.regime.higherTrend),
    trend4h: rel(s.regime.trend),
    trend1h: rel(trend(s.tf["1h"])),
    fast1h: rel(fastTrend(s.tf["1h"])),
    fast15m: rel(fastTrend(s.tf["15m"])),
    moodNow: moodRel(now.mood),
    btcFast1h: rel(now.leaderTrend1h),
    breadthNow: now.breadth === null ? null : Number((side === "long" ? now.breadth : 1 - now.breadth).toFixed(2)),
    rsi4h: rsi("4h"),
    rsi1h: rsi("1h"),
    ext4h: ext("4h"),
    ext1h: ext("1h"),
    vol1h: s.regime.volatility,
    atrRank4h: atrRank4h === null ? null : Number(atrRank4h.toFixed(2)),
    atrPct4h: s.tf["4h"].atrPct,
    roomAtr,
    ch1d: s.tf["1d"].changePct === null ? null : Number((s.tf["1d"].changePct * dir).toFixed(2)),
    ch4h: s.tf["4h"].changePct === null ? null : Number((s.tf["4h"].changePct * dir).toFixed(2)),
    vol4h: s.tf["4h"].volumeRatio,
    hour: d.getUTCHours(),
    weekday: d.getUTCDay(),
  };
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
