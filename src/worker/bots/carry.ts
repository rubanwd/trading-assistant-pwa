import type { CarryConfig } from "../../shared/bots";

/**
 * Бот «Фандинг-кері» (cash-and-carry). Чисті функції: їх викликають і рушій, і бектест.
 *
 * Позиція — купівля монети на споті й шорт безстрокового контракту на той самий обсяг: зміна ціни взаємно гаситься,
 * дохід — фандинг, який при додатній ставці лонги платять шортам. Раз на добу (00:00 UTC) для кожної монети рахується
 * середня ставка за lookbackDays у % річних. Вхід, коли вона не нижче entryApr; вихід, коли падає нижче exitApr
 * (проміжок між порогами не дає входити й виходити щодня). Позицій не більше maxPositions, кожна — 1/maxPositions
 * капіталу бота. Облік — у % капіталу бота після комісій на обох ногах.
 */

export const DAY_MS = 86_400_000;
export type { CarryConfig } from "../../shared/bots";

export interface FundingEvent {
  at: number;
  /** Фактично нарахована ставка, частка (без зведення до 8 годин). */
  paid: number;
}

/** Фандинг за вікно (from, to] у % річних: сума нарахувань, приведена до 365 діб. null — нарахувань немає. */
export function fundingApr(events: FundingEvent[], from: number, to: number): number | null {
  let sum = 0;
  let n = 0;
  for (const e of events) {
    if (e.at > from && e.at <= to) {
      sum += e.paid;
      n++;
    }
  }
  return n ? (sum * (365 * DAY_MS)) / (to - from) * 100 : null;
}

export interface CarryCandidate {
  symbol: string;
  /** Фандинг за lookbackDays, % річних; null — немає даних. */
  apr: number | null;
}

/**
 * Рішення доби. open — монети з відкритими позиціями; aprOf — ставки для всіх монет із даними (зокрема тих, що
 * випали зі списку: позиція не закривається лише через місце в рейтингу); universe — список, з якого можна входити.
 */
export function planCarry(open: string[], aprOf: Map<string, number | null>, universe: string[], cfg: CarryConfig): { exit: string[]; enter: string[] } {
  const exit = open.filter((s) => {
    const apr = aprOf.get(s);
    return apr === null || apr === undefined || apr < cfg.exitApr;
  });
  const keep = open.filter((s) => !exit.includes(s));
  const free = cfg.maxPositions - keep.length;
  const enter = universe
    .filter((s) => !open.includes(s))
    .map((s) => ({ s, apr: aprOf.get(s) ?? null }))
    .filter((c): c is { s: string; apr: number } => c.apr !== null && c.apr >= cfg.entryApr)
    .sort((a, b) => b.apr - a.apr || a.s.localeCompare(b.s))
    .slice(0, Math.max(0, free))
    .map((c) => c.s);
  return { exit, enter };
}

/** Комісії й проковзування на вхід або вихід, частка обсягу позиції: обидві ноги taker. */
export const carryLegCost = (fees: { spotTakerPct: number; perpTakerPct: number; slippagePct: number }) =>
  (fees.spotTakerPct + fees.perpTakerPct + 2 * fees.slippagePct) / 100;
