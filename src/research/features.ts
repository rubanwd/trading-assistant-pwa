import { atr, ema, rsi } from "../worker/indicators";
import type { Candle } from "../worker/market/types";
import type { FundingPoint, MetricPoint } from "./data";

/**
 * Ознаки на кожному закритті свічки 4h і що сталося з ціною далі. Рахує код; видно лише те, що вже було відомо на момент `t`.
 * Кожна ознака переводиться в перцентиль у власній історії монети за останні 180 днів: «високий відкритий інтерес»
 * для ETH і для APT означає різні абсолютні числа, а відносна мірка однакова і для Binance, і для Bybit.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const FEATURES = [
  "ret_24h",
  "ret_7d",
  "rsi_4h",
  "ema200_dist",
  "atr_pct",
  "volume_24h",
  "oi_chg_24h",
  "oi_vs_30d",
  "funding",
  "top_lsr",
  "lsr",
  "taker_24h",
  "btc_ret_7d",
] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABEL: Record<Feature, string> = {
  ret_24h: "зміна ціни за 24 год",
  ret_7d: "зміна ціни за 7 днів",
  rsi_4h: "RSI 4h",
  ema200_dist: "відстань від EMA200 4h",
  atr_pct: "волатильність (ATR 4h, %)",
  volume_24h: "обсяг за 24 год до середнього за 30 днів",
  oi_chg_24h: "зміна відкритого інтересу за 24 год",
  oi_vs_30d: "відкритий інтерес до середнього за 30 днів",
  funding: "фандинг",
  top_lsr: "лонги/шорти топ-трейдерів (позиції)",
  lsr: "лонги/шорти рахунків",
  taker_24h: "ринкові купівлі/продажі за 24 год",
  btc_ret_7d: "зміна BTC за 7 днів",
};

/** Ознаки, що мають напрям: для шорта «високе» значення означає «проти шорта». Потрібно для розбору пробоїв. */
export const DIRECTIONAL: ReadonlySet<Feature> = new Set<Feature>([
  "ret_24h", "ret_7d", "rsi_4h", "ema200_dist", "funding", "top_lsr", "lsr", "taker_24h", "btc_ret_7d", "oi_chg_24h",
]);

export const BINS = 5;
export const BIN_LABEL = ["нижні 20%", "20–40%", "середина", "60–80%", "верхні 20%"];

/** Перцентиль у вікні з останніх 180 днів (1080 свічок 4h); не менше 45 днів історії. */
export const RANK_WINDOW = 1080;
export const RANK_MIN = 270;

export interface ResearchSymbol {
  symbol: string;
  h1: Candle[];
  h4: Candle[];
  metrics: MetricPoint[];
  funding: FundingPoint[];
}

export interface Outcome {
  /**
   * Рух ціни в одиницях ATR 4h за горизонт з бар'єрами ±1 ATR: +1 — ціна спершу пройшла +1 ATR, −1 — спершу −1 ATR,
   * 0 — обидва в одній годинній свічці (порядок невідомий), інакше зміна до кінця горизонту.
   */
  move: number;
  /** Угода лонг або шорт за ринком зі стопом і ціллю 1 ATR, R після комісій; в одній свічці обидва бар'єри — стоп. */
  longNet: number;
  shortNet: number;
}

export interface Row extends Outcome {
  symbol: string;
  /** Момент після закриття свічки 4h, мс UTC. */
  t: number;
  raw: (number | null)[];
  /** Квінтиль 0..4 для кожної ознаки або −1, якщо ознаки немає. */
  bins: Int8Array;
}

/** Індекс першого елемента з ключем більше за `t` (масив упорядковано). */
function upper<T>(arr: T[], key: (x: T) => number, t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid]!) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const finite = (v: number | null): number | null => (v !== null && Number.isFinite(v) ? v : null);

/**
 * Результат на горизонті `horizonHours` за свічками 1h після `t` з входом `entry` і одиницею руху `unit` (ATR).
 * null, якщо даних до кінця горизонту немає, а бар'єр не зачеплено.
 */
export function outcome(h1: Candle[], t: number, entry: number, unit: number, horizonHours: number, takerPct: number): Outcome | null {
  if (!(unit > 0) || !(entry > 0)) return null;
  const fee = (2 * takerPct) / ((unit / entry) * 100);
  const end = t + horizonHours * HOUR;
  const up = entry + unit;
  const dn = entry - unit;
  let last: Candle | null = null;
  for (let i = upper(h1, (c) => c.openTime, t - 1); i < h1.length; i++) {
    const c = h1[i]!;
    if (c.openTime >= end) break;
    const hitUp = c.high >= up;
    const hitDn = c.low <= dn;
    if (hitUp && hitDn) return { move: 0, longNet: -1 - fee, shortNet: -1 - fee };
    if (hitUp) return { move: 1, longNet: 1 - fee, shortNet: -1 - fee };
    if (hitDn) return { move: -1, longNet: -1 - fee, shortNet: 1 - fee };
    last = c;
  }
  if (!last || last.closeTime < end - 1 - HOUR) return null;
  const move = (last.close - entry) / unit;
  return { move, longNet: move - fee, shortNet: -move - fee };
}

/** Перцентиль кожного значення серед останніх `window` значень серії (включно з ним); null — немає значення або мало історії. */
export function trailingRanks(values: (number | null)[], window = RANK_WINDOW, min = RANK_MIN): (number | null)[] {
  const sorted: number[] = [];
  const lower = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const upperB = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return values.map((v, i) => {
    const leaving = i >= window ? values[i - window] : null;
    if (leaving !== null && leaving !== undefined) sorted.splice(lower(leaving), 1);
    if (v === null) return null;
    sorted.splice(lower(v), 0, v);
    if (sorted.length < min) return null;
    const lo = lower(v);
    return (lo + (upperB(v) - lo) / 2) / sorted.length;
  });
}

