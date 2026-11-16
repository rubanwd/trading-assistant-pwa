import { stopDistancePct } from "../../shared/risk";
import type { Candidate } from "./types";

export const REJECTIONS = ["weak", "extended", "stop", "duplicate", "cooldown", "macro", "max_active"] as const;
export type Rejection = (typeof REJECTIONS)[number];

export interface FilterContext {
  /**
   * Стоп не ближче за стільки відсотків від входу. Комісії платяться з обсягу,
   * тож що ближчий стоп, то більша їхня частка в R; 0 вимикає перевірку.
   */
  minStopPct: number;
  /** Монети з відкритим сигналом. */
  openSymbols: Set<string>;
  /** Ключі `symbol|setup|side`, які вже розглядались протягом періоду охолодження. */
  recent: Set<string>;
  /** Хвилин до найближчої макроподії; null, якщо подій попереду немає. */
  minutesToMacro: number | null;
  macroBlackoutHours: number;
  /** Скільки сигналів уже відкрито. */
  openCount: number;
  maxActive: number;
}

/**
 * Пороги якості пробою. Бектест 2023-11 — 2026-10, кожен кандидат окремо, після комісій:
 * - свічка пробою з обсягом нижче середнього або розмахом менше 1 ATR: −0.10R на угоду (решта +0.13R),
 *   мінус в обох половинах періоду;
 * - ціна далі ніж 9 ATR від EMA200: −0.32R, для шортів −0.60R в обох половинах. Це вхід навздогін
 *   після довгого руху, коли стоп уже далеко, а відкат близько.
 */
export const MIN_VOLUME_RATIO = 1;
export const MIN_CANDLE_RANGE_ATR = 1;
export const MAX_EMA200_DISTANCE_ATR = 9;

export const candidateKey = (c: Pick<Candidate, "symbol" | "setup" | "side">) => `${c.symbol}|${c.setup}|${c.side}`;

/**
 * Фільтр до моделі. Повертає причину відмови або null, якщо кандидат проходить.
 * Напрям тренду (EMA200 на 4h) перевіряє вже детектор; додаткові фільтри режиму й настрою ринку
 * бектест не підтвердив, тож їх тут немає.
 */
export function reject(c: Candidate, ctx: FilterContext): Rejection | null {
  const f = c.facts;
  if ((f.volume_ratio ?? Infinity) < MIN_VOLUME_RATIO || (f.candle_range_atr ?? Infinity) < MIN_CANDLE_RANGE_ATR) return "weak";
  if ((f.ema200_distance_atr ?? 0) >= MAX_EMA200_DISTANCE_ATR) return "extended";
  if (stopDistancePct(c.entry, c.stop) < ctx.minStopPct) return "stop";
  if (ctx.openSymbols.has(c.symbol)) return "duplicate";
  if (ctx.recent.has(candidateKey(c))) return "cooldown";
  if (ctx.minutesToMacro !== null && ctx.minutesToMacro <= ctx.macroBlackoutHours * 60) return "macro";
  if (ctx.openCount >= ctx.maxActive) return "max_active";
  return null;
}

/**
 * Кого з тих, що пройшли фільтр, показати моделі: один кандидат на монету, спершу найсильніші пробої,
 * не більше ліміту за скан. Рушій і бектест вибирають однаково.
 */
export function shortlist<T extends Candidate>(passed: T[], limit: number): T[] {
  const ranked = [...passed].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
  return ranked.filter((c, i) => ranked.findIndex((x) => x.symbol === c.symbol) === i).slice(0, Math.max(0, limit));
}

/** Хвилин до найближчої майбутньої макроподії зі списку в налаштуваннях. */
export function minutesToMacro(events: unknown, now: number): number | null {
  if (!Array.isArray(events)) return null;
  const ahead = events
    .map((e) => Date.parse(typeof e === "string" ? e : String((e as { at?: unknown })?.at)))
    .filter((t) => Number.isFinite(t) && t >= now);
  return ahead.length ? Math.round((Math.min(...ahead) - now) / 60_000) : null;
}
