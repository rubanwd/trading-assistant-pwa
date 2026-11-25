import type { BotMode, TubeConfig } from "../../shared/bots";
import { feeR, type Fees, type Side } from "../../shared/risk";
import { atr, ema, last, rsi } from "../indicators";
import type { Candle } from "../market/types";
import { marketRegime, trend, type MarketRegime, type Trend } from "../regime";
import { round, type TimeframeFeatures } from "../snapshot";

/**
 * Бот High Value Tube. Чисті функції: їх викликають і рушій (паперова торгівля щогодини), і бектест.
 *
 * Щогодини: ознаки кожної монети за свічками 1h (ATR, активність обсягу) і 4h (тренд) → бал руху → 3 найрухливіші
 * монети → по лімітному ордеру в лонг під ціною і в шорт над нею, з тейк-профітом і стопом. Ідея: різкий рух
 * («двіж») доходить до лімітки, а тейк забирає відкат. Невиконані ордери через годину знімаються й ставляться заново.
 * Виконання рахує код за свічками 15m: вхід, коли ціна пройшла лімітку, далі стоп, тейк або закриття за часом.
 */

/** Скільки закритих свічок 1h бере бот: ATR, EMA20 і база обсягу за тиждень. */
export const TUBE_H1_LIMIT = 300;
/** Свічки 4h для тренду й EMA200, як у скані. */
export const TUBE_H4_LIMIT = 498;
/** Активність: обсяг за останні 6 годин до середнього 6-годинного обсягу за попередній тиждень. */
const VOL_RECENT = 6;
const VOL_BASE = 168;
/** Лімітка не ближче 0.25 ATR від ціни: інакше вона виконається одразу, як ринковий ордер. */
export const MIN_GAP_ATR = 0.25;
/** Ордер живе годину: до наступного циклу. */
export const ORDER_TTL_MS = 3_600_000;
const M15 = 15 * 60_000;

