import { entryMid, type Side } from "../../shared/risk";
import type { Candle } from "../market/types";
import type { SignalStatus } from "./types";

/** Супровід сигналу. Стан щоразу відтворюється зі свічок 15m від моменту створення, тож курсор не потрібен. */

export interface TrackedSignal {
  side: Side;
  entryLow: number;
  entryHigh: number;
  stop: number;
  tp1: number;
  /** мс UTC */
  createdAt: number;
  /** До цього часу сигнал чекає входу. */
  expiresAt: number;
}

export type EventType = "entry" | "tp1" | "stop" | "expired" | "missed" | "timeout";

export interface TrackEvent {
  type: EventType;
  ts: number;
  price: number;
}

export interface TrackResult {
  status: SignalStatus;
  events: TrackEvent[];
  /** Результат в R від середини зони входу; null, поки сигнал відкритий або входу не було. */
  resultR: number | null;
  resolvedAt: number | null;
}

/** Свічка, що відкрилась не раніше ніж за хвилину до створення сигналу, вже належить йому. */
const START_TOLERANCE_MS = 60_000;

/**
 * Правила:
 * - вхід, коли ціна торкнулась зони; якщо ціна дійшла до цілі без входу, сигнал «пішов без нас»;
 * - у свічці входу може спрацювати стоп, але не ціль: порядок усередині свічки невідомий;
 * - якщо свічка зачепила і стоп, і ціль, рахуємо стоп;
 * - без входу до expiresAt сигнал прострочено; активний довше maxHoldMs закривається за ціною закриття.
 */
export function replay(s: TrackedSignal, candles: Candle[], now: number, maxHoldMs: number): TrackResult {
  const long = s.side === "long";
  const mid = entryMid(s.entryLow, s.entryHigh);
  const risk = Math.abs(mid - s.stop);
  const rr = Math.abs(s.tp1 - mid) / risk;
  const events: TrackEvent[] = [];
  const done = (status: SignalStatus, resultR: number | null, at: number): TrackResult => ({
    status,
    events,
    resultR: resultR === null ? null : Number(resultR.toFixed(2)),
    resolvedAt: at,
  });

  let enteredAt: number | null = null;
  for (const c of candles) {
    if (c.openTime < s.createdAt - START_TOLERANCE_MS) continue;
    const hitStop = long ? c.low <= s.stop : c.high >= s.stop;
    const hitTp = long ? c.high >= s.tp1 : c.low <= s.tp1;

    if (enteredAt === null) {
      if (c.openTime >= s.expiresAt) break;
      const touched = long ? c.low <= s.entryHigh : c.high >= s.entryLow;
      if (!touched) {
        if (hitTp) {
          events.push({ type: "missed", ts: c.closeTime, price: s.tp1 });
          return done("expired", null, c.closeTime);
        }
        continue;
      }
      enteredAt = c.closeTime;
      events.push({ type: "entry", ts: c.closeTime, price: long ? s.entryHigh : s.entryLow });
      if (hitStop) {
        events.push({ type: "stop", ts: c.closeTime, price: s.stop });
        return done("stopped", -1, c.closeTime);
      }
      continue;
    }

    if (hitStop) {
      events.push({ type: "stop", ts: c.closeTime, price: s.stop });
      return done("stopped", -1, c.closeTime);
    }
    if (hitTp) {
      events.push({ type: "tp1", ts: c.closeTime, price: s.tp1 });
      return done("tp1", rr, c.closeTime);
    }
    if (c.closeTime - enteredAt >= maxHoldMs) {
      events.push({ type: "timeout", ts: c.closeTime, price: c.close });
      return done("expired", ((c.close - mid) / risk) * (long ? 1 : -1), c.closeTime);
    }
  }

  if (enteredAt !== null) return { status: "active", events, resultR: null, resolvedAt: null };
  if (now >= s.expiresAt) {
    events.push({ type: "expired", ts: s.expiresAt, price: mid });
    return done("expired", null, s.expiresAt);
  }
  return { status: "pending", events, resultR: null, resolvedAt: null };
}
