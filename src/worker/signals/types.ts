import type { Side } from "../../shared/risk";

export const SETUPS = ["trend_breakout"] as const;
export type SetupId = (typeof SETUPS)[number];

export const SETUP_NAME: Record<SetupId, string> = {
  trend_breakout: "Трендовий пробій 4h",
};

/** Кандидат від детектора: усі рівні порахував код. */
export interface Candidate {
  symbol: string;
  side: Side;
  setup: SetupId;
  /** Ціна входу за ринком: закриття свічки пробою. */
  entry: number;
  /** Початковий стоп; далі позицію веде вихід за каналом. */
  stop: number;
  /** Сила пробою від 0 до 100: за нею кандидати впорядковуються перед моделлю. */
  quality: number;
  /** Виміри, на яких спрацював детектор; ідуть аналітику як ознаки. */
  facts: Record<string, number>;
}

/**
 * active — позиція відкрита; stopped — закрита стопом; exited — закрита виходом за каналом або за часом;
 * rejected — модель відхилила кандидата (його супровід іде в тіні).
 */
export type SignalStatus = "active" | "stopped" | "exited" | "rejected";
export const OPEN_STATUSES: SignalStatus[] = ["active"];
