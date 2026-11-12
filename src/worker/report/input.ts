import type { MarketContext } from "../context";
import type { MarketRegime } from "../regime";
import type { Snapshot, SnapshotLevels, TimeframeFeatures } from "../snapshot";
import type { ReportKind } from "../time";

/** Стиснуті ознаки таймфрейму для звіту: положення ціни відносно EMA у відсотках. */
function tf(f: TimeframeFeatures) {
  const dist = (ema: number | null) => (ema === null ? null : Number((((f.close - ema) / ema) * 100).toFixed(2)));
  return {
    change_pct: f.changePct,
    vs_ema20_pct: dist(f.ema20),
    vs_ema50_pct: dist(f.ema50),
    vs_ema200_pct: dist(f.ema200),
    rsi14: f.rsi14,
    atr_pct: f.atrPct,
  };
}

const prices = (l: SnapshotLevels) => ({
  support: l.support.map((x) => ({ price: x.price, touches: x.touches })),
  resistance: l.resistance.map((x) => ({ price: x.price, touches: x.touches })),
});

/** Стиснутий знімок монети для моделі: ознаки трьох таймфреймів, рівні, фандинг, відкритий інтерес. */
export function compactSymbol(s: Snapshot) {
  return {
    symbol: s.symbol,
    price: s.price,
    trend_4h: s.regime.trend,
    trend_1d: s.regime.higherTrend,
    volatility_1h: s.regime.volatility,
    "1h": tf(s.tf["1h"]),
    "4h": tf(s.tf["4h"]),
    "1d": tf(s.tf["1d"]),
    levels_1h: prices(s.levels["1h"]),
    levels_4h: prices(s.levels["4h"]),
    funding_rate_pct: s.funding ? Number((s.funding.rate * 100).toFixed(4)) : null,
    open_interest_change_24h_pct: s.openInterest?.change24hPct ?? null,
  };
}

export interface NewsField {
  category: string;
  impact: string;
  sentiment: string;
  symbols: string[];
  relevance: number;
  age_hours: number;
}

export interface PriorForecast {
  title: string;
  statement: string;
  probability_pct: number;
  outcome: "happened" | "did_not_happen" | "pending";
}

export interface ReportInputArgs {
  kind: ReportKind;
  localDate: string;
  localClock: string;
  market: MarketRegime;
  context: MarketContext;
  snapshots: Snapshot[];
  news: NewsField[];
  priorForecasts: PriorForecast[];
  openSignals: { symbol: string; side: string; setup: string; status: string }[];
}

/**
 * Вхід автора звіту. Тут лише пораховані кодом ознаки та поля новин за схемою:
 * ні сирих свічок, ні заголовків новин модель не бачить.
 */
export function reportInput(a: ReportInputArgs) {
  return {
    report: a.kind,
    local_date: a.localDate,
    local_time: a.localClock,
    market: {
      mood: a.market.mood,
      btc_trend_4h: a.market.btcTrend,
      share_above_ema200_4h: a.market.breadth,
      btc_dominance_pct: a.context.btcDominancePct,
      market_cap_change_24h_pct: a.context.marketCapChange24hPct,
      fear_greed_0_100: a.context.fearGreed,
    },
    symbols: a.snapshots.map(compactSymbol),
    news_last_12h: a.news,
    open_signals: a.openSignals,
    previous_forecasts: a.priorForecasts,
  };
}
