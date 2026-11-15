import type { Side } from "../../shared/risk";
import { atr, ema, last, sma } from "../indicators";
import type { Candle } from "../market/types";
import type { Candidate } from "./types";

/**
 * Трендовий пробій на 4h. Чиста функція над закритими свічками 4h.
 * Детектор написано для лонга; шорт рахується на дзеркальних цінах (ціна × −1),
 * тож правила для обох напрямів гарантовано однакові.
 *
 * Правило перевірено бектестом на трьох роках (2023-11 — 2026-10): у кожному році результат після комісій
 * не нижче нуля, тоді як попередні сетапи на 1h були збиткові в усіх трьох.
 */

/** Пробій максимуму стількох попередніх свічок 4h за закриттям. */
export const ENTRY_BARS = 20;
/** Вихід, коли свічка 4h закрилась за мінімумом стількох попередніх свічок (для шорта за максимумом). */
export const EXIT_BARS = 10;
/** Початковий стоп за стільки ATR(14) 4h від входу. */
export const STOP_ATR = 2;
/** Лонг лише над EMA цього періоду на 4h, шорт лише під нею. */
export const TREND_EMA = 200;

const mirror = (candles: Candle[]): Candle[] =>
  candles.map((c) => ({ ...c, open: -c.open, high: -c.low, low: -c.high, close: -c.close }));

/** Пробій у «лонговій» системі координат: стоп і виміри. null, якщо пробою немає. */
export function breakout(c: Candle[]): { stop: number; facts: Record<string, number> } | null {
  const n = c.length;
  const cur = c[n - 1];
  if (!cur || n < TREND_EMA + ENTRY_BARS) return null;
  const channel = c.slice(n - 1 - ENTRY_BARS, n - 1);
  const high = Math.max(...channel.map((x) => x.high));
  const low = Math.min(...channel.map((x) => x.low));
  const trend = last(ema(c.map((x) => x.close), TREND_EMA));
  const a = last(atr(c, 14));
  const vol = last(sma(c.map((x) => x.volume), 20));
  if (trend === null || a === null || a <= 0) return null;
  if (!(cur.close > high && cur.close > trend)) return null;
  return {
    stop: cur.close - STOP_ATR * a,
    facts: {
      breakout_atr: (cur.close - high) / a,
      channel_width_atr: (high - low) / a,
      ema200_distance_atr: (cur.close - trend) / a,
      candle_range_atr: (cur.high - cur.low) / a,
      volume_ratio: vol ? cur.volume / vol : 0,
    },
  };
}

/** Округлення цін до 6 значущих цифр, як у знімках. */
const price = (v: number) => Number(v.toPrecision(6));

/** Пробої по монеті в обох напрямах на щойно закритій свічці 4h. Ліміти й паузи перевіряє фільтр. */
export function detect(symbol: string, c4h: Candle[]): Candidate[] {
  const out: Candidate[] = [];
  const cur = c4h[c4h.length - 1];
  if (!cur) return out;
  for (const side of ["long", "short"] as Side[]) {
    const sign = side === "long" ? 1 : -1;
    const raw = breakout(sign === 1 ? c4h : mirror(c4h));
    if (!raw) continue;
    out.push({
      symbol,
      side,
      setup: "trend_breakout",
      entry: cur.close,
      stop: price(sign * raw.stop),
      facts: Object.fromEntries(Object.entries(raw.facts).map(([k, v]) => [k, Number(v.toFixed(2))])),
    });
  }
  return out;
}
