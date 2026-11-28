/**
 * Публічні ринкові метрики ф'ючерсів Binance з архіву data.binance.vision: відкритий інтерес,
 * співвідношення лонгів і шортів, ринкові купівлі до продажів (щоденні файли з кроком 5 хв) і фандинг (місячні файли).
 * Лише публічні дані без ключів.
 */

const HOUR = 3_600_000;

export const METRICS_ARCHIVE = "https://data.binance.vision/data/futures/um/daily/metrics";
export const FUNDING_ARCHIVE = "https://data.binance.vision/data/futures/um/monthly/fundingRate";

export const metricsUrl = (symbol: string, day: string) => `${METRICS_ARCHIVE}/${symbol}/${symbol}-metrics-${day}.zip`;
export const fundingUrl = (symbol: string, month: string) => `${FUNDING_ARCHIVE}/${symbol}/${symbol}-fundingRate-${month}.zip`;

/** Стан ринку монети наприкінці години. */
export interface MetricPoint {
  /** Коли значення вже відоме: кінець години, мс UTC. */
  at: number;
  /** Відкритий інтерес у контрактах (базова монета). */
  oi: number;
  /** Відкритий інтерес у USDT. */
  oiUsd: number;
  /** Співвідношення лонгів до шортів за позиціями топ-трейдерів. */
  topLsr: number | null;
  /** Співвідношення рахунків у лонгах до рахунків у шортах. */
  lsr: number | null;
  /** Середнє за годину співвідношення ринкових купівель до продажів. */
  taker: number | null;
}

export interface FundingPoint {
  /** Час нарахування, мс UTC. */
  at: number;
  /** Ставка, зведена до 8-годинного інтервалу, частка. */
  rate: number;
  /** Ставка, фактично нарахована в цей момент (без зведення до 8 годин), частка. */
  paid?: number;
}

/** Дні YYYY-MM-DD місяця YYYY-MM. */
export function daysOf(month: string): string[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Час з архіву: «2024-03-01 00:05:00» (UTC) або мілісекунди. */
function parseTime(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d{12,}$/.test(s)) return Number(s);
  const t = Date.parse(s.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : null;
}

/**
 * CSV метрик (create_time, symbol, sum_open_interest, sum_open_interest_value, count_toptrader_long_short_ratio,
 * sum_toptrader_long_short_ratio, count_long_short_ratio, sum_taker_long_short_vol_ratio) → годинні точки.
 * Відкритий інтерес і співвідношення беруться з останнього запису години, купівлі до продажів усереднюються.
 */
export function parseMetrics(csv: string): MetricPoint[] {
  const hours = new Map<number, { last: number; point: MetricPoint; takerSum: number; takerN: number }>();
  for (const line of csv.split("\n")) {
    const f = line.split(",");
    const ts = parseTime(f[0]);
    const oi = num(f[2]);
    const oiUsd = num(f[3]);
    if (ts === null || oi === null || oiUsd === null || oi <= 0) continue;
    const hour = Math.floor(ts / HOUR) * HOUR;
    const taker = num(f[7]);
    let h = hours.get(hour);
    if (!h) {
      h = { last: -1, point: { at: hour + HOUR, oi, oiUsd, topLsr: null, lsr: null, taker: null }, takerSum: 0, takerN: 0 };
      hours.set(hour, h);
    }
    if (ts >= h.last) {
      h.last = ts;
      h.point.oi = oi;
      h.point.oiUsd = oiUsd;
      h.point.topLsr = num(f[5]);
      h.point.lsr = num(f[6]);
    }
    if (taker !== null && taker > 0) {
      h.takerSum += taker;
      h.takerN++;
    }
  }
  return [...hours.values()]
    .map((h) => ({ ...h.point, taker: h.takerN ? h.takerSum / h.takerN : null }))
    .sort((a, b) => a.at - b.at);
}

/** Годинні точки в компактний CSV кешу і назад. */
export function metricsToCsv(points: MetricPoint[]): string {
  return points.map((p) => [p.at, p.oi, p.oiUsd, p.topLsr ?? "", p.lsr ?? "", p.taker ?? ""].join(",")).join("\n") + "\n";
}

export function metricsFromCsv(csv: string): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (const line of csv.split("\n")) {
    const f = line.split(",");
    const at = num(f[0]);
    const oi = num(f[1]);
    const oiUsd = num(f[2]);
    if (at === null || oi === null || oiUsd === null) continue;
    out.push({ at, oi, oiUsd, topLsr: num(f[3]), lsr: num(f[4]), taker: num(f[5]) });
  }
  return out;
}

/** CSV фандингу (calc_time, funding_interval_hours, last_funding_rate); ставка зводиться до 8 годин. */
export function parseFunding(csv: string): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (const line of csv.split("\n")) {
    const f = line.split(",");
    const at = parseTime(f[0]);
    const interval = num(f[1]);
    const rate = num(f[2]);
    if (at === null || rate === null || interval === null || interval <= 0) continue;
    out.push({ at, rate: (rate * 8) / interval, paid: rate });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Склеює частини, прибирає дублікати за часом і впорядковує. */
export function mergeByTime<T extends { at: number }>(parts: T[][]): T[] {
  const byTime = new Map<number, T>();
  for (const part of parts) for (const p of part) byTime.set(p.at, p);
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}
