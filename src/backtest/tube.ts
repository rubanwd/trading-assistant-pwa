import type { TubeConfig } from "../shared/bots";
import type { Fees } from "../shared/risk";
import { ORDER_TTL_MS, planCycle, resolveTube, TUBE_H1_LIMIT, TUBE_H4_LIMIT, tubeFeatures, tubeFeeR, type RankBy, type TubeFeatures, type TubeOrderPlan, type TubeStatus } from "../worker/bots/tube";
import type { Candle } from "../worker/market/types";
import { timeframeFeatures, type TimeframeFeatures } from "../worker/snapshot";
import { bootstrapMeanCi, maxDrawdown } from "./report";
import type { SymbolCandles } from "./simulate";

/**
 * Бектест бота High Value Tube: ті самі ознаки, рейтинг, план ордерів і паперове виконання, що й у рушії.
 * Цикл щогодини о HH:04 (рушій стартує о :03): ознаки зі свічок 1h і 4h, що вже закрились; ордери живуть годину;
 * виконання за свічками 15m. Позиції й ліміт місць рахуються так само, як у рушії.
 */

const HOUR = 3_600_000;
const M15 = 15 * 60_000;
/** Зсув циклу від початку години: рушій запускається о :03 і ставить ордери за хвилину. */
export const CYCLE_DELAY_MS = 4 * 60_000;

