import type { TrendBasketConfig } from "../../shared/bots";
import type { Candle } from "../market/types";

/**
 * Трендовий кошик (часовий моментум із цільовою волатильністю). Чисті функції для бектесту й, за потреби, рушія.
 * Раз на добу (00:00 UTC) для кожної монети списку: закриття вище простої середньої за smaDays — лонг, інакше без позиції
 * (або шорт, якщо sides = both). Частка капіталу обернено пропорційна волатильності монети, щоб кожна вносила однаковий
 * ризик: (1/topN) × targetVol / σ, не більше 2/topN; сума часток не більше 1 (без плеча).
 */

export const DAY_MS = 86_400_000;

export interface TrendInput {
  symbol: string;
  /** Завершені денні свічки підряд, остання — доба перед рішенням. */
  daily: Candle[];
}

export interface TrendState {
  symbol: string;
  close: number;
  sma: number;
  /** Річна волатильність, частка. */
  vol: number;
  /** Знак позиції: 1 лонг, −1 шорт, 0 без позиції. */
  dir: -1 | 0 | 1;
}

function consecutive(c: Candle[]): boolean {
  for (let i = 1; i < c.length; i++) if (c[i]!.openTime - c[i - 1]!.openTime !== DAY_MS) return false;
  return true;
}

export function trendState(input: TrendInput, cfg: Pick<TrendBasketConfig, "smaDays" | "volDays" | "sides">): TrendState | null {
  const need = Math.max(cfg.smaDays, cfg.volDays + 1);
  if (input.daily.length < need) return null;
  const w = input.daily.slice(-need);
  if (!consecutive(w)) return null;
  const closes = w.map((c) => c.close);
  const close = closes[closes.length - 1]!;
  // smaDays = 0 — без сигналу, завжди лонг (для порівняння з простим утриманням).
  const sma = cfg.smaDays ? closes.slice(-cfg.smaDays).reduce((s, x) => s + x, 0) / cfg.smaDays : 0;
  const rets: number[] = [];
  for (let i = closes.length - cfg.volDays; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1)) * Math.sqrt(365);
  if (!(close > 0) || !(vol > 0)) return null;
  const dir: -1 | 0 | 1 = close > sma ? 1 : cfg.sides === "both" && close < sma ? -1 : 0;
  return { symbol: input.symbol, close, sma, vol, dir };
}

/** Цільові знакові частки капіталу. Монети без даних отримують 0. */
export function trendTargets(states: TrendState[], cfg: TrendBasketConfig): Map<string, number> {
  const raw = states.map((s) => [s.symbol, s.dir * Math.min(2 / cfg.topN, (1 / cfg.topN) * (cfg.targetVol / s.vol))] as const);
  const gross = raw.reduce((sum, [, w]) => sum + Math.abs(w), 0);
  const k = gross > 1 ? 1 / gross : 1;
  return new Map(raw.map(([s, w]) => [s, w * k]));
}

/**
 * Нова позиція з урахуванням смуги: позиція міняється, лише коли змінився знак, ціль нульова або ціль відійшла від
 * поточної більше ніж на band від цілі. Інакше лишається як є.
 */
export function withBand(current: number, target: number, band: number): number {
  if (target === 0 || current === 0 || Math.sign(target) !== Math.sign(current)) return target;
  return Math.abs(target - current) > band * Math.abs(target) ? target : current;
}
