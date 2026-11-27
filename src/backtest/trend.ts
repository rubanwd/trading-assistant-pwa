import type { TrendBasketConfig } from "../shared/bots";
import { DAY_MS, trendState, trendTargets, withBand } from "../worker/bots/trend";
import type { Candle } from "../worker/market/types";
import { bootstrapMeanCi, maxDrawdown } from "./report";

/**
 * Бектест трендового кошика. Рішення о 00:00 UTC бачить лише денні свічки, що закрились; виконання — за Open доби,
 * комісія taker і проковзування на обіг, фандинг на кожне нарахування (лонг платить додатну ставку). Позиції між
 * рішеннями дрейфують з ціною. Капітал сталий (1 = 100%), денні результати додаються.
 * Список на кожну добу — topN за обігом у USDT за 30 діб із широкого списку; монета в позиції тримається, поки вона в топ-2N.
 */

export interface TrendSeries {
  symbol: string;
  daily: Candle[];
  funding: { at: number; paid: number }[];
}

export interface TrendBacktestConfig {
  cfg: TrendBasketConfig;
  takerPct: number;
  slippagePct: number;
  volumeDays: number;
}

export interface TrendDay {
  t: number;
  gross: number;
  fee: number;
  funding: number;
  net: number;
  /** Сума модулів часток після перебалансування. */
  exposure: number;
  longs: number;
  shorts: number;
  turnover: number;
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

export function simulateTrend(series: TrendSeries[], from: number, to: number, bt: TrendBacktestConfig): TrendDay[] {
  const { cfg } = bt;
  const cost = (bt.takerPct + bt.slippagePct) / 100;
  const need = Math.max(cfg.smaDays, cfg.volDays + 1);
  // Префіксні суми фандингу.
  const fund = new Map(
    series.map((s) => {
      const at = s.funding.map((e) => e.at);
      const cum = [0];
      for (const e of s.funding) cum.push(cum[cum.length - 1]! + e.paid);
      return [s.symbol, (a: number, b: number) => cum[firstIndex(at, (x) => x > b)]! - cum[firstIndex(at, (x) => x > a)]!];
    }),
  );
  let pos = new Map<string, number>();
  const days: TrendDay[] = [];
  for (let t = Math.ceil(from / DAY_MS) * DAY_MS; t + DAY_MS <= to; t += DAY_MS) {
    const live = series.flatMap((s) => {
      const i = firstIndex(s.daily, (c) => c.openTime >= t);
      if (s.daily[i]?.openTime !== t || s.daily[i - 1]?.openTime !== t - DAY_MS) return [];
      const vol = s.daily.slice(Math.max(0, i - bt.volumeDays), i).reduce((sum, c) => sum + c.volume * c.close, 0);
      return [{ s, i, vol }];
    });
    const ranked = [...live].sort((a, b) => b.vol - a.vol);
    const top = new Set(ranked.slice(0, cfg.topN).map((x) => x.s.symbol));
    const wide = new Set(ranked.slice(0, cfg.topN * 2).map((x) => x.s.symbol));
    const chosen = ranked.filter((x) => top.has(x.s.symbol) || (pos.has(x.s.symbol) && wide.has(x.s.symbol)));
    const states = chosen.flatMap((x) => {
      const st = trendState({ symbol: x.s.symbol, daily: x.s.daily.slice(Math.max(0, x.i - need), x.i) }, cfg);
      return st ? [st] : [];
    });
    const targets = trendTargets(states, cfg);
    const next = new Map<string, number>();
    let turnover = 0;
    for (const s of new Set([...pos.keys(), ...targets.keys()])) {
      const cur = pos.get(s) ?? 0;
      const w = withBand(cur, targets.get(s) ?? 0, cfg.band);
      turnover += Math.abs(w - cur);
      if (w !== 0) next.set(s, w);
    }
    // Результат доби: Open t → Open t+1; монета без свічки завтра закривається за останнім закриттям.
    const day: TrendDay = { t, gross: 0, fee: turnover * cost, funding: 0, net: 0, exposure: 0, longs: 0, shorts: 0, turnover };
    const drifted = new Map<string, number>();
    for (const [s, w] of next) {
      const x = live.find((l) => l.s.symbol === s)!;
      const d = x.s.daily;
      const open = d[x.i]!.open;
      const tomorrow = d[x.i + 1];
      const exit = tomorrow?.openTime === t + DAY_MS ? tomorrow.open : d[x.i]!.close;
      const move = exit / open - 1;
      day.gross += w * move;
      day.funding -= w * fund.get(s)!(t, t + DAY_MS);
      day.exposure += Math.abs(w);
      if (w > 0) day.longs++;
      else day.shorts++;
      drifted.set(s, w * (1 + move));
    }
    day.net = day.gross + day.funding - day.fee;
    days.push(day);
    pos = drifted;
  }
  return days;
}

export interface TrendSummary {
  days: number;
  totalPct: number;
  aprPct: number;
  weekPct: number | null;
  weekCi: [number, number] | null;
  sharpe: number | null;
  maxDrawdownPct: number;
  avgExposure: number;
  /** Частка днів хоч з однією позицією. */
  inMarket: number;
  feePct: number;
  fundingPct: number;
  /** Обіг на рік, капіталів. */
  turnoverYear: number;
}

const r2 = (v: number) => Number(v.toFixed(2));

export function trendSummary(days: TrendDay[]): TrendSummary {
  const weeks: number[] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7).reduce((s, d) => s + d.net, 0) * 100);
  const n = weeks.length;
  const mean = n ? weeks.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(weeks.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const total = days.reduce((s, d) => s + d.net, 0) * 100;
  const len = Math.max(1, days.length);
  return {
    days: days.length,
    totalPct: r2(total),
    aprPct: r2((total / len) * 365),
    weekPct: n ? Number(mean.toFixed(3)) : null,
    weekCi: bootstrapMeanCi(weeks),
    sharpe: sd > 0 ? r2((mean / sd) * Math.sqrt(52)) : null,
    maxDrawdownPct: maxDrawdown(days.map((d) => d.net * 100)),
    avgExposure: r2(days.reduce((s, d) => s + d.exposure, 0) / len),
    inMarket: r2(days.filter((d) => d.exposure > 0).length / len),
    feePct: r2(days.reduce((s, d) => s + d.fee, 0) * 100),
    fundingPct: r2(days.reduce((s, d) => s + d.funding, 0) * 100),
    turnoverYear: r2((days.reduce((s, d) => s + d.turnover, 0) / len) * 365),
  };
}

export function formatTrendLine(name: string, s: TrendSummary): string {
  const sign = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
  const ci = s.weekCi ? ` [${s.weekCi[0]} … ${s.weekCi[1]}]` : "";
  return `  ${name.padEnd(28)} ${sign(s.aprPct)} річних · разом ${sign(s.totalPct)} · тиждень ${s.weekPct ?? "—"}%${ci} · Шарп ${s.sharpe ?? "—"} · просадка ${s.maxDrawdownPct}% · у ринку ${Math.round(s.inMarket * 100)}% днів, експозиція ${s.avgExposure} · комісії −${s.feePct}%, фандинг ${sign(s.fundingPct)} · обіг ${s.turnoverYear}×/рік`;
}

/** Порівняння: щодня рівні частки 1/topN у кожній монеті списку (без сигналу), з тими самими комісіями й фандингом. */
export function holdConfig(cfg: TrendBasketConfig): TrendBasketConfig {
  return { ...cfg, smaDays: 0, targetVol: 1e9, sides: "long", band: 0.25 };
}
