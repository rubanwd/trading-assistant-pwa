import type { Side } from "../shared/risk";
import { DAY_MS, legFunding, planMomentum, signed, turnover, WEEK_MS, weekStart, type MomentumConfig, type MomentumLeg } from "../worker/bots/momentum";
import type { Candle } from "../worker/market/types";
import { bootstrapMeanCi, maxDrawdown } from "./report";

/**
 * Бектест бота «Імпульс між монетами»: ті самі ранжування й частки, що й у рушії (src/worker/bots/momentum.ts).
 * Рішення в понеділок 00:00 UTC бачить лише денні свічки, що закрились до нього. Вхід і вихід — за Open понеділка
 * (рушій перебалансовує о 00:03), з проковзуванням і комісією taker на обіг. Монета, чиї свічки обірвались усередині тижня
 * (делістинг), закривається за останнім закриттям. Фандинг — історичні ставки Binance на кожне нарахування.
 * Капітал бота сталий (1 = 100%): тижневі результати додаються, як R в інших ботів.
 *
 * Список монет на кожен тиждень — topN за обігом у USDT за попередні 30 діб із широкого списку, де є й монети, що потім
 * упали чи зникли (LUNA, FTT): так менше зсуву на користь сьогоднішніх переможців. Рушій бере топ за капіталізацією.
 */

export interface MomentumSeries {
  symbol: string;
  daily: Candle[];
  funding: { at: number; paid: number }[];
}

export interface MomentumBacktestConfig {
  cfg: MomentumConfig;
  takerPct: number;
  slippagePct: number;
  /** Днів обігу для вибору списку монет. */
  volumeDays: number;
}

export interface MomentumBtLeg extends MomentumLeg {
  entry: number;
  exit: number;
  exitAt: number;
  /** Зміна ціни, частка. */
  move: number;
  /** Внесок у результат тижня до комісій, частка капіталу. */
  pnl: number;
  funding: number;
}

export interface MomentumWeek {
  t: number;
  universe: string[];
  legs: MomentumBtLeg[];
  turnover: number;
  /** Частки капіталу. */
  gross: number;
  fee: number;
  funding: number;
  net: number;
  longPnl: number;
  shortPnl: number;
}

function firstIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(arr[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export function simulateMomentum(series: MomentumSeries[], from: number, to: number, bt: MomentumBacktestConfig): MomentumWeek[] {
  const cost = (bt.takerPct + bt.slippagePct) / 100;
  const weeks: MomentumWeek[] = [];
  let drifted = new Map<string, number>();
  for (let t = weekStart(from - 1) + WEEK_MS; t + WEEK_MS <= to; t += WEEK_MS) {
    const t1 = t + WEEK_MS;
    // Монети, що торгуються на момент рішення: є свічка доби перед t і свічка понеділка t.
    const live = series.flatMap((s) => {
      const i = firstIndex(s.daily, (c) => c.openTime >= t);
      const today = s.daily[i];
      const prev = s.daily[i - 1];
      if (!today || today.openTime !== t || !prev || prev.openTime !== t - DAY_MS) return [];
      const hist = s.daily.slice(Math.max(0, i - 400), i);
      const vol = hist.slice(-bt.volumeDays).reduce((sum, c) => sum + c.volume * c.close, 0);
      return [{ s, i, hist, vol }];
    });
    const universe = live.sort((a, b) => b.vol - a.vol).slice(0, bt.cfg.topN);
    const plan = planMomentum(universe.map((u) => ({ symbol: u.s.symbol, daily: u.hist })), bt.cfg);
    const target = new Map(plan.legs.map((l) => [l.symbol, signed(l)]));
    const to_ = turnover(drifted, target);
    const legs: MomentumBtLeg[] = plan.legs.map((l) => {
      const u = universe.find((x) => x.s.symbol === l.symbol)!;
      const d = u.s.daily;
      const entry = d[u.i]!.open;
      const j = firstIndex(d, (c) => c.openTime >= t1);
      // Вихід — Open наступного понеділка; якщо свічки обірвались раніше — останнє закриття.
      const exitCandle = d[j]?.openTime === t1 ? d[j]! : null;
      const exit = exitCandle ? exitCandle.open : d[j - 1]!.close;
      const exitAt = exitCandle ? t1 : d[j - 1]!.closeTime + 1;
      const move = exit / entry - 1;
      const w = signed(l);
      return { ...l, entry, exit, exitAt, move, pnl: w * move, funding: legFunding(w, u.s.funding, t, exitAt) };
    });
    const gross = legs.reduce((s, l) => s + l.pnl, 0);
    const funding = legs.reduce((s, l) => s + l.funding, 0);
    const fee = to_ * cost;
    weeks.push({
      t,
      universe: universe.map((u) => u.s.symbol),
      legs,
      turnover: to_,
      gross,
      fee,
      funding,
      net: gross + funding - fee,
      longPnl: legs.filter((l) => l.side === "long").reduce((s, l) => s + l.pnl + l.funding, 0),
      shortPnl: legs.filter((l) => l.side === "short").reduce((s, l) => s + l.pnl + l.funding, 0),
    });
    // Позиції, переоцінені за цінами виходу. Монета, що зникла, теж тут: комісію за її закриття рахує обіг наступного тижня.
    drifted = new Map(legs.map((l) => [l.symbol, signed(l) * (1 + l.move)]));
  }
  return weeks;
}

export interface MomentumSummary {
  weeks: number;
  /** Тижнів із позиціями. */
  active: number;
  winRate: number | null;
  /** Середній тиждень, % капіталу. */
  avgPct: number | null;
  avgPctCi: [number, number] | null;
  totalPct: number;
  /** Річний коефіцієнт Шарпа за тижневими результатами (без безризикової ставки). */
  sharpe: number | null;
  maxDrawdownPct: number;
  worstWeekPct: number | null;
  bestWeekPct: number | null;
  longPct: number;
  shortPct: number;
  feePct: number;
  fundingPct: number;
  avgTurnover: number | null;
}

const r2 = (v: number) => Number(v.toFixed(2));

export function momentumSummary(weeks: MomentumWeek[]): MomentumSummary {
  const act = weeks.filter((w) => w.legs.length || w.fee);
  const pct = act.map((w) => w.net * 100);
  const n = pct.length;
  const mean = n ? pct.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(pct.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const sum = (f: (w: MomentumWeek) => number) => r2(act.reduce((s, w) => s + f(w), 0) * 100);
  return {
    weeks: weeks.length,
    active: n,
    winRate: n ? Number((pct.filter((x) => x > 0).length / n).toFixed(3)) : null,
    avgPct: n ? Number(mean.toFixed(3)) : null,
    avgPctCi: bootstrapMeanCi(pct),
    totalPct: r2(pct.reduce((s, x) => s + x, 0)),
    sharpe: sd > 0 ? r2((mean / sd) * Math.sqrt(52)) : null,
    maxDrawdownPct: maxDrawdown(pct),
    worstWeekPct: n ? r2(Math.min(...pct)) : null,
    bestWeekPct: n ? r2(Math.max(...pct)) : null,
    longPct: sum((w) => w.longPnl),
    shortPct: sum((w) => w.shortPnl),
    feePct: sum((w) => w.fee),
    fundingPct: sum((w) => w.funding),
    avgTurnover: n ? r2(act.reduce((s, w) => s + w.turnover, 0) / n) : null,
  };
}

const sign = (v: number | null, d = 2) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);

export function formatMomentumLine(name: string, s: MomentumSummary): string {
  const ci = s.avgPctCi ? ` [${s.avgPctCi[0]} … ${s.avgPctCi[1]}]` : "";
  return `  ${name.padEnd(26)} тижнів ${String(s.active).padStart(3)} · у плюсі ${s.winRate === null ? "—" : Math.round(s.winRate * 100) + "%"} · тиждень ${sign(s.avgPct, 3)}${ci} · разом ${sign(s.totalPct, 1)} · Шарп ${s.sharpe ?? "—"} · просадка ${s.maxDrawdownPct}% · лонги ${sign(s.longPct, 1)}, шорти ${sign(s.shortPct, 1)} · комісії −${s.feePct}%, фандинг ${sign(s.fundingPct, 1)}`;
}

export function momentumWeeksCsv(weeks: MomentumWeek[]): string {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const leg = (l: MomentumBtLeg) => `${l.symbol.replace(/USDT$/, "")}:${(l.move * 100).toFixed(1)}`;
  const side = (w: MomentumWeek, s: Side) => w.legs.filter((l) => l.side === s).map(leg).join(" ");
  return (
    [
      "week,net_pct,gross_pct,fee_pct,funding_pct,long_pct,short_pct,turnover,longs,shorts",
      ...weeks.map((w) =>
        [iso(w.t), (w.net * 100).toFixed(3), (w.gross * 100).toFixed(3), (w.fee * 100).toFixed(3), (w.funding * 100).toFixed(3), (w.longPnl * 100).toFixed(3), (w.shortPnl * 100).toFixed(3), w.turnover.toFixed(3), side(w, "long"), side(w, "short")].join(","),
      ),
    ].join("\n") + "\n"
  );
}
