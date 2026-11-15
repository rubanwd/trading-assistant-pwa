import { feeR, type Liquidity } from "../shared/risk";
import type { Candle } from "../worker/market/types";
import { marketRegime, trend, type MarketMood, type SymbolRegime } from "../worker/regime";
import { CANDLE_LIMIT } from "../worker/scan";
import { detect } from "../worker/signals/detectors";
import { candidateKey, reject, type Rejection } from "../worker/signals/filter";
import { replay, type TrackResult } from "../worker/signals/track";
import type { Candidate, SignalStatus } from "../worker/signals/types";
import { timeframeFeatures } from "../worker/snapshot";

/**
 * Бектест коду без моделі: ті самі детектори, фільтр і супровід, що й у рушії, на історичних свічках.
 * Кожну годину (одразу після закриття свічки 1h) рушій бачить лише свічки, що вже закрились.
 * Модель не викликається: результат показує базову якість сетапів, ніби аналітик і скептик погоджувались завжди.
 * Макроподій в історії немає, тож фільтр «macro» не спрацьовує.
 */

const HOUR = 3_600_000;

export interface SymbolCandles {
  symbol: string;
  /** Усі таймфрейми від старих до нових, з історією для розгону індикаторів до `from`. */
  "15m": Candle[];
  "1h": Candle[];
  "4h": Candle[];
  "1d": Candle[];
}

export interface BacktestConfig {
  /** Перший і останній момент скану, мс UTC. Скан іде на початку кожної години. */
  from: number;
  to: number;
  minRr: number;
  maxActive: number;
  cooldownHours: number;
  maxCandidatesPerScan: number;
  ttlHours: number;
  maxHoldHours: number;
  /** Комісії, % від обсягу: лімітні ордери (вхід, цілі) і ринкові (стоп, беззбиток, закриття за часом). */
  makerPct: number;
  takerPct: number;
}

/** Стартові налаштування, як у міграціях. */
export const DEFAULT_CONFIG: Omit<BacktestConfig, "from" | "to"> = {
  minRr: 2,
  maxActive: 3,
  cooldownHours: 6,
  maxCandidatesPerScan: 3,
  ttlHours: 12,
  maxHoldHours: 48,
  makerPct: 0.02,
  takerPct: 0.05,
};

export interface Trade extends Candidate {
  createdAt: number;
  mood: MarketMood;
  regime: SymbolRegime;
  status: SignalStatus;
  /** Як виконався вхід; null, якщо входу не було. */
  entryKind: Liquidity | null;
  /** Результат без комісій, R; null, якщо входу не було або позиція ще відкрита на кінець даних. */
  resultR: number | null;
  feeR: number;
  /** Після комісій. */
  netR: number | null;
  resolvedAt: number | null;
  events: TrackResult["events"];
}

export interface Funnel {
  scans: number;
  detected: number;
  filtered: Partial<Record<Rejection, number>>;
  /** Пройшли фільтр, але не потрапили в скан: слабший R:R по тій самій монеті або понад ліміт кандидатів за скан. */
  capped: number;
  published: number;
}

export interface BacktestResult {
  trades: Trade[];
  funnel: Funnel;
}

