import type { MomentumConfig } from "../../shared/bots";
import type { Side } from "../../shared/risk";
import type { Candle } from "../market/types";

/**
 * Бот «Імпульс між монетами» (крос-секційний моментум). Чисті функції: їх викликають і рушій, і бектест.
 *
 * Раз на тиждень (понеділок, 00:00 UTC) монети списку ранжуються за доходністю за lookbackDays завершених діб.
 * Лонг legs найсильніших, шорт legs найслабших. Лонги разом — половина капіталу бота, шорти — друга половина
 * (валова експозиція 1×, чиста 0). Позиції тримаються тиждень, потім перебалансування до нових цільових часток.
 * Стопів і тейків немає: ризик обмежує розподіл на 2 × legs монет і щотижневе перебалансування.
 * Облік — у % капіталу бота, а не в R: без стопа одиниці ризику немає.
 */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export type { MomentumConfig, MomentumWeighting } from "../../shared/bots";

export interface MomentumInput {
  symbol: string;
  /** Денні свічки, що вже закрились, підряд, остання — доба перед перебалансуванням. */
  daily: Candle[];
}

export interface MomentumRank {
  symbol: string;
  /** Доходність за lookbackDays, частка. */
  momentum: number;
  /** Стандартне відхилення денних доходностей за volDays, частка. */
  vol: number;
}

export interface MomentumLeg extends MomentumRank {
  side: Side;
  /** Частка капіталу бота за модулем; сума за кожною стороною — 0.5. */
  weight: number;
}

function consecutive(candles: Candle[]): boolean {
  for (let i = 1; i < candles.length; i++) if (candles[i]!.openTime - candles[i - 1]!.openTime !== DAY_MS) return false;
  return true;
}

/** Імпульс і волатильність монети. null — замало послідовних свічок. */
export function momentumRank(input: MomentumInput, cfg: Pick<MomentumConfig, "lookbackDays" | "volDays">): MomentumRank | null {
  const need = Math.max(cfg.lookbackDays, cfg.volDays) + 1;
  if (input.daily.length < need) return null;
  const w = input.daily.slice(-need);
  if (!consecutive(w)) return null;
  const last = w[w.length - 1]!.close;
  const base = w[w.length - 1 - cfg.lookbackDays]!.close;
  if (!(last > 0 && base > 0)) return null;
  const rets: number[] = [];
  for (let i = w.length - cfg.volDays; i < w.length; i++) rets.push(w[i]!.close / w[i - 1]!.close - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  return { symbol: input.symbol, momentum: last / base - 1, vol };
}

/**
 * Цільові позиції тижня. Монет із придатною історією має бути щонайменше 2 × legs, інакше позицій немає.
 * ranked — усі монети від найсильнішої до найслабшої (для пояснення в застосунку).
 */
export function planMomentum(inputs: MomentumInput[], cfg: MomentumConfig): { ranked: MomentumRank[]; legs: MomentumLeg[] } {
  const ranked = inputs
    .map((i) => momentumRank(i, cfg))
    .filter((r): r is MomentumRank => r !== null)
    .sort((a, b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol));
  if (ranked.length < 2 * cfg.legs) return { ranked, legs: [] };
  const side = (rs: MomentumRank[], s: Side): MomentumLeg[] => {
    const raw = rs.map((r) => (cfg.weighting === "vol" && r.vol > 0 ? 1 / r.vol : 1));
    const sum = raw.reduce((a, b) => a + b, 0);
    return rs.map((r, i) => ({ ...r, side: s, weight: Number(((0.5 * raw[i]!) / sum).toFixed(6)) }));
  };
  return { ranked, legs: [...side(ranked.slice(0, cfg.legs), "long"), ...side(ranked.slice(-cfg.legs), "short")] };
}

/** Понеділок 00:00 UTC тижня, якому належить момент ts. */
export function weekStart(ts: number): number {
  const day = Math.floor(ts / DAY_MS);
  // 1970-01-01 — четвер: (day + 3) % 7 — номер дня від понеділка.
  return (day - ((day + 3) % 7)) * DAY_MS;
}

/** Знакова частка: лонг +, шорт −. */
export const signed = (leg: { side: Side; weight: number }) => (leg.side === "long" ? leg.weight : -leg.weight);

/**
 * Обіг перебалансування в частках капіталу: Σ |нова знакова частка − стара знакова частка після руху цін|.
 * drifted — позиції минулого тижня, переоцінені за цінами виходу.
 */
export function turnover(drifted: Map<string, number>, target: Map<string, number>): number {
  let sum = 0;
  for (const s of new Set([...drifted.keys(), ...target.keys()])) sum += Math.abs((target.get(s) ?? 0) - (drifted.get(s) ?? 0));
  return sum;
}

/** Фандинг за позицію зі знаковою часткою w за нарахування в (from, to]: лонг платить додатну ставку, шорт отримує. */
export function legFunding(w: number, events: { at: number; paid: number }[], from: number, to: number): number {
  let sum = 0;
  for (const e of events) if (e.at > from && e.at <= to) sum -= w * e.paid;
  return sum;
}