export interface TubeHour {
  /** Момент циклу, мс UTC. */
  t: number;
  features: TubeFeatures[];
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

/**
 * Ознаки всіх монет на кожен цикл. Від параметрів стратегії не залежать, тож рахуються один раз на всю сітку.
 * Монета без свіжої свічки 1h (ще не торгувалась або торги зупинено) у цикл не йде.
 */
export function tubeHours(symbols: SymbolCandles[], from: number, to: number): TubeHour[] {
  const state = symbols.map((s) => ({ s, i1: 0, i4: 0, k4: -1, f4: null as TimeframeFeatures | null }));
  const out: TubeHour[] = [];
  for (let h = Math.ceil(from / HOUR) * HOUR; h <= to; h += HOUR) {
    const t = h + CYCLE_DELAY_MS;
    const features: TubeFeatures[] = [];
    for (const st of state) {
      const h1 = st.s["1h"];
      const h4 = st.s["4h"];
      while (st.i1 < h1.length && h1[st.i1]!.closeTime < t) st.i1++;
      while (st.i4 < h4.length && h4[st.i4]!.closeTime < t) st.i4++;
      if (st.i1 === 0 || h1[st.i1 - 1]!.closeTime < t - 2 * HOUR) continue;
      if (st.i4 !== st.k4) {
        st.k4 = st.i4;
        st.f4 = st.i4 ? timeframeFeatures(h4.slice(Math.max(0, st.i4 - TUBE_H4_LIMIT), st.i4)) : null;
      }
      const f = tubeFeatures(st.s.symbol, h1.slice(Math.max(0, st.i1 - TUBE_H1_LIMIT), st.i1), st.f4);
      if (f) features.push(f);
    }
    out.push({ t, features });
  }
  return out;
}

export interface TubeBacktestConfig {
  cfg: TubeConfig;
  fees: Fees;
  /** Проковзування на ринкових виходах (стоп, за часом), % від ціни: стрес-тест. */
  slippagePct: number;
  rankBy?: RankBy;
  anchor?: "price" | "ema";
}

export interface TubeBtOrder extends TubeOrderPlan {
  createdAt: number;
  status: TubeStatus;
  filledAt: number | null;
  resolvedAt: number | null;
  exitPrice: number | null;
  resultR: number | null;
  feeR: number | null;
  slipR: number;
  /** Після комісій і проковзування; null, якщо ордер не виконався або позиція відкрита на кінець даних. */
  netR: number | null;
}

/** Симуляція бота по готових ознаках. m15 — свічки 15m кожної монети. */
export function simulateTube(hours: TubeHour[], m15: Map<string, Candle[]>, bt: TubeBacktestConfig): TubeBtOrder[] {
  const orders: TubeBtOrder[] = [];
  let active: TubeBtOrder[] = [];
  const holdMs = bt.cfg.maxHoldHours * HOUR;
  const span = Math.ceil((ORDER_TTL_MS + holdMs) / M15) + 4;
  const cursors = new Map<string, number>();
  for (const { t, features } of hours) {
    // Позиції, що на момент циклу вже виконались і ще не закрились (рушій бачить лише свічки, що закрились до циклу).
    active = active.filter((o) => o.resolvedAt === null || o.resolvedAt >= t);
    const open = active.filter((o) => o.filledAt !== null && o.filledAt < t).map((o) => ({ symbol: o.symbol, side: o.side }));
    const plan = planCycle(features, open, bt.cfg, { rankBy: bt.rankBy, anchor: bt.anchor });
    for (const p of plan.orders) {
      const candles = m15.get(p.symbol) ?? [];
      let start = cursors.get(p.symbol) ?? 0;
      while (start < candles.length && candles[start]!.openTime < t) start++;
      cursors.set(p.symbol, start);
      const res = resolveTube(
        { side: p.side, entry: p.entry, stop: p.stop, target: p.target, placedAt: t, expiresAt: t + ORDER_TTL_MS, maxHoldMs: holdMs },
        candles.slice(start, start + span),
        Number.POSITIVE_INFINITY,
      );
      const fee = tubeFeeR(p, res.status, res.exitPrice, bt.fees);
      const risk = Math.abs(p.entry - p.stop);
      const slip = res.exitPrice !== null && res.status !== "target" && risk > 0 ? (res.exitPrice * bt.slippagePct) / 100 / risk : 0;
      const o: TubeBtOrder = {
        ...p,
        createdAt: t,
        ...res,
        feeR: fee,
        slipR: Number(slip.toFixed(3)),
        netR: res.resultR === null || fee === null ? null : Number((res.resultR - fee - slip).toFixed(3)),
      };
      orders.push(o);
      if (o.filledAt !== null) active.push(o);
    }
  }
  return orders;
}

// ── Звіт ───────────────────────────────────────────────────────────────────

export interface TubeSummary {
  trades: number;
  wins: number;
  winRate: number | null;
  avgR: number | null;
  avgRCi: [number, number] | null;
  totalR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  target: number;
  stop: number;
  timeout: number;
  avgFeeR: number | null;
}

const r2 = (v: number) => Number(v.toFixed(3));

export function tubeSummary(orders: TubeBtOrder[], ci = true): TubeSummary {
  const closed = orders.filter((o) => o.netR !== null).sort((a, b) => a.resolvedAt! - b.resolvedAt!);
  const rs = closed.map((o) => o.netR!);
  const wins = rs.filter((r) => r > 0).length;
  const gain = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const loss = -rs.filter((r) => r < 0).reduce((s, r) => s + r, 0);
  const total = rs.reduce((s, r) => s + r, 0);
  return {
    trades: rs.length,
    wins,
    winRate: rs.length ? r2(wins / rs.length) : null,
    avgR: rs.length ? r2(total / rs.length) : null,
    avgRCi: ci ? bootstrapMeanCi(rs) : null,
    totalR: Number(total.toFixed(2)),
    profitFactor: loss > 0 ? Number((gain / loss).toFixed(2)) : null,
    maxDrawdownR: maxDrawdown(rs),
    target: closed.filter((o) => o.status === "target").length,
    stop: closed.filter((o) => o.status === "stop").length,
    timeout: closed.filter((o) => o.status === "timeout").length,
    avgFeeR: closed.length ? r2(closed.reduce((s, o) => s + (o.feeR ?? 0), 0) / closed.length) : null,
  };
}

export interface TubeReport {
  overall: TubeSummary & { orders: number; filled: number; fillRate: number | null; tradesPerDay: number; stillOpen: number; medianHoldHours: number | null };
  bySide: Record<string, TubeSummary>;
  byBias: Record<string, TubeSummary>;
  /** Ближчий чи дальній ордер монети, коли ринок мав напрямок. */
  byDistance: Record<string, TubeSummary>;
  bySymbol: Record<string, TubeSummary>;
  byYear: Record<string, TubeSummary>;
  byMonth: Record<string, TubeSummary>;
}

function groupBy(orders: TubeBtOrder[], key: (o: TubeBtOrder) => string): Record<string, TubeSummary> {
  const groups = new Map<string, TubeBtOrder[]>();
  for (const o of orders) {
    const k = key(o);
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, tubeSummary(v)]));
}

