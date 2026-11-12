import { atr, ema, last, levels, percentileOfLast, rsi, sma, type Levels } from "./indicators";
import type { Candle, Funding, OpenInterestPoint, Timeframe } from "./market/types";
import { trend, volatility, type SymbolRegime } from "./regime";

export const SNAPSHOT_VERSION = 1;

/** Ознаки одного таймфрейму. Усе пораховано по закритих свічках. */
export interface TimeframeFeatures {
  /** Час закриття останньої свічки, ISO UTC. */
  closedAt: string;
  close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number | null;
  /** ATR у відсотках від ціни. */
  atrPct: number | null;
  /** Зміна останньої свічки до попереднього закриття, %. */
  changePct: number | null;
  /** Обсяг останньої свічки до середнього за 20. */
  volumeRatio: number | null;
}

/** Знімок ознак по монеті: саме його (а не сирі свічки) згодом бачитиме модель. */
export interface Snapshot {
  v: number;
  symbol: string;
  /** Час розрахунку, ISO UTC. */
  ts: string;
  price: number;
  tf: Record<Timeframe, TimeframeFeatures>;
  /** Рівні за розворотними точками 1h і 4h. */
  levels: { "1h": SnapshotLevels; "4h": SnapshotLevels };
  funding: { rate: number; markPrice: number; nextFundingAt: string } | null;
  openInterest: { valueUsd: number | null; contracts: number; change24hPct: number | null; at: string } | null;
  regime: SymbolRegime;
}

export interface SnapshotLevel {
  price: number;
  /** Скільки розворотних точок злилось у рівень. */
  touches: number;
  /** Час закриття свічки останнього дотику, ISO UTC. */
  lastTouchAt: string;
}

export interface SnapshotLevels {
  /** Нижче ціни, від найближчого. */
  support: SnapshotLevel[];
  /** Вище ціни, від найближчого. */
  resistance: SnapshotLevel[];
}

export interface SnapshotInput {
  symbol: string;
  now: number;
  candles: Record<Timeframe, Candle[]>;
  funding: Funding | null;
  openInterest: OpenInterestPoint[] | null;
}

/** Округлення до 6 значущих цифр: достатньо для ознак, знімок компактніший. */
export function round(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return v === 0 ? 0 : Number(v.toPrecision(6));
}

const pct = (a: number, b: number) => (b === 0 ? null : ((a - b) / b) * 100);

/** Серія ATR у відсотках від закриття тієї ж свічки. */
function atrPctSeries(candles: Candle[], atrSeries: number[]): number[] {
  return candles.map((c, i) => (atrSeries[i]! / c.close) * 100);
}

export function timeframeFeatures(candles: Candle[]): TimeframeFeatures {
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) throw new Error("немає закритих свічок");
  const prev = candles[candles.length - 2];
  const closes = candles.map((c) => c.close);
  const atr14 = last(atr(candles, 14));
  const avgVolume = last(sma(candles.map((c) => c.volume), 20));
  return {
    closedAt: new Date(lastCandle.closeTime).toISOString(),
    close: lastCandle.close,
    ema20: round(last(ema(closes, 20))),
    ema50: round(last(ema(closes, 50))),
    ema200: round(last(ema(closes, 200))),
    rsi14: round(last(rsi(closes, 14))),
    atr14: round(atr14),
    atrPct: round(atr14 === null ? null : (atr14 / lastCandle.close) * 100),
    changePct: round(prev ? pct(lastCandle.close, prev.close) : null),
    volumeRatio: round(avgVolume ? lastCandle.volume / avgVolume : null),
  };
}

function snapshotLevels(l: Levels, candles: Candle[]): SnapshotLevels {
  const r = (x: Levels["support"]): SnapshotLevel[] =>
    x.map((v) => ({
      price: round(v.price)!,
      touches: v.touches,
      lastTouchAt: new Date(candles[v.lastIndex]!.closeTime).toISOString(),
    }));
  return { support: r(l.support), resistance: r(l.resistance) };
}

function openInterestFeatures(points: OpenInterestPoint[] | null): Snapshot["openInterest"] {
  const cur = points?.[points.length - 1];
  if (!points || !cur) return null;
  // Точка, найближча до «24 години тому»; якщо історія коротша, зміну не рахуємо.
  const target = cur.ts - 24 * 60 * 60_000;
  const base = points.find((p) => p.ts >= target);
  const has24h = base !== undefined && base.ts - target <= 30 * 60_000 && base !== cur;
  return {
    valueUsd: cur.valueUsd === null || !Number.isFinite(cur.valueUsd) ? null : Math.round(cur.valueUsd),
    contracts: round(cur.contracts)!,
    change24hPct: has24h ? round(pct(cur.contracts, base.contracts)) : null,
    at: new Date(cur.ts).toISOString(),
  };
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const { symbol, now, candles, funding } = input;
  const tf = {
    "15m": timeframeFeatures(candles["15m"]),
    "1h": timeframeFeatures(candles["1h"]),
    "4h": timeframeFeatures(candles["4h"]),
    "1d": timeframeFeatures(candles["1d"]),
  };
  const price = tf["15m"].close;
  const levelsFor = (key: "1h" | "4h"): SnapshotLevels => {
    const a = tf[key].atr14;
    // Допуск злиття точок у рівень: половина ATR цього таймфрейму.
    return a === null ? { support: [], resistance: [] } : snapshotLevels(levels(candles[key], price, a * 0.5), candles[key]);
  };
  const h1 = candles["1h"];
  const atrPercentile = percentileOfLast(atrPctSeries(h1, atr(h1, 14)), 100);
  return {
    v: SNAPSHOT_VERSION,
    symbol,
    ts: new Date(now).toISOString(),
    price,
    tf,
    levels: { "1h": levelsFor("1h"), "4h": levelsFor("4h") },
    funding: funding
      ? {
          rate: funding.rate,
          markPrice: funding.markPrice,
          nextFundingAt: new Date(funding.nextFundingTime).toISOString(),
        }
      : null,
    openInterest: openInterestFeatures(input.openInterest),
    regime: {
      trend: trend(tf["4h"]),
      higherTrend: trend(tf["1d"]),
      volatility: volatility(atrPercentile),
    },
  };
}
