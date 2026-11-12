/**
 * Статистика: рахує код, модель лише пояснює її в тижневому розборі.
 * Чисті функції над рядками бази плюс завантажувач для D1.
 */

export interface SignalStatRow {
  id: number;
  created_at: string;
  resolved_at: string | null;
  setup: string;
  status: string;
  result_r: number | null;
  fee_r: number | null;
  p_analyst: number | null;
  p_skeptic: number | null;
  playbook_version: number | null;
  shadow_status: string | null;
  shadow_r: number | null;
  /** Останнє рішення в журналі. */
  action: "taken" | "skipped" | null;
}

export interface ForecastStatRow {
  probability: number;
  outcome: number | null;
}

export interface Group {
  /** Сигналів із результатом в R (був вхід і позицію закрито). */
  closed: number;
  wins: number;
  /** Частка прибуткових після комісій, 0..1. */
  winRate: number | null;
  /** Середній результат після комісій, R. */
  avgR: number | null;
  totalR: number;
}

export interface Bin {
  from: number;
  to: number;
  n: number;
  /** Середня прогнозована ймовірність у кошику. */
  predicted: number;
  /** Як часто справді збувалося. */
  actual: number;
}

export interface Calibration {
  n: number;
  /** Бал Браєра: 0 ідеально, 0.25 відповідає монетці на 50%. */
  brier: number | null;
  bins: Bin[];
}

export interface Stats {
  from: string | null;
  to: string;
  summary: Group & {
    published: number;
    open: number;
    /** Середні комісії на угоду, R. */
    avgFeeR: number | null;
    riskPct: number;
    /** Сума R × ризик на угоду, без складних відсотків. */
    equityPct: number;
    btcHoldPct: number | null;
    /** Скільки закритих сигналів до рішення за форвард-тестом. */
    target: number;
  };
  bySetup: (Group & { setup: string; published: number })[];
  byVersion: (Group & { version: number | null })[];
  journal: Record<"taken" | "skipped" | "none", Group>;
  /** Що було б із відхиленими моделлю кандидатами. */
  rejected: Group & { count: number };
  calibration: { analyst: Calibration; skeptic: Calibration; reports: Calibration };
  funnel: { scans: number; detected: number; filtered: Record<string, number>; reviewed: number; published: number; rejected: number };
  spend: { monthUsd: number; budgetUsd: number | null; byPipeline: { pipeline: string; usd: number; calls: number }[] };
}

const round = (v: number, d = 2) => Number(v.toFixed(d));
const net = (r: SignalStatRow) => (r.result_r ?? 0) - (r.fee_r ?? 0);

export function group(rows: { r: number }[]): Group {
  const closed = rows.length;
  const wins = rows.filter((x) => x.r > 0).length;
  const total = rows.reduce((s, x) => s + x.r, 0);
  return {
    closed,
    wins,
    winRate: closed ? round(wins / closed, 3) : null,
    avgR: closed ? round(total / closed) : null,
    totalR: round(total),
  };
}

/** Кошики по 10 відсоткових пунктів; порожні не показуються. */
export function calibration(points: { p: number; hit: 0 | 1 }[]): Calibration {
  if (!points.length) return { n: 0, brier: null, bins: [] };
  const bins: Bin[] = [];
  for (let i = 0; i < 10; i++) {
    const from = i / 10;
    const to = (i + 1) / 10;
    const inBin = points.filter((x) => x.p >= from && (i === 9 ? x.p <= to : x.p < to));
    if (!inBin.length) continue;
    bins.push({
      from,
      to,
      n: inBin.length,
      predicted: round(inBin.reduce((s, x) => s + x.p, 0) / inBin.length, 3),
      actual: round(inBin.filter((x) => x.hit).length / inBin.length, 3),
    });
  }
  const brier = points.reduce((s, x) => s + (x.p - x.hit) ** 2, 0) / points.length;
  return { n: points.length, brier: round(brier, 3), bins };
}

