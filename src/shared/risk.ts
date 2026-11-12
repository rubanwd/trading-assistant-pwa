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

/** Середина зони входу: опорна ціна для R:R і результату в R. */
export const entryMid = (entryLow: number, entryHigh: number) => (entryLow + entryHigh) / 2;

/**
 * Комісії в R: вхід і кожен вихід платять feePctPerSide від обсягу.
 * Для позиції з ризиком 1R на одиницю: (entry + Σ exit × share) × fee / |entry − stop|.
 */
export function feeR(entry: number, stop: number, exits: { price: number; share: number }[], feePctPerSide: number): number {
  const risk = Math.abs(entry - stop);
  if (risk === 0 || !exits.length || !(feePctPerSide > 0)) return 0;
  const turnover = entry + exits.reduce((sum, e) => sum + e.price * e.share, 0);
  return Number(((turnover * feePctPerSide) / 100 / risk).toFixed(3));
}