export const toBin = (rank: number | null): number => (rank === null ? -1 : Math.min(BINS - 1, Math.floor(rank * BINS)));

/** Зміна BTC за 7 днів на кожне закриття 4h: спільна ознака ринку. */
export function btcReturns(btcH4: Candle[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 42; i < btcH4.length; i++) out.set(btcH4[i]!.closeTime + 1, btcH4[i]!.close / btcH4[i - 42]!.close - 1);
  return out;
}

/** Сирі ознаки на кожному закритті 4h. Порядок значень як у FEATURES. */
export function rawFeatures(s: ResearchSymbol, btc: Map<number, number>): { t: number; index: number; raw: (number | null)[] }[] {
  const h4 = s.h4;
  const closes = h4.map((c) => c.close);
  const atr14 = atr(h4, 14);
  const ema200 = ema(closes, 200);
  const rsi14 = rsi(closes, 14);
  const volPrefix = [0];
  for (const c of h4) volPrefix.push(volPrefix[volPrefix.length - 1]! + c.volume);

  const m = s.metrics;
  const oiPrefix = [0];
  const takerPrefix = [0];
  const takerCount = [0];
  for (const p of m) {
    oiPrefix.push(oiPrefix[oiPrefix.length - 1]! + p.oi);
    takerPrefix.push(takerPrefix[takerPrefix.length - 1]! + (p.taker ?? 0));
    takerCount.push(takerCount[takerCount.length - 1]! + (p.taker === null ? 0 : 1));
  }
  const at = (p: MetricPoint) => p.at;
  /** Остання точка метрик, відома на момент `t`, не старша за 2 години. */
  const pointAt = (t: number): number | null => {
    const i = upper(m, at, t) - 1;
    return i >= 0 && t - m[i]!.at <= 2 * HOUR ? i : null;
  };

  const out: { t: number; index: number; raw: (number | null)[] }[] = [];
  for (let i = 42; i < h4.length; i++) {
    const c = h4[i]!;
    const t = c.closeTime + 1;
    const close = c.close;
    const a = atr14[i]!;
    const e200 = ema200[i]!;
    const vol30d = (volPrefix[i + 1]! - volPrefix[Math.max(0, i + 1 - 180)]!) / 30;
    const vol24h = volPrefix[i + 1]! - volPrefix[i + 1 - 6]!;

    const cur = pointAt(t);
    const prev = pointAt(t - DAY);
    let oiChg: number | null = null;
    let oiVs30: number | null = null;
    let taker: number | null = null;
    let topLsr: number | null = null;
    let lsr: number | null = null;
    if (cur !== null) {
      const p = m[cur]!;
      topLsr = p.topLsr;
      lsr = p.lsr;
      if (prev !== null && prev !== cur) oiChg = p.oi / m[prev]!.oi - 1;
      const from30 = upper(m, at, t - 30 * DAY);
      const n30 = cur + 1 - from30;
      if (n30 >= 600) oiVs30 = p.oi / ((oiPrefix[cur + 1]! - oiPrefix[from30]!) / n30) - 1;
      const from24 = upper(m, at, t - DAY);
      const nt = takerCount[cur + 1]! - takerCount[from24]!;
      if (nt >= 18) taker = (takerPrefix[cur + 1]! - takerPrefix[from24]!) / nt;
    }
    const fi = upper(s.funding, (f) => f.at, t) - 1;
    const funding = fi >= 0 && t - s.funding[fi]!.at <= 12 * HOUR ? s.funding[fi]!.rate : null;

    const raw: Record<Feature, number | null> = {
      ret_24h: close / h4[i - 6]!.close - 1,
      ret_7d: close / h4[i - 42]!.close - 1,
      rsi_4h: finite(rsi14[i]!),
      ema200_dist: Number.isFinite(e200) ? close / e200 - 1 : null,
      atr_pct: Number.isFinite(a) ? a / close : null,
      volume_24h: i >= 180 && vol30d > 0 ? vol24h / vol30d : null,
      oi_chg_24h: oiChg,
      oi_vs_30d: oiVs30,
      funding,
      top_lsr: topLsr,
      lsr,
      taker_24h: taker,
      btc_ret_7d: btc.get(t) ?? null,
    };
    out.push({ t, index: i, raw: FEATURES.map((f) => finite(raw[f])) });
  }
  return out;
}

/** Рядки дослідження для монети: ознаки, квінтилі й результат. Рядки без результату відкидаються. */
/** `barrier` — ширина бар'єрів і одиниця руху в ATR 4h (1 — стоп і ціль 1 ATR). */
export function buildRows(s: ResearchSymbol, btc: Map<number, number>, horizonHours: number, takerPct: number, barrier = 1): Row[] {
  const feats = rawFeatures(s, btc);
  const ranks = FEATURES.map((_, k) => trailingRanks(feats.map((f) => f.raw[k]!)));
  const atr14 = atr(s.h4, 14);
  const rows: Row[] = [];
  feats.forEach((f, j) => {
    const c = s.h4[f.index]!;
    // Торгів не було (технічна перерва або делістинг): ATR згасає, і комісія в R росте без меж.
    if (!(c.volume > 0) || !(atr14[f.index]! / c.close >= 0.001)) return;
    const o = outcome(s.h1, f.t, c.close, atr14[f.index]! * barrier, horizonHours, takerPct);
    if (!o) return;
    const bins = new Int8Array(FEATURES.length);
    for (let k = 0; k < FEATURES.length; k++) bins[k] = toBin(ranks[k]![j]!);
    rows.push({ symbol: s.symbol, t: f.t, raw: f.raw, bins, ...o });
  });
  return rows;
}