/**
 * Чи дійшла ціна до першої цілі раніше за стоп. Статус tp1 чи tp2 означає «так», stopped означає «ні»;
 * прострочені й закриті за часом без цілі в калібрування не йдуть: подія не розв'язалась.
 */
export function hit(status: string | null): 0 | 1 | null {
  if (status === "tp1" || status === "tp2") return 1;
  if (status === "stopped") return 0;
  return null;
}

const CLOSED = new Set(["tp1", "tp2", "stopped", "expired"]);
const isTrade = (r: SignalStatRow) => CLOSED.has(r.status) && r.result_r !== null;

export interface StatsInput {
  signals: SignalStatRow[];
  forecasts: ForecastStatRow[];
  /** Деталі запусків signals (SignalsSummary). */
  funnel: { detected?: number; filtered?: Record<string, number>; reviewed?: number; published?: number; rejected?: number; detection?: boolean }[];
  spend: { pipeline: string; usd: number; calls: number }[];
  budgetUsd: number | null;
  riskPct: number;
  btc: { start: number | null; end: number | null };
  from: string | null;
  to: string;
  target?: number;
}

export function computeStats(input: StatsInput): Stats {
  const published = input.signals.filter((s) => s.status !== "rejected");
  const trades = published.filter(isTrade);
  const tradeGroup = (rows: SignalStatRow[]) => group(rows.filter(isTrade).map((r) => ({ r: net(r) })));
  const total = tradeGroup(published);
  const fees = trades.filter((t) => t.fee_r !== null);

  const setups = [...new Set(input.signals.map((s) => s.setup))].sort();
  const versions = [...new Set(published.map((s) => s.playbook_version))].sort((a, b) => (a ?? 0) - (b ?? 0));
  const rejected = input.signals.filter((s) => s.status === "rejected");
  const shadow = rejected.filter((s) => s.shadow_r !== null && s.shadow_status !== null && CLOSED.has(s.shadow_status));

  const outcomes = input.signals
    .map((s) => ({ s, hit: hit(s.status === "rejected" ? s.shadow_status : s.status) }))
    .filter((x): x is { s: SignalStatRow; hit: 0 | 1 } => x.hit !== null);
  const points = (key: "p_analyst" | "p_skeptic") =>
    outcomes.filter((x) => x.s[key] !== null).map((x) => ({ p: x.s[key]!, hit: x.hit }));

  const funnel = { scans: 0, detected: 0, filtered: {} as Record<string, number>, reviewed: 0, published: 0, rejected: 0 };
  for (const f of input.funnel) {
    if (f.detection) funnel.scans++;
    funnel.detected += f.detected ?? 0;
    funnel.reviewed += f.reviewed ?? 0;
    funnel.published += f.published ?? 0;
    funnel.rejected += f.rejected ?? 0;
    for (const [k, v] of Object.entries(f.filtered ?? {})) funnel.filtered[k] = (funnel.filtered[k] ?? 0) + v;
  }

  const { start, end } = input.btc;
  return {
    from: input.from,
    to: input.to,
    summary: {
      ...total,
      published: published.length,
      open: published.filter((s) => s.status === "pending" || s.status === "active").length,
      avgFeeR: fees.length ? round(fees.reduce((s, t) => s + (t.fee_r ?? 0), 0) / fees.length, 3) : null,
      riskPct: input.riskPct,
      equityPct: round(total.totalR * input.riskPct),
      btcHoldPct: start && end ? round((end / start - 1) * 100) : null,
      target: input.target ?? 100,
    },
    bySetup: setups.map((setup) => ({
      setup,
      published: published.filter((s) => s.setup === setup).length,
      ...tradeGroup(published.filter((s) => s.setup === setup)),
    })),
    byVersion: versions.map((version) => ({ version, ...tradeGroup(published.filter((s) => s.playbook_version === version)) })),
    journal: {
      taken: tradeGroup(published.filter((s) => s.action === "taken")),
      skipped: tradeGroup(published.filter((s) => s.action === "skipped")),
      none: tradeGroup(published.filter((s) => s.action === null)),
    },
    rejected: { count: rejected.length, ...group(shadow.map((s) => ({ r: s.shadow_r! }))) },
    calibration: {
      analyst: calibration(points("p_analyst")),
      skeptic: calibration(points("p_skeptic")),
      reports: calibration(
        input.forecasts.filter((f) => f.outcome === 0 || f.outcome === 1).map((f) => ({ p: f.probability, hit: f.outcome as 0 | 1 })),
      ),
    },
    funnel,
    spend: {
      monthUsd: round(input.spend.reduce((s, x) => s + x.usd, 0), 4),
      budgetUsd: input.budgetUsd,
      byPipeline: input.spend.map((x) => ({ ...x, usd: round(x.usd, 4) })).sort((a, b) => b.usd - a.usd),
    },
  };
}

