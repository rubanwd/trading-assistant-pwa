import type { BacktestResult, Trade } from "./simulate";

/** Підсумок бектесту: рахує код. Усі R уже після комісій. */

export interface Summary {
  /** Угод із входом і закритою позицією. */
  trades: number;
  wins: number;
  winRate: number | null;
  avgR: number | null;
  /** 95% довірчий інтервал середнього R (бутстреп). */
  avgRCi: [number, number] | null;
  totalR: number;
  /** Сума прибуткових R / сума збиткових R. */
  profitFactor: number | null;
  /** Найбільша просадка кривої R від попереднього максимуму. */
  maxDrawdownR: number;
  /** Середні комісії на угоду, R. */
  avgFeeR: number | null;
}

export interface Report {
  overall: Summary & { signals: number; noEntry: number; stillOpen: number; grossTotalR: number };
  outcomes: Record<string, number>;
  bySetup: Record<string, Summary>;
  bySide: Record<string, Summary>;
  bySymbol: Record<string, Summary>;
  byMonth: Record<string, Summary>;
  funnel: BacktestResult["funnel"];
}

const round = (v: number, d = 2) => Number(v.toFixed(d));

/** Детермінований генератор для бутстрепу: однакові дані дають однаковий інтервал. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMeanCi(values: number[], iterations = 2000, seed = 42): [number, number] | null {
  if (values.length < 2) return null;
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(rand() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [round(means[Math.floor(iterations * 0.025)]!), round(means[Math.floor(iterations * 0.975)]!)];
}

export function maxDrawdown(rs: number[]): number {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return round(dd);
}

const closed = (t: Trade): t is Trade & { netR: number; resultR: number; resolvedAt: number } => t.netR !== null && t.resolvedAt !== null;

export function summarize(trades: Trade[]): Summary {
  const done = trades.filter(closed).sort((a, b) => a.resolvedAt - b.resolvedAt);
  const rs = done.map((t) => t.netR);
  const total = rs.reduce((s, r) => s + r, 0);
  const gains = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const losses = -rs.filter((r) => r < 0).reduce((s, r) => s + r, 0);
  const wins = rs.filter((r) => r > 0).length;
  return {
    trades: done.length,
    wins,
    winRate: done.length ? round(wins / done.length, 3) : null,
    avgR: done.length ? round(total / done.length, 3) : null,
    avgRCi: bootstrapMeanCi(rs),
    totalR: round(total),
    profitFactor: losses > 0 ? round(gains / losses) : null,
    maxDrawdownR: maxDrawdown(rs),
    avgFeeR: done.length ? round(done.reduce((s, t) => s + t.feeR, 0) / done.length, 3) : null,
  };
}

function by(trades: Trade[], key: (t: Trade) => string): Record<string, Summary> {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) groups.set(key(t), [...(groups.get(key(t)) ?? []), t]);
  return Object.fromEntries([...groups.keys()].sort().map((k) => [k, summarize(groups.get(k)!)]));
}

export function buildReport(result: BacktestResult): Report {
  const { trades } = result;
  const outcomes: Record<string, number> = {};
  for (const t of trades) {
    const missed = t.events.some((e) => e.type === "missed");
    const timeout = t.events.some((e) => e.type === "timeout");
    const k = missed ? "missed" : timeout ? "timeout" : t.status === "expired" && t.resultR === null ? "no_entry" : t.status;
    outcomes[k] = (outcomes[k] ?? 0) + 1;
  }
  return {
    overall: {
      ...summarize(trades),
      signals: trades.length,
      noEntry: trades.filter((t) => t.resolvedAt !== null && t.resultR === null).length,
      stillOpen: trades.filter((t) => t.resolvedAt === null).length,
      grossTotalR: round(trades.filter(closed).reduce((s, t) => s + t.resultR, 0)),
    },
    outcomes,
    bySetup: by(trades, (t) => t.setup),
    bySide: by(trades, (t) => t.side),
    bySymbol: by(trades, (t) => t.symbol),
    byMonth: by(trades, (t) => new Date(t.createdAt).toISOString().slice(0, 7)),
    funnel: result.funnel,
  };
}

const fmt = (v: number | null, d = 2) => (v === null ? "—" : v.toFixed(d));
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(0)}%`);

function table(title: string, rows: Record<string, Summary>): string {
  const head = `${"".padEnd(18)}${"угод".padStart(6)}${"виграш".padStart(8)}${"сер. R".padStart(8)}${"95% ДІ".padStart(16)}${"сума R".padStart(9)}${"PF".padStart(6)}${"просад.".padStart(9)}`;
  const lines = Object.entries(rows).map(
    ([k, s]) =>
      `${k.padEnd(18)}${String(s.trades).padStart(6)}${pct(s.winRate).padStart(8)}${fmt(s.avgR).padStart(8)}${(s.avgRCi ? `${fmt(s.avgRCi[0])}…${fmt(s.avgRCi[1])}` : "—").padStart(16)}${fmt(s.totalR, 1).padStart(9)}${fmt(s.profitFactor).padStart(6)}${fmt(s.maxDrawdownR, 1).padStart(9)}`,
  );
  return [`\n${title}`, head, ...lines].join("\n");
}

/** Текстовий звіт для консолі. */
export function formatReport(r: Report, meta: { from: string; to: string; symbols: number }): string {
  const o = r.overall;
  const f = r.funnel;
  const filtered = Object.entries(f.filtered)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return [
    `Бектест коду без моделі: ${meta.from} — ${meta.to}, монет ${meta.symbols}`,
    `\nВоронка: сканів ${f.scans}, знайдено сетапів ${f.detected}, відсіяно фільтром (${filtered || "нічого"}), ` +
      `понад ліміт за скан ${f.capped}, опубліковано ${f.published}`,
    `Сигналів ${o.signals}: з входом і закриті ${o.trades}, без входу ${o.noEntry}, відкриті на кінець даних ${o.stillOpen}`,
    `Результати: ${Object.entries(r.outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `\nУсього після комісій: ${fmt(o.totalR, 1)}R (до комісій ${fmt(o.grossTotalR, 1)}R, комісії в середньому ${fmt(o.avgFeeR, 3)}R на угоду)`,
    `Виграшних ${pct(o.winRate)}, середній ${fmt(o.avgR, 3)}R, 95% ДІ ${o.avgRCi ? `${fmt(o.avgRCi[0])}…${fmt(o.avgRCi[1])}` : "—"}, ` +
      `profit factor ${fmt(o.profitFactor)}, найбільша просадка ${fmt(o.maxDrawdownR, 1)}R`,
    table("За сетапами", r.bySetup),
    table("За напрямом", r.bySide),
    table("За монетами", r.bySymbol),
    table("За місяцями", r.byMonth),
    "\nЯкщо 95% ДІ середнього R охоплює нуль, перевага сетапу статистично не доведена.",
  ].join("\n");
}

/** Угоди в CSV для власного аналізу. */
export function tradesCsv(trades: Trade[]): string {
  const iso = (v: number | null) => (v === null ? "" : new Date(v).toISOString());
  const head = "created_at,symbol,side,setup,entry_low,entry_high,stop,tp1,tp2,rr,mood,trend_4h,trend_1d,status,result_r,fee_r,net_r,resolved_at";
  const rows = trades.map((t) =>
    [
      iso(t.createdAt), t.symbol, t.side, t.setup, t.entryLow, t.entryHigh, t.stop, t.tp1, t.tp2 ?? "", t.rr,
      t.mood, t.regime.trend ?? "", t.regime.higherTrend ?? "", t.status, t.resultR ?? "", t.feeR, t.netR ?? "", iso(t.resolvedAt),
    ].join(","),
  );
  return [head, ...rows].join("\n") + "\n";
}