/** Індекс першого елемента, для якого pred істинний (масив упорядковано). */
function firstIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(arr[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Курсор по свічках: скільки з них уже закрилось на момент `t`. Час іде лише вперед. */
class Cursor {
  private i = 0;
  constructor(private readonly candles: Candle[]) {}
  closedBefore(t: number): number {
    while (this.i < this.candles.length && this.candles[this.i]!.closeTime < t) this.i++;
    return this.i;
  }
  /** Останні `limit` закритих свічок, як їх віддає біржа рушію. */
  window(t: number, limit = CANDLE_LIMIT): Candle[] {
    const end = this.closedBefore(t);
    return this.candles.slice(Math.max(0, end - limit), end);
  }
}

interface SymbolState {
  data: SymbolCandles;
  h1: Cursor;
  h4: Cursor;
  d1: Cursor;
  /** Режим перераховується лише після закриття нової свічки 4h або 1d. */
  regimeKey: string;
  regime: SymbolRegime;
  above200: boolean | null;
}

function regimeOf(h4: Candle[], d1: Candle[]): { regime: SymbolRegime; above200: boolean | null } {
  const f4 = h4.length ? timeframeFeatures(h4) : null;
  const f1 = d1.length ? timeframeFeatures(d1) : null;
  return {
    regime: { trend: f4 ? trend(f4) : null, higherTrend: f1 ? trend(f1) : null, volatility: null },
    above200: f4 && f4.ema200 !== null ? f4.close > f4.ema200 : null,
  };
}

/** Повний супровід сигналу за свічками 15m після його створення. */
function resolve(c: Candidate, createdAt: number, m15: Candle[], cfg: BacktestConfig, dataEnd: number) {
  const expiresAt = createdAt + cfg.ttlHours * HOUR;
  const start = firstIndex(m15, (x) => x.openTime >= createdAt - 60_000);
  const horizon = expiresAt + cfg.maxHoldHours * HOUR + 2 * HOUR;
  const end = firstIndex(m15, (x) => x.openTime > horizon);
  const res = replay(
    { side: c.side, entryLow: c.entryLow, entryHigh: c.entryHigh, stop: c.stop, tp1: c.tp1, tp2: c.tp2, createdAt, expiresAt },
    m15.slice(start, end),
    dataEnd,
    cfg.maxHoldHours * HOUR,
  );
  const fee = res.resolvedAt === null ? 0 : feeR(res.entry, c.stop, res.exits, { makerPct: cfg.makerPct, takerPct: cfg.takerPct });
  return { res, fee };
}

export function backtest(symbols: SymbolCandles[], cfg: BacktestConfig): BacktestResult {
  const states: SymbolState[] = symbols.map((data) => ({
    data,
    h1: new Cursor(data["1h"]),
    h4: new Cursor(data["4h"]),
    d1: new Cursor(data["1d"]),
    regimeKey: "",
    regime: { trend: null, higherTrend: null, volatility: null },
    above200: null,
  }));
  const dataEnd = Math.max(...symbols.map((s) => s["15m"].at(-1)?.closeTime ?? 0)) + 1;
  const trades: Trade[] = [];
  const funnel: Funnel = { scans: 0, detected: 0, filtered: {}, capped: 0, published: 0 };
  const start = Math.ceil(cfg.from / HOUR) * HOUR;

  for (let t = start; t <= cfg.to; t += HOUR) {
    funnel.scans++;
    // Режим кожної монети і загальний настрій ринку на момент скану.
    for (const s of states) {
      const key = `${s.h4.closedBefore(t)}|${s.d1.closedBefore(t)}`;
      if (key === s.regimeKey) continue;
      const r = regimeOf(s.h4.window(t), s.d1.window(t));
      s.regimeKey = key;
      s.regime = r.regime;
      s.above200 = r.above200;
    }
    const btc = states.find((s) => s.data.symbol === "BTCUSDT");
    const mood = marketRegime(btc?.regime.trend ?? null, states.map((s) => s.above200)).mood;

    // Сигнал відкритий, поки супровід не закрив його свічкою, що закрилась до скану.
    const open = trades.filter((x) => x.resolvedAt === null || x.resolvedAt > t);
    const openSymbols = new Set(open.map((x) => x.symbol));
    const recent = new Set(trades.filter((x) => x.createdAt >= t - cfg.cooldownHours * HOUR).map(candidateKey));

    const passed: (Candidate & { regime: SymbolRegime })[] = [];
    for (const s of states) {
      const h1 = s.h1.window(t);
      // Скан бачить лише свічку 1h, що закрилась щойно; монети без свіжих даних пропускаються.
      if (!h1.length || t - h1[h1.length - 1]!.closeTime > 20 * 60_000) continue;
      for (const c of detect(s.data.symbol, h1, s.h4.window(t))) {
        funnel.detected++;
        const reason = reject(c, {
          minRr: cfg.minRr,
          regime: s.regime,
          mood,
          openSymbols,
          recent,
          minutesToMacro: null,
          macroBlackoutHours: 0,
          openCount: open.length,
          maxActive: cfg.maxActive,
        });
        if (reason) funnel.filtered[reason] = (funnel.filtered[reason] ?? 0) + 1;
        else passed.push({ ...c, regime: s.regime });
      }
    }
    // Як у рушії: найкращий за R:R кандидат на монету, не більше ліміту за скан, ліміт відкритих перевіряється знову.
    passed.sort((a, b) => b.rr - a.rr);
    const chosen = passed.filter((c, i) => passed.findIndex((x) => x.symbol === c.symbol) === i).slice(0, cfg.maxCandidatesPerScan);
    funnel.capped += passed.length - chosen.length;
    let openCount = open.length;
    for (const { regime, ...c } of chosen) {
      if (openCount >= cfg.maxActive) {
        funnel.filtered.max_active = (funnel.filtered.max_active ?? 0) + 1;
        continue;
      }
      const data = states.find((s) => s.data.symbol === c.symbol)!.data;
      const { res, fee } = resolve(c, t, data["15m"], cfg, dataEnd);
      trades.push({
        ...c,
        createdAt: t,
        mood,
        regime,
        status: res.status,
        entryKind: res.entry?.kind ?? null,
        resultR: res.resultR,
        feeR: fee,
        netR: res.resultR === null ? null : Number((res.resultR - fee).toFixed(3)),
        resolvedAt: res.resolvedAt,
        events: res.events,
      });
      funnel.published++;
      openCount++;
    }
  }
  return { trades, funnel };
}
