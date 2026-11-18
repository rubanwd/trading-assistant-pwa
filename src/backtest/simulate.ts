import { feeR } from "../shared/risk";
import type { Candle } from "../worker/market/types";
import { marketRegime, trend, type MarketMood, type SymbolRegime } from "../worker/regime";
import { CANDLE_LIMIT } from "../worker/scan";
import { detect } from "../worker/signals/detectors";
import { candidateKey, reject, shortlist, type Rejection } from "../worker/signals/filter";
import { EXIT_BARS } from "../worker/signals/detectors";
import { replay, type TrackResult } from "../worker/signals/track";
import type { Candidate, SignalStatus } from "../worker/signals/types";
import { timeframeFeatures } from "../worker/snapshot";

/**
 * Бектест коду без моделі: ті самі детектори, фільтр і супровід, що й у рушії, на історичних свічках.
 * Скан іде щогодини, як у рушії, а сетап шукається лише одразу після закриття свічки 4h; видно тільки закриті свічки.
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
  minStopPct: number;
  maxActive: number;
  cooldownHours: number;
  maxCandidatesPerScan: number;
  maxHoldHours: number;
  /** Комісії, % від обсягу. Усі виконання трендового сетапу ринкові (taker). */
  makerPct: number;
  takerPct: number;
  /** Проковзування, % від ціни на кожному виконанні (вхід і вихід): стрес-тест, у рушії не рахується. */
  slippagePct: number;
  /** Для досліджень: додатковий відсів кандидатів до фільтра (кандидат пропускається, ніби детектор його не знайшов). */
  experiment?: { skip?: (c: Candidate) => boolean };
}

/** Стартові налаштування, як у міграціях. */
export const DEFAULT_CONFIG: Omit<BacktestConfig, "from" | "to"> = {
  minStopPct: 1,
  maxActive: 10,
  cooldownHours: 6,
  maxCandidatesPerScan: 5,
  maxHoldHours: 120,
  makerPct: 0.02,
  takerPct: 0.05,
  slippagePct: 0,
};

export interface Trade extends Candidate {
  createdAt: number;
  mood: MarketMood;
  regime: SymbolRegime;
  status: SignalStatus;
  /** Результат без комісій, R; null, якщо позиція ще відкрита на кінець даних. */
  resultR: number | null;
  feeR: number;
  /** Проковзування в R (лише в бектесті). */
  slipR: number;
  /** Після комісій і проковзування. */
  netR: number | null;
  /** Чи пройшла ціна +1R до закриття позиції: подія, яку оцінює модель. */
  hit: 0 | 1 | null;
  resolvedAt: number | null;
  events: TrackResult["events"];
}

export interface Funnel {
  scans: number;
  detected: number;
  filtered: Partial<Record<Rejection, number>>;
  /** Пройшли фільтр, але не потрапили в скан: другий напрям по тій самій монеті або слабші за ліміт кандидатів за скан. */
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

/** Повний супровід сигналу за свічками 1h і 4h після його створення. */
function resolve(c: Candidate, createdAt: number, data: SymbolCandles, cfg: BacktestConfig) {
  const hold = cfg.maxHoldHours * HOUR;
  const h1 = data["1h"].slice(
    firstIndex(data["1h"], (x) => x.closeTime > createdAt),
    firstIndex(data["1h"], (x) => x.openTime > createdAt + hold + HOUR),
  );
  const h4 = data["4h"].slice(
    Math.max(0, firstIndex(data["4h"], (x) => x.closeTime > createdAt) - EXIT_BARS),
    firstIndex(data["4h"], (x) => x.openTime > createdAt + hold + 4 * HOUR),
  );
  const res = replay({ side: c.side, entry: c.entry, stop: c.stop, createdAt }, h1, h4, hold);
  const done = res.resolvedAt !== null;
  const fee = done ? feeR(res.entry, c.stop, res.exits, { makerPct: cfg.makerPct, takerPct: cfg.takerPct }) : 0;
  const slip = done ? feeR(res.entry, c.stop, res.exits, { makerPct: cfg.slippagePct, takerPct: cfg.slippagePct }) : 0;
  return { res, fee, slip };
}

/** Що бачив скан, коли знайшов кандидата: для дослідження сетапів поза лімітами фільтра. */
export interface ScanContext {
  t: number;
  mood: MarketMood;
  regime: SymbolRegime;
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
  m15: Candle[];
  /** Причина відсіву фільтром або null, якщо кандидат пройшов фільтр. */
  rejection: Rejection | null;
}

export function backtest(
  symbols: SymbolCandles[],
  cfg: BacktestConfig,
  onCandidate?: (c: Candidate, ctx: ScanContext) => void,
): BacktestResult {
  const states: SymbolState[] = symbols.map((data) => ({
    data,
    h1: new Cursor(data["1h"]),
    h4: new Cursor(data["4h"]),
    d1: new Cursor(data["1d"]),
    regimeKey: "",
    regime: { trend: null, higherTrend: null, volatility: null },
    above200: null,
  }));
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
      const h4 = s.h4.window(t);
      // Сетап шукається лише на свічці 4h, що закрилась щойно; монети без свіжих даних пропускаються.
      if (!h4.length || t - h4[h4.length - 1]!.closeTime > 20 * 60_000) continue;
      for (const c of detect(s.data.symbol, h4)) {
        funnel.detected++;
        const reason = reject(c, {
          minStopPct: cfg.minStopPct,
          openSymbols,
          recent,
          minutesToMacro: null,
          macroBlackoutHours: 0,
          openCount: open.length,
          maxActive: cfg.maxActive,
        });
        if (cfg.experiment?.skip?.(c)) continue;
        onCandidate?.(c, { t, mood, regime: s.regime, h1: s.h1.window(t), h4, d1: s.d1.window(t), m15: s.data["15m"], rejection: reason });
        if (reason) funnel.filtered[reason] = (funnel.filtered[reason] ?? 0) + 1;
        else passed.push({ ...c, regime: s.regime });
      }
    }
    // Як у рушії: один кандидат на монету, спершу найсильніші пробої, не більше ліміту за скан; ліміт відкритих перевіряється знову.
    const chosen = shortlist(passed, cfg.maxCandidatesPerScan);
    funnel.capped += passed.length - chosen.length;
    let openCount = open.length;
    for (const { regime, ...c } of chosen) {
      if (openCount >= cfg.maxActive) {
        funnel.filtered.max_active = (funnel.filtered.max_active ?? 0) + 1;
        continue;
      }
      const data = states.find((s) => s.data.symbol === c.symbol)!.data;
      const { res, fee, slip } = resolve(c, t, data, cfg);
      trades.push({
        ...c,
        createdAt: t,
        mood,
        regime,
        status: res.status,
        resultR: res.resultR,
        feeR: fee,
        slipR: slip,
        netR: res.resultR === null ? null : Number((res.resultR - fee - slip).toFixed(3)),
        hit: res.hit,
        resolvedAt: res.resolvedAt,
        events: res.events,
      });
      funnel.published++;
      openCount++;
    }
  }
  return { trades, funnel };
}
