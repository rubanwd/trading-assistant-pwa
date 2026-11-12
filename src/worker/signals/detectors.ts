import { entryMid, riskReward, type Side } from "../../shared/risk";
import { atr, ema, last, levels, pivots, rsi } from "../indicators";
import type { Candle } from "../market/types";
import type { Candidate, SetupId } from "./types";

/**
 * Детектори сетапів. Чисті функції над закритими свічками 1h із контекстом 4h.
 * Кожен детектор написано для лонга; шорт рахується на дзеркальних цінах (ціна × −1),
 * тож правила для обох напрямів гарантовано однакові.
 */

/** Сирий сетап у «лонговій» системі координат: зона входу і стоп без цілей. */
interface RawSetup {
  setup: SetupId;
  entryLow: number;
  entryHigh: number;
  stop: number;
  facts: Record<string, number>;
}

const mirror = (candles: Candle[]): Candle[] =>
  candles.map((c) => ({ ...c, open: -c.open, high: -c.low, low: -c.high, close: -c.close }));

/** Стоп не далі стількох ATR від входу: інакше сетап надто розмитий. */
const MAX_RISK_ATR = 3;

/**
 * Відкат у тренді: EMA20 вище EMA50 на 1h, після імпульсу ціна відкотилась до EMA20,
 * втрималась над EMA50 і закрила свічку зростанням. Тренд 4h перевіряє фільтр.
 */
export function pullback(c: Candle[], a: number): RawSetup | null {
  const closes = c.map((x) => x.close);
  const e20 = last(ema(closes, 20));
  const e50 = last(ema(closes, 50));
  const r = last(rsi(closes, 14));
  const cur = c[c.length - 1];
  if (e20 === null || e50 === null || r === null || !cur || c.length < 60) return null;
  const recent = c.slice(-12);
  const impulseHigh = Math.max(...recent.map((x) => x.high));
  const depth = (impulseHigh - cur.low) / a;
  const touched = cur.low <= e20 + 0.1 * a;
  if (!(e20 > e50 && touched && cur.close > e50 && cur.close > cur.open && depth >= 1.5 && r >= 35 && r <= 60)) return null;
  const entryHigh = cur.close;
  const entryLow = Math.min(Math.max(e50, entryHigh - 0.5 * a), entryHigh - 0.15 * a);
  const stop = Math.min(...c.slice(-5).map((x) => x.low)) - 0.3 * a;
  return { setup: "trend_pullback", entryLow, entryHigh, stop, facts: { pullback_depth_atr: depth, rsi14_1h: r } };
}

/**
 * Пробій із ретестом: рівень із двома й більше дотиками тримав ціну щонайменше 20 свічок,
 * за останні 12 свічок ціна закрилась над ним, а остання свічка повернулась до рівня й закрилась вище.
 */
export function breakoutRetest(c: Candle[], a: number): RawSetup | null {
  const n = c.length;
  const cur = c[n - 1];
  if (!cur || n < 60) return null;
  const candidates = levels(c.slice(0, -1), cur.close, 0.5 * a, { max: 4 }).support.filter((l) => l.touches >= 2);
  for (const level of candidates) {
    const s = level.price;
    const over = s + 0.2 * a;
    // Перша свічка серед останніх 12 (без поточної), що закрилась над рівнем.
    let breakout = -1;
    for (let i = n - 13; i <= n - 2; i++) {
      if (i > 20 && c[i]!.close > over && c[i - 1]!.close <= over) {
        breakout = i;
        break;
      }
    }
    if (breakout < 0 || level.lastIndex >= breakout) continue;
    const heldBefore = c.slice(breakout - 20, breakout).every((x) => x.close <= over);
    const heldAfter = c.slice(breakout, n).every((x) => x.close >= s - 0.2 * a);
    const retest = cur.low <= s + 0.3 * a && cur.close > s;
    if (!heldBefore || !heldAfter || !retest) continue;
    const lowSince = Math.min(...c.slice(breakout).map((x) => x.low));
    return {
      setup: "breakout_retest",
      entryLow: s,
      entryHigh: s + 0.5 * a,
      stop: Math.min(lowSince, s - 0.5 * a) - 0.2 * a,
      facts: { level_touches: level.touches, candles_since_breakout: n - 1 - breakout, retest_depth_atr: (cur.low - s) / a },
    };
  }
  return null;
}

/**
 * Зняття ліквідності з поверненням: остання свічка проколола тінню попередній розворотний мінімум,
 * який до цього не пробивали закриттям, і закрилась над ним.
 */