/** Ознаки монети на момент циклу. */
export interface TubeFeatures {
  symbol: string;
  /** Закриття останньої свічки 1h. */
  price: number;
  /** Час закриття останньої свічки 1h, мс UTC. */
  closedAt: number;
  /** ATR(14) 1h. */
  atr: number;
  /** ATR у відсотках від ціни: волатильність, порівнянна між монетами. */
  atrPct: number;
  /** EMA(20) 1h: середина «труби». */
  ema20: number;
  rsi: number | null;
  /** Обсяг за 6 год до звичайного 6-годинного обсягу за тиждень; null, якщо історії замало. */
  volRatio: number | null;
  change24hPct: number | null;
  /** Тренд 4h і чи ціна вище EMA200 4h: з них складається напрямок ринку. */
  trend4h: Trend | null;
  above200: boolean | null;
  /** Бал руху: ATR% × √активності. Чим більший, тим помітніший «двіж». */
  score: number;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** Бал руху: волатильність, підсилена або послаблена активністю обсягу (від ×0.5 до ×2). */
export function movementScore(atrPct: number, volRatio: number | null): number {
  const activity = Math.min(4, Math.max(0.25, volRatio ?? 1));
  return Number((atrPct * Math.sqrt(activity)).toFixed(4));
}

/** Ознаки однієї монети. h4 — ознаки 4h (timeframeFeatures), щоб бектест не рахував їх щогодини. null, якщо даних замало. */
export function tubeFeatures(symbol: string, h1: Candle[], h4: TimeframeFeatures | null): TubeFeatures | null {
  const lastCandle = h1[h1.length - 1];
  if (!lastCandle || h1.length < 30 || !(lastCandle.close > 0)) return null;
  const closes = h1.map((c) => c.close);
  const a = last(atr(h1, 14));
  const center = last(ema(closes, 20));
  if (a === null || a <= 0 || center === null) return null;
  let volRatio: number | null = null;
  if (h1.length >= VOL_RECENT + VOL_BASE) {
    const quote = h1.slice(-(VOL_RECENT + VOL_BASE)).map((c) => c.volume * c.close);
    const recent = sum(quote.slice(-VOL_RECENT));
    const base = (sum(quote.slice(0, VOL_BASE)) / VOL_BASE) * VOL_RECENT;
    volRatio = base > 0 ? recent / base : null;
  }
  const atrPct = (a / lastCandle.close) * 100;
  const prev = h1[h1.length - 25];
  return {
    symbol,
    price: lastCandle.close,
    closedAt: lastCandle.closeTime,
    atr: round(a)!,
    atrPct: round(atrPct)!,
    ema20: round(center)!,
    rsi: round(last(rsi(closes, 14))),
    volRatio: round(volRatio),
    change24hPct: prev ? round(((lastCandle.close - prev.close) / prev.close) * 100) : null,
    trend4h: h4 ? trend(h4) : null,
    above200: h4 && h4.ema200 !== null ? h4.close > h4.ema200 : null,
    score: movementScore(atrPct, volRatio),
  };
}

/** За чим ранжувати монети. move — як у боті; решта для досліджень у бектесті. */
export type RankBy = "move" | "atr" | "volume";

/** Монети від найрухливішої. За рівного балу вище більша волатильність. */
export function rankTube(features: TubeFeatures[], by: RankBy = "move"): TubeFeatures[] {
  const key = (f: TubeFeatures) => (by === "atr" ? f.atrPct : by === "volume" ? (f.volRatio ?? 0) : f.score);
  return [...features].sort((a, b) => key(b) - key(a) || b.atrPct - a.atrPct);
}

export type TubeBias = "bull" | "bear" | "neutral";

/**
 * Напрямок ринку: настрій із тренду BTC 4h і частки монет вище EMA200 4h, як у решті застосунку.
 * Ризик-он — бичачий, ризик-оф — ведмежий, інакше нейтральний.
 */
export function tubeMarket(features: TubeFeatures[], leader = "BTCUSDT"): { market: MarketRegime; bias: TubeBias } {
  const btc = features.find((f) => f.symbol === leader);
  const market = marketRegime(btc?.trend4h ?? null, features.map((f) => f.above200));
  return { market, bias: market.mood === "risk_on" ? "bull" : market.mood === "risk_off" ? "bear" : "neutral" };
}

export interface TubeOrderPlan {
  symbol: string;
  side: Side;
  /** Ціна й ATR у момент циклу. */
  price: number;
  atr: number;
  entry: number;
  stop: number;
  target: number;
  /** Відстань лімітки від ціни, ATR. */
  offsetAtr: number;
  bias: TubeBias;
  /** Ближчий з двох ордерів монети (true), дальній (false) або однакові (null, нейтральний ринок). */
  near: boolean | null;
  /** Місце монети в рейтингу руху, від 1. */
  rank: number;
}

/** Чи ордер у бік руху монети: лонг, коли ціна не нижче EMA20 1h, шорт — коли не вище. */
export const withMove = (f: Pick<TubeFeatures, "price" | "ema20">, side: Side) => (side === "long" ? f.price >= f.ema20 : f.price <= f.ema20);

/**
 * Ордери в лонг і шорт для однієї монети. fade: лімітка лонга під ціною, шорта над нею (ловлять різкий рух проти себе);
 * breakout: стоп-ордер лонга над ціною, шорта під нею (входять у бік руху). Ордер, у якого стоп чи вхід вийшли б непридатні,
 * не ставиться. Фільтр «лише в бік руху» (cfg.trendOnly) рахує planCycle.
 */
export function tubeOrders(f: TubeFeatures, bias: TubeBias, cfg: TubeConfig, rank = 1, anchor: "price" | "ema" = "price", mode: BotMode = "fade"): TubeOrderPlan[] {
  const far = cfg.entryAtr * f.atr;
  const near = far / cfg.biasRatio;
  // counter: бичачий ринок — шорт удвічі ближче за лонг, ведмежий — лонг удвічі ближче за шорт.
  const closer: Side | null =
    bias === "neutral" || cfg.biasSide === "off" ? null : (bias === "bull") === (cfg.biasSide === "counter") ? "short" : "long";
  const base = anchor === "ema" ? f.ema20 : f.price;
  const gap = MIN_GAP_ATR * f.atr;
  const out: TubeOrderPlan[] = [];
  for (const side of ["long", "short"] as const) {
    const dir = side === "long" ? 1 : -1;
    const dist = closer === side ? near : far;
    // Ордер завжди з правильного боку від ціни й не ближче за мінімальний відступ: лімітка лонга під ціною, стоп-ордер — над.
    const away = mode === "breakout" ? dir : -dir;
    const raw = base + away * dist;
    const entry = away < 0 ? Math.min(raw, f.price - gap) : Math.max(raw, f.price + gap);
    const risk = Math.max(cfg.stopAtr * f.atr, (entry * cfg.minStopPct) / 100);
    const stop = entry - dir * risk;
    const target = entry + dir * cfg.targetR * risk;
    if (!(entry > 0) || !(stop > 0) || !(target > 0)) continue;
    out.push({
      symbol: f.symbol,
      side,
      price: f.price,
      atr: f.atr,
      entry: round(entry)!,
      stop: round(stop)!,
      target: round(target)!,
      offsetAtr: Number((Math.abs(f.price - entry) / f.atr).toFixed(2)),
      bias,
      near: closer === null ? null : closer === side,
      rank,
    });
  }
  return out;
}

export interface CyclePlan {
  market: MarketRegime;
  bias: TubeBias;
  /** Усі монети від найрухливішої. */
  ranked: TubeFeatures[];
  /** Монети, взяті в цю годину. */
  chosen: string[];
  orders: TubeOrderPlan[];
  /**
   * Що не поставлено й чому: position — по цій монеті й напрямку вже відкрита позиція; slots — ліміт позицій;
   * trend — ордер проти руху монети (фільтр «лише в бік руху»).
   */
  skipped: { symbol: string; side: Side; reason: "position" | "slots" | "trend" }[];
  /** neutral — ринок без напрямку, а фільтр не дозволяє ставити ордери. */
  idle: "neutral" | null;
}

/**
 * План години: напрямок ринку, рейтинг, 3 найрухливіші монети й ордери для них.
 * open — відкриті позиції бота: по монеті й напрямку з позицією новий ордер не ставиться,
 * а кожен новий ордер займає місце в ліміті позицій, ніби вже виконався.
 */
export function planCycle(
  features: TubeFeatures[],
  open: { symbol: string; side: Side }[],
  cfg: TubeConfig,
  opts: { leader?: string; rankBy?: RankBy; anchor?: "price" | "ema"; mode?: BotMode } = {},
): CyclePlan {
  const { market, bias } = tubeMarket(features, opts.leader);
  const ranked = rankTube(features, opts.rankBy);
  const idle = cfg.skipNeutral && bias === "neutral" ? "neutral" : null;
  const chosen = idle ? [] : ranked.slice(0, cfg.pickN);
  const busy = new Set(open.map((o) => `${o.symbol}:${o.side}`));
  let slots = cfg.maxPositions - open.length;
  const orders: TubeOrderPlan[] = [];
  const skipped: CyclePlan["skipped"] = [];
  chosen.forEach((f, i) => {
    for (const o of tubeOrders(f, bias, cfg, i + 1, opts.anchor, opts.mode)) {
      if (cfg.trendOnly && !withMove(f, o.side)) skipped.push({ symbol: o.symbol, side: o.side, reason: "trend" });
      else if (busy.has(`${o.symbol}:${o.side}`)) skipped.push({ symbol: o.symbol, side: o.side, reason: "position" });
      else if (slots <= 0) skipped.push({ symbol: o.symbol, side: o.side, reason: "slots" });
      else {
        orders.push(o);
        slots--;
      }
    }
  });
  return { market, bias, ranked, chosen: chosen.map((f) => f.symbol), orders, skipped, idle };
}

// ── Виконання ──────────────────────────────────────────────────────────────

export interface TubeTrade {
  side: Side;
  entry: number;
  stop: number;
  target: number;
  /** Коли ордер поставлено і коли знято, мс UTC. */
  placedAt: number;
  expiresAt: number;
  maxHoldMs: number;
  /** fade — лімітка (виконується, коли ціна її пройшла); breakout — стоп-ордер (спрацьовує, коли ціна торкнулась). */
  mode?: BotMode;
}

/** pending — лімітка чекає; cancelled — не виконалась і знята; open — позиція; target, stop, timeout — закрита. */
export type TubeStatus = "pending" | "cancelled" | "open" | "target" | "stop" | "timeout";

export interface TubeOutcome {
  status: TubeStatus;
  filledAt: number | null;
  resolvedAt: number | null;
  exitPrice: number | null;
  /** Результат у R без комісій; null, поки позиція відкрита або ордер не виконався. */
  resultR: number | null;
}

/**
 * Паперове виконання за свічками 15m. Ордер виконується лише свічками, що почались після постановки й закрились
 * до зняття. Лімітка — лише коли ціна пройшла її (торкання не рахується: черга в стакані); стоп-ордер — коли ціна
 * торкнулась ціни входу (виконання за нею; проковзування бектест додає окремо). У свічці входу перевіряється лише стоп:
 * порядок цін усередині свічки невідомий, тож тейк у ній не зараховуємо. Далі стоп має перевагу над тейком.
 * Позиція, що прожила maxHold, закривається за останнім закриттям перед терміном.
 */
export function resolveTube(t: TubeTrade, m15: Candle[], now: number): TubeOutcome {
  const long = t.side === "long";
  const dir = long ? 1 : -1;
  const risk = Math.abs(t.entry - t.stop);
  const r = (price: number) => (risk === 0 ? 0 : Number((((price - t.entry) / risk) * dir).toFixed(3)));
  const done = (status: "target" | "stop" | "timeout", price: number, at: number, filledAt: number): TubeOutcome => ({
    status,
    filledAt,
    resolvedAt: at,
    exitPrice: price,
    resultR: status === "stop" ? -1 : r(price),
  });
  let filledAt: number | null = null;
  let lastClose: number | null = null;
  let lastAt: number | null = null;
  for (const c of m15) {
    if (filledAt === null) {
      if (c.openTime < t.placedAt) continue;
      if (c.closeTime >= t.expiresAt) break;
      const hit = t.mode === "breakout" ? (long ? c.high >= t.entry : c.low <= t.entry) : long ? c.low < t.entry : c.high > t.entry;
      if (!hit) continue;
      filledAt = c.openTime;
      if (long ? c.low <= t.stop : c.high >= t.stop) return done("stop", t.stop, c.closeTime, filledAt);
      lastClose = c.close;
      lastAt = c.closeTime;
      continue;
    }
    if (c.openTime >= filledAt + t.maxHoldMs) break;
    if (long ? c.low <= t.stop : c.high >= t.stop) return done("stop", t.stop, c.closeTime, filledAt);
    if (long ? c.high > t.target : c.low < t.target) return done("target", t.target, c.closeTime, filledAt);
    lastClose = c.close;
    lastAt = c.closeTime;
  }
  if (filledAt === null) {
    return now >= t.expiresAt
      ? { status: "cancelled", filledAt: null, resolvedAt: t.expiresAt, exitPrice: null, resultR: null }
      : { status: "pending", filledAt: null, resolvedAt: null, exitPrice: null, resultR: null };
  }
  const deadline = filledAt + t.maxHoldMs;
  // За часом закриваємо, лише коли свічки дійшли до терміну: інакше позиція ще відкрита.
  if (now >= deadline && lastAt !== null && lastAt >= deadline - M15) return done("timeout", lastClose!, lastAt, filledAt);
  return { status: "open", filledAt, resolvedAt: null, exitPrice: null, resultR: null };
}

/**
 * Комісії в R: вхід лімітний (maker) або стоп-ордером за ринком (taker, breakout), тейк лімітний (maker),
 * стоп і закриття за часом за ринком (taker).
 */
export function tubeFeeR(t: Pick<TubeTrade, "entry" | "stop">, status: TubeStatus, exitPrice: number | null, fees: Fees, mode: BotMode = "fade"): number | null {
  if (exitPrice === null || (status !== "target" && status !== "stop" && status !== "timeout")) return null;
  return feeR({ price: t.entry, kind: mode === "breakout" ? "taker" : "maker" }, t.stop, [{ price: exitPrice, share: 1, kind: status === "target" ? "maker" : "taker" }], fees);
}
