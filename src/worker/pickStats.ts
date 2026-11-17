import { feeR, type Fees, type Side } from "../shared/risk";
import type { PickStatus, PickVerdict } from "./pick";

/**
 * Облік ідей скану: результат кожної ідеї й підсумки. Чисті функції; рядки бере API з таблиці picks.
 * Повтори (та сама монета й напрямок, поки попередня ідея відкрита) не є окремими ідеями: їх лише рахуємо.
 */

export interface PickRecord {
  id: number;
  created_at: string;
  symbol: string;
  side: Side;
  entry_kind: "market" | "pullback";
  entry: number;
  stop: number;
  target: number;
  score: number;
  verdict: PickVerdict;
  probability: number | null;
  status: PickStatus;
  /** Результат у R без комісій. */
  result_r: number | null;
  resolved_at: string | null;
  /** Скільки разів поспіль ідею повторили наступні скани. */
  repeats: number;
}

/** win — ідея підтвердилась (ціль або закриття за часом у плюсі); loss — програла; open — ще триває; none — вхід не виконався. */
export type PickOutcome = "win" | "loss" | "open" | "none";

export function outcome(r: Pick<PickRecord, "status" | "result_r">): PickOutcome {
  if (r.status === "open") return "open";
  if (r.status === "unfilled") return "none";
  if (r.status === "target") return "win";
  if (r.status === "stop") return "loss";
  return (r.result_r ?? 0) > 0 ? "win" : "loss";
}

/**
 * Результат після комісій, R. Вхід за ринком платить taker, лімітка — maker; ціль виходить лімітним ордером (maker),
 * стоп і закриття за часом — за ринком (taker). null, поки ідея відкрита або вхід не виконався.
 */
export function netR(r: Pick<PickRecord, "side" | "entry_kind" | "entry" | "stop" | "status" | "result_r">, fees: Fees): number | null {
  if (r.result_r === null || r.status === "open" || r.status === "unfilled") return null;
  const dir = r.side === "long" ? 1 : -1;
  const exit = r.entry + dir * r.result_r * Math.abs(r.entry - r.stop);
  const fee = feeR(
    { price: r.entry, kind: r.entry_kind === "market" ? "taker" : "maker" },
    r.stop,
    [{ price: exit, share: 1, kind: r.status === "target" ? "maker" : "taker" }],
    fees,
  );
  return Number((r.result_r - fee).toFixed(2));
}

export interface PickGroup {
  ideas: number;
  open: number;
  /** Вхід не виконався. */
  unfilled: number;
  wins: number;
  losses: number;
  target: number;
  stop: number;
  expired: number;
  /** Частка підтверджених серед закритих з входом, 0..1. */
  winRate: number | null;
  /** Після комісій. */
  avgR: number | null;
  totalR: number;
}

export function group(rows: PickRecord[], fees: Fees): PickGroup {
  const g: PickGroup = { ideas: rows.length, open: 0, unfilled: 0, wins: 0, losses: 0, target: 0, stop: 0, expired: 0, winRate: null, avgR: null, totalR: 0 };
  let closed = 0;
  for (const r of rows) {
    const o = outcome(r);
    if (o === "open") g.open++;
    else if (o === "none") g.unfilled++;
    else {
      closed++;
      if (o === "win") g.wins++;
      else g.losses++;
      if (r.status === "target") g.target++;
      else if (r.status === "stop") g.stop++;
      else g.expired++;
      g.totalR += netR(r, fees) ?? 0;
    }
  }
  g.totalR = Number(g.totalR.toFixed(2));
  if (closed) {
    g.winRate = g.wins / closed;
    g.avgR = Number((g.totalR / closed).toFixed(2));
  }
  return g;
}

export interface PickSummary {
  all: PickGroup;
  byVerdict: Record<PickVerdict, PickGroup>;
  bySide: Record<Side, PickGroup>;
  byEntry: Record<"market" | "pullback", PickGroup>;
  /** Оцінки ШІ проти факту: середня обіцяна ймовірність цілі й частка ідей, що дійшли до цілі. */
  calibration: { n: number; predicted: number | null; actual: number | null };
}

export function summarize(rows: PickRecord[], fees: Fees): PickSummary {
  const by = <K extends string>(keys: readonly K[], key: (r: PickRecord) => K) =>
    Object.fromEntries(keys.map((k) => [k, group(rows.filter((r) => key(r) === k), fees)])) as Record<K, PickGroup>;
  const rated = rows.filter((r) => r.verdict === "pick" && r.probability !== null && (r.status === "target" || r.status === "stop" || r.status === "expired"));
  return {
    all: group(rows, fees),
    byVerdict: by(["pick", "pass", "none"] as const, (r) => r.verdict),
    bySide: by(["long", "short"] as const, (r) => r.side),
    byEntry: by(["market", "pullback"] as const, (r) => r.entry_kind),
    calibration: {
      n: rated.length,
      predicted: rated.length ? rated.reduce((s, r) => s + r.probability!, 0) / rated.length : null,
      actual: rated.length ? rated.filter((r) => r.status === "target").length / rated.length : null,
    },
  };
}