const monthStart = (now: number) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
};

/**
 * Завантажує рядки з D1 і рахує статистику. from: ISO або null (увесь час).
 * Сигнал входить у період, якщо створений або закритий у ньому.
 */
export async function loadStats(db: D1Database, opts: { from: string | null; now: number }): Promise<Stats> {
  const from = opts.from ?? "0000";
  const to = new Date(opts.now).toISOString();
  const setting = async <T>(key: string, fallback: T): Promise<T> => {
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row ? (JSON.parse(row.value) as T) : fallback;
  };
  const [signals, forecasts, runs, spend, budget, riskPct, firstSignal] = await Promise.all([
    db
      .prepare(
        `SELECT id, created_at, resolved_at, setup, status, result_r, fee_r, p_analyst, p_skeptic, playbook_version, shadow_status, shadow_r,
           (SELECT action FROM journal WHERE signal_id = signals.id ORDER BY id DESC LIMIT 1) AS action
         FROM signals WHERE created_at >= ? OR resolved_at >= ?`,
      )
      .bind(from, from)
      .all<SignalStatRow>(),
    db.prepare("SELECT probability, outcome FROM forecasts WHERE resolved_at >= ?").bind(from).all<ForecastStatRow>(),
    db.prepare("SELECT detail FROM runs WHERE kind = 'signals' AND started_at >= ? AND detail IS NOT NULL").bind(from).all<{ detail: string }>(),
    db
      .prepare("SELECT pipeline, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM llm_calls WHERE ts >= ? GROUP BY pipeline")
      .bind(monthStart(opts.now))
      .all<{ pipeline: string; usd: number; calls: number }>(),
    setting<number | null>("llm_budget_usd", null),
    setting("risk_per_trade_pct", 1),
    db.prepare("SELECT MIN(created_at) AS at FROM signals WHERE status != 'rejected' AND created_at >= ?").bind(from).first<{ at: string | null }>(),
  ]);

  // Утримання BTC: від першого опублікованого сигналу періоду до останньої ціни.
  const startDate = (opts.from ?? firstSignal?.at ?? null)?.slice(0, 10) ?? null;
  const [btcStart, btcEnd] = startDate
    ? await Promise.all([
        db
          .prepare("SELECT close FROM prices_daily WHERE symbol = 'BTCUSDT' AND date <= ? ORDER BY date DESC LIMIT 1")
          .bind(startDate)
          .first<{ close: number }>(),
        db
          .prepare("SELECT json_extract(features, '$.price') AS close FROM snapshots WHERE symbol = 'BTCUSDT' ORDER BY id DESC LIMIT 1")
          .first<{ close: number }>(),
      ])
    : [null, null];

  return computeStats({
    signals: signals.results,
    forecasts: forecasts.results,
    funnel: runs.results.flatMap((r) => {
      try {
        return [JSON.parse(r.detail) as StatsInput["funnel"][number]];
      } catch {
        return [];
      }
    }),
    spend: spend.results,
    budgetUsd: budget,
    riskPct,
    btc: { start: btcStart?.close ?? null, end: btcEnd?.close ?? null },
    from: opts.from,
    to,
  });
}
