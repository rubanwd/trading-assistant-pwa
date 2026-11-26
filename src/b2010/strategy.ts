/**
 * Правила пробою 20/10 на денних свічках UTC. Чисті функції: їх викликають бектест, paper, testnet і live.
 */
import { ceilToStep, dmax, dmin, floorToStep, type Dec } from "./decimal";
import type { Candle, Side } from "./types";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
/** Канал входу: найбільший High / найменший Low попередніх 20 днів (без свічки сигналу). */
export const ENTRY_LOOKBACK = 20;
/** Канал стопа: останні 10 завершених днів, разом зі свічкою сигналу. */
export const STOP_LOOKBACK = 10;

export const dayStart = (ts: number) => Math.floor(ts / DAY_MS) * DAY_MS;
export const isoDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** Чи йдуть свічки підряд без пропусків і повторів із кроком step. */
export function consecutive(candles: Candle[], step = DAY_MS): boolean {
  for (let i = 1; i < candles.length; i++) if (candles[i].openTime - candles[i - 1].openTime !== step) return false;
  return true;
}

export type EntryEvaluation =
  | { kind: "insufficient"; reason: string }
  | { kind: "none"; day: number; close: Dec; upper: Dec; lower: Dec }
  | { kind: "signal"; side: Side; day: number; close: Dec; upper: Dec; lower: Dec };

/**
 * Сигнал на свічці t, що щойно закрилася (остання в candles).
 * upper20/lower20 — з t-20…t-1; свічка t у межі не входить. Потрібна 21 послідовна завершена свічка.
 * Вхід лише за строгим закриттям за межею: рівність, дотик або пробій тінню сигналу не дають.
 */
export function evaluateEntry(candles: Candle[], lookback = ENTRY_LOOKBACK): EntryEvaluation {
  if (candles.length < lookback + 1) return { kind: "insufficient", reason: `потрібно ${lookback + 1} свічок, є ${candles.length}` };
  const window = candles.slice(-(lookback + 1));
  if (!consecutive(window)) return { kind: "insufficient", reason: "пропуск у денних свічках" };
  const t = window[lookback];
  const prior = window.slice(0, lookback);
  let upper = prior[0].high;
  let lower = prior[0].low;
  for (const c of prior) {
    upper = dmax(upper, c.high);
    lower = dmin(lower, c.low);
  }
  const base = { day: t.openTime, close: t.close, upper, lower };
  if (t.close.gt(upper)) return { kind: "signal", side: "long", ...base };
  if (t.close.lt(lower)) return { kind: "signal", side: "short", ...base };
  return { kind: "none", ...base };
}

/**
 * Рівень каналу стопа з останніх STOP_LOOKBACK завершених свічок: лонг — найменший Low, шорт — найбільший High.
 * null, якщо свічок замало або є пропуск.
 */
export function channelStop(candles: Candle[], side: Side, lookback = STOP_LOOKBACK): Dec | null {
  if (candles.length < lookback) return null;
  const window = candles.slice(-lookback);
  if (!consecutive(window)) return null;
  let level = side === "long" ? window[0].low : window[0].high;
  for (const c of window) level = side === "long" ? dmin(level, c.low) : dmax(level, c.high);
  return level;
}

/** Стоп до кроку ціни: лонг — вниз, шорт — угору (не ближче до ціни, ніж канал). */
export const roundStop = (side: Side, stop: Dec, tick: Dec): Dec => (side === "long" ? floorToStep(stop, tick) : ceilToStep(stop, tick));

/** Стоп рухається лише в бік зменшення ризику: лонг — max, шорт — min. */
export const trailStop = (side: Side, current: Dec, candidate: Dec): Dec => (side === "long" ? dmax(current, candidate) : dmin(current, candidate));

/** Чи послаблює новий стоп чинний (заборонено). */
export const loosens = (side: Side, current: Dec, next: Dec): boolean => (side === "long" ? next.lt(current) : next.gt(current));

/** Спрацювання стопа за ціною: лонг — ціна ≤ стопа, шорт — ціна ≥ стопа. */
export const stopReached = (side: Side, stop: Dec, price: Dec): boolean => (side === "long" ? price.lte(stop) : price.gte(stop));