export function tubeReport(orders: TubeBtOrder[], from: number, to: number): TubeReport {
  const filled = orders.filter((o) => o.filledAt !== null);
  const holds = filled
    .filter((o) => o.resolvedAt !== null)
    .map((o) => (o.resolvedAt! - o.filledAt!) / HOUR)
    .sort((a, b) => a - b);
  const days = Math.max(1, (to - from) / (24 * HOUR));
  return {
    overall: {
      ...tubeSummary(filled),
      orders: orders.length,
      filled: filled.length,
      fillRate: orders.length ? r2(filled.length / orders.length) : null,
      tradesPerDay: Number((filled.length / days).toFixed(2)),
      stillOpen: filled.filter((o) => o.netR === null).length,
      medianHoldHours: holds.length ? Number(holds[Math.floor(holds.length / 2)]!.toFixed(1)) : null,
    },
    bySide: groupBy(filled, (o) => o.side),
    byBias: groupBy(filled, (o) => o.bias),
    byDistance: groupBy(filled, (o) => (o.near === null ? "neutral" : o.near ? "near" : "far")),
    bySymbol: groupBy(filled, (o) => o.symbol),
    byYear: groupBy(filled, (o) => new Date(o.createdAt).toISOString().slice(0, 4)),
    byMonth: groupBy(filled, (o) => new Date(o.createdAt).toISOString().slice(0, 7)),
  };
}

const fmtR = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(3)}R`);
const fmtPct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

function line(name: string, s: TubeSummary): string {
  const ci = s.avgRCi ? ` [${s.avgRCi[0]} … ${s.avgRCi[1]}]` : "";
  return `  ${name.padEnd(12)} угод ${String(s.trades).padStart(6)} · виграш ${fmtPct(s.winRate).padStart(4)} · середнє ${fmtR(s.avgR)}${ci} · разом ${s.totalR.toFixed(1)}R · PF ${s.profitFactor ?? "—"} · просадка ${s.maxDrawdownR}R`;
}

export function formatTubeReport(rep: TubeReport, meta: { from: string; to: string; symbols: number; cfg: TubeConfig; extra?: string }): string {
  const o = rep.overall;
  const c = meta.cfg;
  const out = [
    `High Value Tube · бектест ${meta.from} — ${meta.to} · ${meta.symbols} монет`,
    `Параметри: ${c.pickN} з ${c.topN} монет · вхід ${c.entryAtr} ATR (ближчий ÷${c.biasRatio}, ${c.biasSide}) · стоп ${c.stopAtr} ATR (не ближче ${c.minStopPct}%) · тейк ${c.targetR}R · до ${c.maxHoldHours} год · до ${c.maxPositions} позицій${meta.extra ? ` · ${meta.extra}` : ""}`,
    "",
    `Ордерів ${o.orders} · виконалось ${o.filled} (${fmtPct(o.fillRate)}) · ${o.tradesPerDay} угоди на добу · медіана утримання ${o.medianHoldHours ?? "—"} год · відкрито на кінець ${o.stillOpen}`,
    `Тейк ${o.target} · стоп ${o.stop} · за часом ${o.timeout} · комісії в середньому ${fmtR(o.avgFeeR)}`,
    line("Усі", o),
    "",
    "Напрямок:",
    ...Object.entries(rep.bySide).map(([k, s]) => line(k, s)),
    "Ринок:",
    ...Object.entries(rep.byBias).map(([k, s]) => line(k, s)),
    "Ордер монети:",
    ...Object.entries(rep.byDistance).map(([k, s]) => line(k, s)),
    "Роки:",
    ...Object.entries(rep.byYear).map(([k, s]) => line(k, s)),
    "Монети:",
    ...Object.entries(rep.bySymbol)
      .sort(([, a], [, b]) => b.totalR - a.totalR)
      .map(([k, s]) => line(k.replace(/USDT$/, ""), s)),
  ];
  return out.join("\n");
}

export function tubeTradesCsv(orders: TubeBtOrder[]): string {
  const head = "created_at,symbol,side,bias,near,rank,price,atr,entry,stop,target,offset_atr,status,filled_at,resolved_at,exit_price,result_r,fee_r,net_r";
  const iso = (t: number | null) => (t === null ? "" : new Date(t).toISOString());
  const rows = orders
    .filter((o) => o.filledAt !== null)
    .map((o) =>
      [iso(o.createdAt), o.symbol, o.side, o.bias, o.near === null ? "" : o.near ? 1 : 0, o.rank, o.price, o.atr, o.entry, o.stop, o.target, o.offsetAtr, o.status, iso(o.filledAt), iso(o.resolvedAt), o.exitPrice ?? "", o.resultR ?? "", o.feeR ?? "", o.netR ?? ""].join(","),
    );
  return [head, ...rows].join("\n") + "\n";
}
