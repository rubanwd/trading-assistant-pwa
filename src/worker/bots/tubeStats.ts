import type { Side } from "../../shared/risk";
import type { TubeBias, TubeStatus } from "./tube";

/**
 * Облік бота High Value Tube: чисті функції над рядками bot_orders. R після комісій: result_r − fee_r.
 * Знятий без виконання ордер — не угода: він іде лише в частку виконаних.
 */

export interface TubeRecord {
  id: number;
  created_at: string;
  symbol: string;
  side: Side;
  bias: TubeBias;
  /** 1 — ближчий ордер монети, 0 — дальній, null — ринок без напрямку. */
  near: 0 | 1 | null;
  rank: number;
  price: number;
  entry: number;
  stop: number;
  target: number;
  status: TubeStatus;
  filled_at: string | null;
  resolved_at: string | null;
  exit_price: number | null;
  result_r: number | null;
  fee_r: number | null;
}

export type TubeOutcomeKind = "win" | "loss" | "open" | "pending" | "cancelled";

export const CLOSED: readonly TubeStatus[] = ["target", "stop", "timeout"];

export function netR(r: Pick<TubeRecord, "status" | "result_r" | "fee_r">): number | null {
  if (!CLOSED.includes(r.status) || r.result_r === null) return null;
  return Number((r.result_r - (r.fee_r ?? 0)).toFixed(3));
}

/** win — угода закрилась у плюсі після комісій (тейк або за часом у плюсі); loss — стоп або за часом у мінусі. */
export function outcomeOf(r: Pick<TubeRecord, "status" | "result_r" | "fee_r">): TubeOutcomeKind {
  if (r.status === "pending" || r.status === "cancelled" || r.status === "open") return r.status;
  return (netR(r) ?? 0) > 0 ? "win" : "loss";
}

export interface TubeGroup {
  /** Усі поставлені ордери, включно зі знятими. */
  orders: number;
  /** Виконані: відкриті й закриті угоди. */
  filled: number;
  cancelled: number;
  pending: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  target: number;
  stop: number;
  timeout: number;
  /** Частка угод у плюсі серед закритих, 0..1. */
  winRate: number | null;
  avgR: number | null;
  totalR: number;
  /** Частка виконаних серед ордерів, чия година вже минула, 0..1. */
  fillRate: number | null;
}

export function tubeGroup(rows: TubeRecord[]): TubeGroup {
  const g: TubeGroup = { orders: rows.length, filled: 0, cancelled: 0, pending: 0, open: 0, closed: 0, wins: 0, losses: 0, target: 0, stop: 0, timeout: 0, winRate: null, avgR: null, totalR: 0, fillRate: null };
  let total = 0;
  for (const r of rows) {
    const o = outcomeOf(r);
    if (o === "pending") g.pending++;
    else if (o === "cancelled") g.cancelled++;
    else {
      g.filled++;
      if (o === "open") g.open++;
      else {
        g.closed++;
        if (o === "win") g.wins++;
        else g.losses++;
        if (r.status === "target") g.target++;
        else if (r.status === "stop") g.stop++;
        else g.timeout++;
        total += netR(r) ?? 0;
      }
    }
  }
  g.totalR = Number(total.toFixed(2));
  if (g.closed) {
    g.winRate = g.wins / g.closed;
    g.avgR = Number((total / g.closed).toFixed(3));
  }
  const decided = g.filled + g.cancelled;
  if (decided) g.fillRate = g.filled / decided;
  return g;
}

export interface TubeSummary {
  all: TubeGroup;
  bySide: Record<Side, TubeGroup>;
  byBias: Record<TubeBias, TubeGroup>;
  /** Ближчий чи дальній ордер монети: чи виправдовує себе правило «удвічі ближче». */
  byDistance: Record<"near" | "far" | "neutral", TubeGroup>;
  /** Монети з угодами, від найбільшого результату. */
  bySymbol: ({ symbol: string } & TubeGroup)[];
}

export function tubeSummarize(rows: TubeRecord[]): TubeSummary {
  const by = <K extends string>(keys: readonly K[], key: (r: TubeRecord) => K) =>
    Object.fromEntries(keys.map((k) => [k, tubeGroup(rows.filter((r) => key(r) === k))])) as Record<K, TubeGroup>;
  const symbols = [...new Set(rows.filter((r) => r.filled_at !== null).map((r) => r.symbol))];
  return {
    all: tubeGroup(rows),
    bySide: by(["long", "short"] as const, (r) => r.side),
    byBias: by(["bull", "bear", "neutral"] as const, (r) => r.bias),
    byDistance: by(["near", "far", "neutral"] as const, (r) => (r.near === null ? "neutral" : r.near ? "near" : "far")),
    bySymbol: symbols.map((symbol) => ({ symbol, ...tubeGroup(rows.filter((r) => r.symbol === symbol)) })).sort((a, b) => b.totalR - a.totalR),
  };
}
