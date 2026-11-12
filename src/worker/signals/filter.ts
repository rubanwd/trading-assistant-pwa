import type { MarketMood, SymbolRegime } from "../regime";
import type { Candidate } from "./types";

export const REJECTIONS = ["rr", "regime", "market", "duplicate", "cooldown", "macro", "max_active"] as const;
export type Rejection = (typeof REJECTIONS)[number];

export interface FilterContext {
  minRr: number;
  regime: SymbolRegime;
  mood: MarketMood;
  /** Монети з відкритим сигналом (чекає входу або активний). */
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
 * Сетап має відповідати режиму: відкат лише за трендом 4h і не проти тренду 1d;
 * пробій і зняття ліквідності не проти тренду 4h; жоден сетап не проти настрою ринку.
 */
export function reject(c: Candidate, ctx: FilterContext): Rejection | null {
  if (!(c.rr >= ctx.minRr)) return "rr";
  const withTrend = c.side === "long" ? "up" : "down";
  const against = c.side === "long" ? "down" : "up";
  const { trend, higherTrend } = ctx.regime;
  if (c.setup === "trend_pullback" ? trend !== withTrend || higherTrend === against : trend === against || trend === null) {
    return "regime";
  }
  if (ctx.mood === (c.side === "long" ? "risk_off" : "risk_on")) return "market";
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
