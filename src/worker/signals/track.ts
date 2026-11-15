import type { Fill, Liquidity, Side } from "../../shared/risk";
import type { Candle } from "../market/types";
import { EXIT_BARS } from "./detectors";

/**
 * Супровід сигналу. Стан щоразу відтворюється зі свічок від моменту створення, тож курсор не потрібен.
 * Свічки 1h: кеш тримає 500 штук, тобто ~20 днів, а трендова позиція може жити тижнями.
 */

export interface TrackedSignal {
  side: Side;
  /** Ціна входу за ринком у момент сигналу. */
  entry: number;
  stop: number;
  /** мс UTC */
  createdAt: number;
}

export type EventType = "entry" | "stop" | "exit" | "timeout";

export interface TrackEvent {
  type: EventType;
  ts: number;
  price: number;
}

/** Вихід із позиції. Усі виходи ринкові (taker): стоп, закриття за каналом, закриття за часом. */
export type Exit = Fill;

export interface TrackResult {
  status: "active" | "stopped" | "exited";
  events: TrackEvent[];
  /** Результат в R від ціни входу без комісій; null, поки позиція відкрита. */
  resultR: number | null;
  resolvedAt: number | null;
  /**
   * Подія, яку оцінює модель: до закриття позиції ціна хоча б раз пройшла у бік угоди на відстань стопа (+1R).
   * 1 — пройшла, 0 — позиція закрилась без цього, null — ще невідомо.
   */
  hit: 0 | 1 | null;
  entry: { price: number; kind: Liquidity };
  exits: Exit[];
}

/**
 * Правила:
 * - вхід за ринком у момент сигналу за ціною entry (taker);
 * - у кожній свічці 1h спершу перевіряється стоп: порядок усередині свічки невідомий, тож стоп має перевагу;
 * - коли закривається свічка 4h, позиція закривається за її ціною закриття, якщо та нижча за мінімум
 *   EXIT_BARS попередніх свічок 4h (для шорта вища за максимум);
 * - позиція, відкрита довше maxHoldMs, закривається за ціною закриття свічки 1h.
 */
export function replay(s: TrackedSignal, h1: Candle[], h4: Candle[], maxHoldMs: number): TrackResult {
  const long = s.side === "long";
  const dir = long ? 1 : -1;
  const risk = Math.abs(s.entry - s.stop);
  const r = (price: number) => (risk === 0 ? 0 : ((price - s.entry) / risk) * dir);
  const entry = { price: s.entry, kind: "taker" as const };
  const events: TrackEvent[] = [{ type: "entry", ts: s.createdAt, price: s.entry }];
  let hit: 0 | 1 | null = null;
  const close = (status: "stopped" | "exited", type: EventType, at: number, price: number): TrackResult => {
    events.push({ type, ts: at, price });
    return { status, events, resultR: Number(r(price).toFixed(2)), resolvedAt: at, hit: hit ?? 0, entry, exits: [{ price, share: 1, kind: "taker" }] };
  };
  const h4Index = new Map(h4.map((c, i) => [c.closeTime, i]));
  const oneR = s.entry + dir * risk;

  for (const c of h1) {
    // Свічка, що йшла в момент сигналу, вже належить йому: стоп у ній рахується.
    if (c.closeTime <= s.createdAt) continue;
    if (long ? c.low <= s.stop : c.high >= s.stop) {
      return close("stopped", "stop", c.closeTime, s.stop);
    }
    if (hit === null && (long ? c.high >= oneR : c.low <= oneR)) hit = 1;
    const i = h4Index.get(c.closeTime);
    if (i !== undefined && i >= EXIT_BARS) {
      const prev = h4.slice(i - EXIT_BARS, i);
      const bar = h4[i]!;
      const level = long ? Math.min(...prev.map((x) => x.low)) : Math.max(...prev.map((x) => x.high));
      if (long ? bar.close < level : bar.close > level) return close("exited", "exit", c.closeTime, bar.close);
    }
    if (c.closeTime - s.createdAt >= maxHoldMs) return close("exited", "timeout", c.closeTime, c.close);
  }
  return { status: "active", events, resultR: null, resolvedAt: null, hit, entry, exits: [] };
}

/**
 * Поточний рівень виходу за каналом: мінімум (для шорта максимум) останніх EXIT_BARS закритих свічок 4h.
 * Позиція закриється, якщо свічка 4h закриється за ним. null, якщо свічок замало.
 */
export function exitLevel(side: Side, h4: Candle[]): number | null {
  if (h4.length < EXIT_BARS) return null;
  const prev = h4.slice(-EXIT_BARS);
  return side === "long" ? Math.min(...prev.map((x) => x.low)) : Math.max(...prev.map((x) => x.high));
}
