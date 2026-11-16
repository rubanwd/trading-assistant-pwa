import { stopDistancePct } from "../../shared/risk";
import type { Candidate } from "./types";

export const REJECTIONS = ["stop", "duplicate", "cooldown", "macro", "max_active"] as const;
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

export const candidateKey = (c: Pick<Candidate, "symbol" | "setup" | "side">) => `${c.symbol}|${c.setup}|${c.side}`;

/**
 * Фільтр до моделі. Повертає причину відмови або null, якщо кандидат проходить.
 * Напрям тренду (EMA200 на 4h) перевіряє вже детектор; додаткові фільтри режиму й настрою ринку
 * бектест не підтвердив, тож їх тут немає.
 */
export function reject(c: Candidate, ctx: FilterContext): Rejection | null {
  if (stopDistancePct(c.entry, c.stop) < ctx.minStopPct) return "stop";
  if (ctx.openSymbols.has(c.symbol)) return "duplicate";
  if (ctx.recent.has(candidateKey(c))) return "cooldown";
  if (ctx.minutesToMacro !== null && ctx.minutesToMacro <= ctx.macroBlackoutHours * 60) return "macro";
  if (ctx.openCount >= ctx.maxActive) return "max_active";
  return null;
}

/** Хвилин до найближчої майбутньої макроподії зі списку в налаштуваннях. */
export function minutesToMacro(events: unknown, now: number): number | null {
  if (!Array.isArray(events)) return null;
  const ahead = events
    .map((e) => Date.parse(typeof e === "string" ? e : String((e as { at?: unknown })?.at)))
    .filter((t) => Number.isFinite(t) && t >= now);
  return ahead.length ? Math.round((Math.min(...ahead) - now) / 60_000) : null;
}
