import type { CarryConfig } from "../shared/bots";
import { carryLegCost, DAY_MS, planCarry } from "../worker/bots/carry";
import { bootstrapMeanCi, maxDrawdown } from "./report";
import type { BroadSeries } from "./universe";

/**
 * Бектест бота «Фандинг-кері»: ті самі ставка, вхід і вихід, що й у рушії (src/worker/bots/carry.ts).
 * Рішення о 00:00 UTC бачить лише нарахування до цього моменту; позиція отримує нарахування після входу й до виходу
 * включно. Список для входу — topN за обігом у USDT за 30 діб із широкого списку. Монета без денної свічки
 * (торги зупинено, делістинг) закривається. Капітал сталий: позиція — 1/maxPositions, результати додаються.
 *
 * Чого бектест не бачить: зміни базису (різниці ціни контракту й споту) між входом і виходом — вона не накопичується,
 * але дає розкид окремих угод; переоцінки обсягу позиції з ціною; наявності споту на Bybit; ризику біржі й ліквідації
 * ноги з плечем. Фандинг — історичні ставки Binance; у Bybit вони близькі, але не однакові.
 */

export interface CarryFees {
  spotTakerPct: number;
  perpTakerPct: number;
  slippagePct: number;
}

export interface CarryBacktestConfig {
  cfg: CarryConfig;
  fees: CarryFees;
  volumeDays: number;
}

export interface CarryTrade {
  symbol: string;
  openedAt: number;
  closedAt: number | null;
  entryApr: number;
  /** Частки обсягу позиції. */
  funding: number;
  cost: number;
  /** Частка капіталу бота: (фандинг − комісії) / maxPositions. */
  net: number;
}

