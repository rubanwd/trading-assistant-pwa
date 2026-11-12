import type { Side } from "../../shared/risk";

export const SETUPS = ["trend_pullback", "breakout_retest", "liquidity_sweep"] as const;
export type SetupId = (typeof SETUPS)[number];

export const SETUP_NAME: Record<SetupId, string> = {
  trend_pullback: "Відкат у тренді",
  breakout_retest: "Пробій із ретестом",
  liquidity_sweep: "Зняття ліквідності з поверненням",
};

/** Кандидат від детектора: усі рівні порахував код. */
export interface Candidate {
  symbol: string;
  side: Side;
  setup: SetupId;
  entryLow: number;
  entryHigh: number;
  stop: number;
  tp1: number;
  tp2: number | null;
  /** R:R до першої цілі від середини зони входу. */
  rr: number;
  /** Виміри, на яких спрацював детектор; ідуть аналітику як ознаки. */
  facts: Record<string, number>;
}

export type SignalStatus = "pending" | "active" | "tp1" | "tp2" | "stopped" | "expired" | "rejected";
export const OPEN_STATUSES: SignalStatus[] = ["pending", "active"];