export function liquiditySweep(c: Candle[], a: number): RawSetup | null {
  const n = c.length;
  const cur = c[n - 1];
  if (!cur || n < 60) return null;
  const range = cur.high - cur.low;
  const wick = Math.min(cur.open, cur.close) - cur.low;
  if (range === 0 || wick / range < 0.4) return null;
  const lows = pivots(c.slice(0, -1), 3)
    .filter((p) => p.kind === "low" && p.index >= n - 51 && p.index <= n - 6)
    .reverse();
  for (const p of lows) {
    const depth = (p.price - cur.low) / a;
    const untouched = c.slice(p.index + 1, n - 1).every((x) => x.close >= p.price);
    if (!(cur.low < p.price && cur.close > p.price && depth >= 0.1 && untouched)) continue;
    return {
      setup: "liquidity_sweep",
      entryLow: p.price,
      entryHigh: Math.min(cur.close, p.price + 0.5 * a),
      stop: cur.low - 0.3 * a,
      facts: { sweep_depth_atr: depth, wick_share: wick / range, candles_since_low: n - 1 - p.index },
    };
  }
  return null;
}

/**
 * Цілі за структурою: найближчі рівні опору 1h і 4h та максимум останніх 48 годин.
 * Перша ціль має бути не ближче 1 ATR від входу. R:R нижче порога відсіє фільтр.
 */
function targets(c1h: Candle[], c4h: Candle[], entry: number, a: number): { tp1: number; tp2: number | null } | null {
  const a4 = last(atr(c4h, 14));
  const pool = [
    ...levels(c1h, entry, 0.5 * a, { max: 5 }).resistance.map((l) => l.price),
    ...(a4 === null ? [] : levels(c4h, entry, 0.5 * a4, { max: 5 }).resistance.map((l) => l.price)),
    Math.max(...c1h.slice(-48).map((x) => x.high)),
  ]
    .filter((p) => p >= entry + a)
    .sort((x, y) => x - y);
  const tp1 = pool[0];
  if (tp1 === undefined) return null;
  return { tp1, tp2: pool.find((p) => p >= tp1 + 0.5 * a) ?? null };
}

const DETECTORS = [pullback, breakoutRetest, liquiditySweep];

/** Округлення цін до 6 значущих цифр, як у знімках. */
const price = (v: number) => Number(v.toPrecision(6));

/** Усі сетапи по монеті в обох напрямах. Перевірку режиму, R:R і лімітів робить фільтр. */
export function detect(symbol: string, c1h: Candle[], c4h: Candle[]): Candidate[] {
  const out: Candidate[] = [];
  for (const side of ["long", "short"] as Side[]) {
    const sign = side === "long" ? 1 : -1;
    const h1 = sign === 1 ? c1h : mirror(c1h);
    const h4 = sign === 1 ? c4h : mirror(c4h);
    const a = last(atr(h1, 14));
    if (a === null || a <= 0) continue;
    for (const detector of DETECTORS) {
      const raw = detector(h1, a);
      if (!raw || !(raw.stop < raw.entryLow && raw.entryLow < raw.entryHigh)) continue;
      const mid = entryMid(raw.entryLow, raw.entryHigh);
      if (mid - raw.stop > MAX_RISK_ATR * a) continue;
      const t = targets(h1, h4, mid, a);
      if (!t) continue;
      // Назад із дзеркальних координат: нижня й верхня межі зони міняються місцями.
      const [lo, hi] = sign === 1 ? [raw.entryLow, raw.entryHigh] : [-raw.entryHigh, -raw.entryLow];
      out.push({
        symbol,
        side,
        setup: raw.setup,
        entryLow: price(lo),
        entryHigh: price(hi),
        stop: price(sign * raw.stop),
        tp1: price(sign * t.tp1),
        tp2: t.tp2 === null ? null : price(sign * t.tp2),
        rr: Number(riskReward(mid, raw.stop, t.tp1).toFixed(2)),
        facts: {
          // RSI пораховано на дзеркальних цінах: для шорта повертаємо справжнє значення.
          ...Object.fromEntries(
            Object.entries(raw.facts).map(([k, v]) => [k, Number((k === "rsi14_1h" && sign === -1 ? 100 - v : v).toFixed(2))]),
          ),
          risk_atr: Number(((mid - raw.stop) / a).toFixed(2)),
        },
      });
    }
  }
  return out;
}
