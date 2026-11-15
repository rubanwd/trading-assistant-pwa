/** Розрахунки ризику. Спільні для рушія та застосунку: розмір позиції рахує код, не модель. */

export type Side = "long" | "short";

export interface PositionSize {
  /** Скільки втрачаємо, якщо спрацює стоп, $. */
  riskUsd: number;
  /** Кількість монет. */
  quantity: number;
  /** Обсяг позиції, $. */
  notionalUsd: number;
  /** Відстань до стопа у відсотках від входу. */
  stopDistancePct: number;
}

/**
 * Розмір позиції від ризику на угоду: ризик у $ ділиться на відстань до стопа.
 * null, якщо вхідні дані непридатні (стоп з того ж боку, що й ціль, нульовий депозит тощо).
 */
export function positionSize(depositUsd: number, riskPct: number, entry: number, stop: number): PositionSize | null {
  const distance = Math.abs(entry - stop);
  if (!(depositUsd > 0) || !(riskPct > 0) || !(entry > 0) || !(stop > 0) || distance === 0) return null;
  const riskUsd = (depositUsd * riskPct) / 100;
  const quantity = riskUsd / distance;
  return { riskUsd, quantity, notionalUsd: quantity * entry, stopDistancePct: (distance / entry) * 100 };
}

/** Відношення прибутку до ризику для цілі. */
export function riskReward(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop);
  return risk === 0 ? 0 : Math.abs(target - entry) / risk;
}

/** Відстань до стопа у відсотках від ціни входу. */
export const stopDistancePct = (entry: number, stop: number) => (entry > 0 ? (Math.abs(entry - stop) / entry) * 100 : 0);

/** Середина зони входу: опорна ціна для R:R і результату в R. */
export const entryMid = (entryLow: number, entryHigh: number) => (entryLow + entryHigh) / 2;

/** Хто дає ліквідність: лімітний ордер, що стоїть у стакані (maker), чи ордер, що забирає ліквідність (taker). */
export type Liquidity = "maker" | "taker";

export interface Fill {
  price: number;
  /** Частка позиції, 0..1. */
  share: number;
  kind: Liquidity;
}

/** Комісії біржі у відсотках від обсягу. Binance USDⓈ-M, рівень VIP 0: maker 0.02%, taker 0.05%. */
export interface Fees {
  makerPct: number;
  takerPct: number;
}

/**
 * Комісії в R для позиції з ризиком 1R на одиницю: Σ (ціна × частка × ставка) / |entry − stop|.
 * Вхід — одне виконання на всю позицію; кожен вихід платить ставку свого типу.
 */
export function feeR(entry: Omit<Fill, "share"> | null, stop: number, exits: Fill[], fees: Fees): number {
  if (!entry || !exits.length) return 0;
  const risk = Math.abs(entry.price - stop);
  if (risk === 0) return 0;
  const rate = (kind: Liquidity) => Math.max(0, kind === "maker" ? fees.makerPct : fees.takerPct) / 100;
  const paid = entry.price * rate(entry.kind) + exits.reduce((sum, e) => sum + e.price * e.share * rate(e.kind), 0);
  return Number((paid / risk).toFixed(3));
}
