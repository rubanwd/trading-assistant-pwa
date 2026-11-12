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
  /** Друга ціль: якщо є, на першій фіксується половина, стоп переходить у беззбиток. */
  tp2: number | null;
  /** мс UTC */
  createdAt: number;
  /** До цього часу сигнал чекає входу. */
  expiresAt: number;
}

export type EventType = "entry" | "tp1" | "tp2" | "stop" | "breakeven" | "expired" | "missed" | "timeout";

export interface TrackEvent {
  type: EventType;
  ts: number;
  price: number;
}

export interface Exit {
  price: number;
  /** Частка позиції, 0..1. */
  share: number;
}

export interface TrackResult {
  status: SignalStatus;
  events: TrackEvent[];
  /** Результат в R від середини зони входу без комісій; null, поки сигнал відкритий або входу не було. */
  resultR: number | null;
  resolvedAt: number | null;
  /** Виходи з позиції для розрахунку комісій; порожньо, якщо входу не було. */
  exits: Exit[];
}

/** Частка позиції, яка фіксується на першій цілі, коли є друга. */
export const TP1_SHARE = 0.5;

/** Свічка, що відкрилась не раніше ніж за хвилину до створення сигналу, вже належить йому. */
const START_TOLERANCE_MS = 60_000;

/**
 * Правила:
 * - вхід, коли ціна торкнулась зони; якщо ціна дійшла до першої цілі без входу, сигнал «пішов без нас»;
 * - у свічці входу може спрацювати стоп, але не ціль: порядок усередині свічки невідомий;
 * - якщо свічка зачепила і стоп, і ціль, рахуємо стоп;
 * - без другої цілі вся позиція закривається на першій; з другою на першій фіксується половина,
 *   стоп решти переходить у беззбиток (середина зони), і в тій самій свічці далі нічого не рахується;
 * - без входу до expiresAt сигнал прострочено; активний довше maxHoldMs закривається за ціною закриття.
 */
export function replay(s: TrackedSignal, candles: Candle[], now: number, maxHoldMs: number): TrackResult {
  const long = s.side === "long";
  const dir = long ? 1 : -1;
  const mid = entryMid(s.entryLow, s.entryHigh);
  const risk = Math.abs(mid - s.stop);
  const r = (price: number) => ((price - mid) / risk) * dir;
  const events: TrackEvent[] = [];
  const exits: Exit[] = [];
  const done = (status: SignalStatus, at: number): TrackResult => {
    const gross = exits.length ? exits.reduce((sum, e) => sum + r(e.price) * e.share, 0) : null;
    return { status, events, resultR: gross === null ? null : Number(gross.toFixed(2)), resolvedAt: at, exits };
  };
  const above = (c: Candle, level: number) => (long ? c.high >= level : c.low <= level);
  const below = (c: Candle, level: number) => (long ? c.low <= level : c.high >= level);

  let enteredAt: number | null = null;
  let tp1Hit = false;
  for (const c of candles) {
    if (c.openTime < s.createdAt - START_TOLERANCE_MS) continue;

    if (enteredAt === null) {
      if (c.openTime >= s.expiresAt) break;
      const touched = long ? c.low <= s.entryHigh : c.high >= s.entryLow;
      if (!touched) {
        if (above(c, s.tp1)) {
          events.push({ type: "missed", ts: c.closeTime, price: s.tp1 });
          return done("expired", c.closeTime);
        }
        continue;
      }
      enteredAt = c.closeTime;
      events.push({ type: "entry", ts: c.closeTime, price: long ? s.entryHigh : s.entryLow });
      if (below(c, s.stop)) {
        events.push({ type: "stop", ts: c.closeTime, price: s.stop });
        exits.push({ price: s.stop, share: 1 });
        return done("stopped", c.closeTime);
      }
      continue;
    }

    const remaining = tp1Hit ? 1 - TP1_SHARE : 1;
    if (!tp1Hit) {
      if (below(c, s.stop)) {
        events.push({ type: "stop", ts: c.closeTime, price: s.stop });
        exits.push({ price: s.stop, share: 1 });
        return done("stopped", c.closeTime);
      }
      if (above(c, s.tp1)) {
        events.push({ type: "tp1", ts: c.closeTime, price: s.tp1 });
        if (s.tp2 === null) {
          exits.push({ price: s.tp1, share: 1 });
          return done("tp1", c.closeTime);
        }
        exits.push({ price: s.tp1, share: TP1_SHARE });
        tp1Hit = true;
        continue;
      }
    } else {
      if (below(c, mid)) {
        events.push({ type: "breakeven", ts: c.closeTime, price: mid });
        exits.push({ price: mid, share: remaining });
        return done("tp1", c.closeTime);
      }
      if (above(c, s.tp2!)) {
        events.push({ type: "tp2", ts: c.closeTime, price: s.tp2! });
        exits.push({ price: s.tp2!, share: remaining });
        return done("tp2", c.closeTime);
      }
    }
    if (c.closeTime - enteredAt >= maxHoldMs) {
      events.push({ type: "timeout", ts: c.closeTime, price: c.close });
      exits.push({ price: c.close, share: remaining });
      return done(tp1Hit ? "tp1" : "expired", c.closeTime);
    }
  }

  if (enteredAt !== null) return { status: "active", events, resultR: null, resolvedAt: null, exits: [] };
  if (now >= s.expiresAt) {
    events.push({ type: "expired", ts: s.expiresAt, price: mid });
    return done("expired", s.expiresAt);
  }
  return { status: "pending", events, resultR: null, resolvedAt: null, exits: [] };
}