export interface CarryDay {
  t: number;
  positions: number;
  /** Частка капіталу. */
  funding: number;
  cost: number;
  net: number;
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

export function simulateCarry(series: BroadSeries[], from: number, to: number, bt: CarryBacktestConfig): { days: CarryDay[]; trades: CarryTrade[] } {
  const { cfg } = bt;
  const share = 1 / cfg.maxPositions;
  const legCost = carryLegCost(bt.fees);
  // Префіксні суми нарахувань: те саме, що fundingApr і сума за добу, але без проходу всім масивом щодня.
  const pre = new Map(
    series.map((s) => {
      const at = s.funding.map((e) => e.at);
      const cum = [0];
      for (const e of s.funding) cum.push(cum[cum.length - 1]! + e.paid);
      // Сума й кількість нарахувань у (a, b].
      const window = (a: number, b: number) => {
        const i = firstIndex(at, (x) => x > a);
        const j = firstIndex(at, (x) => x > b);
        return { sum: cum[j]! - cum[i]!, n: j - i };
      };
      return [s.symbol, window];
    }),
  );
  const aprFast = (symbol: string, a: number, b: number) => {
    const w = pre.get(symbol)!(a, b);
    return w.n ? (w.sum * (365 * DAY_MS)) / (b - a) * 100 : null;
  };
  const days: CarryDay[] = [];
  const trades: CarryTrade[] = [];
  const open = new Map<string, CarryTrade>();
  const look = cfg.lookbackDays * DAY_MS;
  for (let t = Math.ceil(from / DAY_MS) * DAY_MS; t + DAY_MS <= to; t += DAY_MS) {
    const day: CarryDay = { t, positions: 0, funding: 0, cost: 0, net: 0 };
    // Монети, що торгуються: є денна свічка, яка починається в t.
    const live = series.flatMap((s) => {
      const i = firstIndex(s.daily, (c) => c.openTime >= t);
      if (s.daily[i]?.openTime !== t) return [];
      const vol = s.daily.slice(Math.max(0, i - bt.volumeDays), i).reduce((sum, c) => sum + c.volume * c.close, 0);
      return [{ s, vol }];
    });
    const aprOf = new Map(live.map(({ s }) => [s.symbol, aprFast(s.symbol, t - look, t)]));
    const universe = [...live].sort((a, b) => b.vol - a.vol).slice(0, cfg.topN).map((x) => x.s.symbol);
    const plan = planCarry([...open.keys()], aprOf, universe, cfg);
    for (const s of plan.exit) {
      const tr = open.get(s)!;
      tr.closedAt = t;
      tr.cost += legCost;
      day.cost += legCost * share;
      tr.net = (tr.funding - tr.cost) * share;
      open.delete(s);
    }
    for (const s of plan.enter) {
      const tr: CarryTrade = { symbol: s, openedAt: t, closedAt: null, entryApr: aprOf.get(s)!, funding: 0, cost: legCost, net: 0 };
      day.cost += legCost * share;
      open.set(s, tr);
      trades.push(tr);
    }
    // Нарахування доби (t, t + 1d]: шорт контракту отримує додатну ставку й платить від'ємну.
    for (const [s, tr] of open) {
      const paid = pre.get(s)!(t, t + DAY_MS).sum;
      tr.funding += paid;
      day.funding += paid * share;
      tr.net = (tr.funding - tr.cost) * share;
    }
    day.positions = open.size;
    day.net = day.funding - day.cost;
    days.push(day);
  }
  return { days, trades };
}

export interface CarrySummary {
  days: number;
  totalPct: number;
  /** % капіталу на рік. */
  aprPct: number;
  /** Середня тижнева дохідність і її 95% ДІ, %. */
  weekPct: number | null;
  weekCi: [number, number] | null;
  sharpe: number | null;
  maxDrawdownPct: number;
  worstWeekPct: number | null;
  /** Середня частка зайнятих місць. */
  utilization: number;
  trades: number;
  /** Частка закритих угод, де фандинг перекрив комісії. */
  winRate: number | null;
  avgHoldDays: number | null;
  fundingPct: number;
  costPct: number;
  /** Частка днів, коли фандинг за позиціями був від'ємним. */
  negativeDays: number;
}

const r2 = (v: number) => Number(v.toFixed(2));

export function carrySummary(days: CarryDay[], trades: CarryTrade[], maxPositions: number): CarrySummary {
  const weeks: number[] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7).reduce((s, d) => s + d.net, 0) * 100);
  const n = weeks.length;
  const mean = n ? weeks.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(weeks.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const total = days.reduce((s, d) => s + d.net, 0) * 100;
  const closed = trades.filter((t) => t.closedAt !== null);
  return {
    days: days.length,
    totalPct: r2(total),
    aprPct: r2((total / Math.max(1, days.length)) * 365),
    weekPct: n ? Number(mean.toFixed(3)) : null,
    weekCi: bootstrapMeanCi(weeks),
    sharpe: sd > 0 ? r2((mean / sd) * Math.sqrt(52)) : null,
    maxDrawdownPct: maxDrawdown(days.map((d) => d.net * 100)),
    worstWeekPct: n ? r2(Math.min(...weeks)) : null,
    utilization: r2(days.reduce((s, d) => s + d.positions, 0) / Math.max(1, days.length) / maxPositions),
    trades: trades.length,
    winRate: closed.length ? r2(closed.filter((t) => t.net > 0).length / closed.length) : null,
    avgHoldDays: closed.length ? r2(closed.reduce((s, t) => s + (t.closedAt! - t.openedAt), 0) / closed.length / DAY_MS) : null,
    fundingPct: r2(days.reduce((s, d) => s + d.funding, 0) * 100),
    costPct: r2(days.reduce((s, d) => s + d.cost, 0) * 100),
    negativeDays: r2(days.filter((d) => d.funding < 0).length / Math.max(1, days.filter((d) => d.positions).length)),
  };
}

export function formatCarryLine(name: string, s: CarrySummary): string {
  const ci = s.weekCi ? ` [${s.weekCi[0]} … ${s.weekCi[1]}]` : "";
  const sign = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
  return `  ${name.padEnd(26)} ${sign(s.aprPct)} річних · разом ${sign(s.totalPct)} · тиждень ${s.weekPct ?? "—"}%${ci} · Шарп ${s.sharpe ?? "—"} · просадка ${s.maxDrawdownPct}% · зайнято ${Math.round(s.utilization * 100)}% · угод ${s.trades} (у плюсі ${s.winRate === null ? "—" : Math.round(s.winRate * 100) + "%"}, ${s.avgHoldDays ?? "—"} діб) · фандинг ${sign(s.fundingPct)}, комісії −${s.costPct}%`;
}

export function carryTradesCsv(trades: CarryTrade[]): string {
  const iso = (t: number | null) => (t === null ? "" : new Date(t).toISOString().slice(0, 10));
  return (
    [
      "symbol,opened,closed,entry_apr,funding_pct,cost_pct,net_pct_capital",
      ...trades.map((t) => [t.symbol, iso(t.openedAt), iso(t.closedAt), t.entryApr.toFixed(1), (t.funding * 100).toFixed(3), (t.cost * 100).toFixed(3), (t.net * 100).toFixed(3)].join(",")),
    ].join("\n") + "\n"
  );
}
