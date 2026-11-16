import { describe, expect, it } from "vitest";
import { entryMid, feeR, positionSize, riskReward } from "../src/shared/risk";
import { DEFAULT_AI } from "../src/shared/ai";
import { decideModel } from "../src/worker/llm";
import { atr, last } from "../src/worker/indicators";
import { detect, quality, STOP_ATR } from "../src/worker/signals/detectors";
import { candidateKey, minutesToMacro, reject, shortlist, type FilterContext } from "../src/worker/signals/filter";
import { ANALYST_SCHEMA, decide, PLAYBOOK_DEFAULT, reviewInput, sanitizeAnalyst, sanitizeSkeptic, SKEPTIC_SCHEMA } from "../src/worker/signals/review";
import { exitLevel, replay, type TrackedSignal } from "../src/worker/signals/track";
import type { Candidate } from "../src/worker/signals/types";
import { buildSnapshot } from "../src/worker/snapshot";
import { flip, ohlc, path, trendBreakoutSeries } from "./fixtures";

describe("ризик", () => {
  it("розмір позиції від ризику на угоду", () => {
    // 1% від $2000 = $20 ризику; до стопа 500 → 0.04 BTC, обсяг $4000.
    expect(positionSize(2000, 1, 100_000, 99_500)).toEqual({ riskUsd: 20, quantity: 0.04, notionalUsd: 4000, stopDistancePct: 0.5 });
    expect(positionSize(2000, 1, 100, 102)?.quantity).toBe(10);
  });

  it("null на непридатних даних", () => {
    expect(positionSize(0, 1, 100, 99)).toBeNull();
    expect(positionSize(1000, 1, 100, 100)).toBeNull();
    expect(positionSize(NaN, 1, 100, 99)).toBeNull();
  });

  it("R:R і середина зони", () => {
    expect(riskReward(100, 98, 105)).toBe(2.5);
    expect(riskReward(100, 102, 95)).toBe(2.5);
    expect(entryMid(99, 101)).toBe(100);
  });
});

describe("детектор трендового пробою", () => {
  const H4 = 4 * 3_600_000;
  const one = (rows: [number, number, number, number][]) => detect("BTCUSDT", ohlc(rows, 1_800_000_000_000, H4));

  it("лонг: вхід за закриттям пробою, стоп на 2 ATR нижче, цілі немає", () => {
    const rows = trendBreakoutSeries();
    const [s, ...rest] = one(rows);
    expect(rest).toEqual([]);
    const close = rows[rows.length - 1]![3];
    const a = last(atr(ohlc(rows, 1_800_000_000_000, H4), 14))!;
    expect(s).toMatchObject({ symbol: "BTCUSDT", side: "long", setup: "trend_breakout", entry: close });
    expect(s!.stop).toBeCloseTo(close - STOP_ATR * a, 3);
    expect(s!.facts.breakout_atr).toBeGreaterThan(0);
    expect(s!.facts.ema200_distance_atr).toBeGreaterThan(0);
    expect(Object.keys(s!)).not.toContain("tp1");
  });

  it("шорт є точним дзеркалом лонга", () => {
    const long = one(trendBreakoutSeries())[0]!;
    const short = one(flip(trendBreakoutSeries(), 400))[0]!;
    expect(short).toMatchObject({ side: "short", setup: "trend_breakout" });
    expect(short.entry).toBeCloseTo(400 - long.entry, 6);
    expect(short.stop).toBeCloseTo(400 - long.stop, 2);
    expect(short.stop).toBeGreaterThan(short.entry);
    expect(short.facts).toEqual(long.facts);
  });

  it("без закриття за каналом пробою немає", () => {
    expect(one(trendBreakoutSeries().slice(0, -1))).toEqual([]);
  });

  it("лонг лише над EMA200: пробій угору в низхідному тренді не сигнал", () => {
    const closes: number[] = [];
    for (let i = 0; i < 230; i++) closes.push(200 - i * 0.2);
    const base = closes[closes.length - 1]!;
    for (let i = 0; i < 20; i++) closes.push(base + (i % 2 ? 0.5 : -0.5));
    closes.push(base + 3);
    expect(one(path(closes))).toEqual([]);
  });

  it("на короткій історії сетапів немає", () => {
    expect(one(trendBreakoutSeries().slice(-150))).toEqual([]);
    expect(detect("X", [])).toEqual([]);
  });
});

describe("фільтр", () => {
  const c: Candidate = { symbol: "ETHUSDT", side: "long", setup: "trend_breakout", entry: 100, stop: 96, quality: 50, facts: {} };
  const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
    minStopPct: 1,
    openSymbols: new Set(),
    recent: new Set(),
    minutesToMacro: null,
    macroBlackoutHours: 2,
    openCount: 0,
    maxActive: 3,
    ...over,
  });

  it("пропускає чистого кандидата", () => {
    expect(reject(c, ctx())).toBeNull();
  });

  it("відсіює надто близький стоп", () => {
    // Вхід 100, стоп 96: відстань 4%.
    expect(reject(c, ctx({ minStopPct: 4 }))).toBeNull();
    expect(reject(c, ctx({ minStopPct: 4.01 }))).toBe("stop");
    expect(reject({ ...c, side: "short", stop: 101.5 }, ctx({ minStopPct: 1.6 }))).toBe("stop");
  });

  it("дубль по монеті, охолодження, макроподія, ліміт активних", () => {
    expect(reject(c, ctx({ openSymbols: new Set(["ETHUSDT"]) }))).toBe("duplicate");
    expect(reject(c, ctx({ recent: new Set([candidateKey(c)]) }))).toBe("cooldown");
    expect(reject(c, ctx({ recent: new Set(["ETHUSDT|trend_breakout|short"]) }))).toBeNull();
    expect(reject(c, ctx({ minutesToMacro: 120 }))).toBe("macro");
    expect(reject(c, ctx({ minutesToMacro: 121 }))).toBeNull();
    expect(reject(c, ctx({ openCount: 3 }))).toBe("max_active");
  });

  it("відсіює слабкий пробій: обсяг нижче середнього або розмах свічки менше 1 ATR", () => {
    const strong = { volume_ratio: 1, candle_range_atr: 1, ema200_distance_atr: 4 };
    expect(reject({ ...c, facts: strong }, ctx())).toBeNull();
    expect(reject({ ...c, facts: { ...strong, volume_ratio: 0.99 } }, ctx())).toBe("weak");
    expect(reject({ ...c, facts: { ...strong, candle_range_atr: 0.99 } }, ctx())).toBe("weak");
  });

  it("відсіює вхід навздогін: 9 ATR і далі від EMA200, в обох напрямах", () => {
    const facts = { volume_ratio: 2, candle_range_atr: 2, ema200_distance_atr: 8.99 };
    expect(reject({ ...c, facts }, ctx())).toBeNull();
    expect(reject({ ...c, facts: { ...facts, ema200_distance_atr: 9 } }, ctx())).toBe("extended");
    expect(reject({ ...c, side: "short", stop: 104, facts: { ...facts, ema200_distance_atr: 11 } }, ctx())).toBe("extended");
  });

  it("сила пробою: від 0 до 100, росте з обсягом, розмахом і глибиною пробою", () => {
    expect(quality({ volume_ratio: 0, candle_range_atr: 0, breakout_atr: 0 })).toBe(0);
    expect(quality({ volume_ratio: 4, candle_range_atr: 3, breakout_atr: 1.5 })).toBe(100);
    expect(quality({ volume_ratio: 40, candle_range_atr: 30, breakout_atr: 15 })).toBe(100);
    expect(quality({ volume_ratio: 2, candle_range_atr: 1.5, breakout_atr: 0.75 })).toBe(50);
    expect(quality({ volume_ratio: 2, candle_range_atr: 1.5, breakout_atr: 0.2 })).toBeLessThan(50);
    expect(quality({})).toBe(0);
  });

  it("до моделі йдуть найсильніші: один на монету, не більше ліміту за скан", () => {
    const of = (symbol: string, q: number, side: Candidate["side"] = "long"): Candidate => ({ ...c, symbol, side, quality: q });
    const passed = [of("BTCUSDT", 30), of("ETHUSDT", 70), of("SOLUSDT", 55), of("ETHUSDT", 80, "short"), of("XRPUSDT", 10)];
    expect(shortlist(passed, 3).map((x) => `${x.symbol} ${x.side} ${x.quality}`)).toEqual(["ETHUSDT short 80", "SOLUSDT long 55", "BTCUSDT long 30"]);
    expect(shortlist(passed, 10)).toHaveLength(4);
    expect(shortlist(passed, 0)).toEqual([]);
    // Вхідний список не змінюється: рушій рахує за ним воронку.
    expect(passed[0]!.symbol).toBe("BTCUSDT");
  });

  it("рахує хвилини до найближчої майбутньої макроподії", () => {
    const now = Date.UTC(2026, 11, 16, 17, 0);
    expect(minutesToMacro(["2026-12-16T19:00:00Z", "2026-12-10T13:30:00Z"], now)).toBe(120);
    expect(minutesToMacro([{ at: "2026-12-16T18:00:00Z", name: "ФРС" }, "сміття", 5], now)).toBe(60);
    expect(minutesToMacro(["2026-12-10T13:30:00Z"], now)).toBeNull();
    expect(minutesToMacro("x", now)).toBeNull();
  });
});

describe("супровід сигналу", () => {
  const H1 = 3_600_000;
  const H4 = 4 * H1;
  const T0 = 1_800_000_000_000 - (1_800_000_000_000 % H4);
  const HOLD = 14 * 24 * H1;
  /** Свічки [high, low, close] з кроком step, перша відкривається в first. */
  const bars = (step: number, first: number, rows: [number, number, number][]) =>
    rows.map(([high, low, close], i) => ({ openTime: first + i * step, closeTime: first + (i + 1) * step - 1, open: close, high, low, close, volume: 1 }));
  /** Десять свічок 4h до сигналу: мінімуми 99, максимуми 101. */
  const before4h = bars(H4, T0 - 10 * H4, Array.from({ length: 10 }, (): [number, number, number] => [101, 99, 100]));
  const long: TrackedSignal = { side: "long", entry: 100, stop: 96, createdAt: T0 };
  const short: TrackedSignal = { side: "short", entry: 100, stop: 104, createdAt: T0 };
  const run = (s: TrackedSignal, h1: [number, number, number][], h4: [number, number, number][] = [], hold = HOLD) =>
    replay(s, bars(H1, T0, h1), [...before4h, ...bars(H4, T0, h4)], hold);

  it("вхід за ринком у момент сигналу; поки немає ні стопа, ні виходу, позиція відкрита", () => {
    const r = run(long, [[101, 99.5, 100.5], [102, 100, 101.5]]);
    expect(r).toMatchObject({ status: "active", resultR: null, resolvedAt: null, hit: null, exits: [] });
    expect(r.entry).toEqual({ price: 100, kind: "taker" });
    expect(r.events).toEqual([{ type: "entry", ts: T0, price: 100 }]);
  });

  it("стоп: −1R, подія для моделі не відбулась", () => {
    const r = run(long, [[101, 99.5, 100.5], [100.5, 95.9, 96.5]]);
    expect(r).toMatchObject({ status: "stopped", resultR: -1, hit: 0, resolvedAt: T0 + 2 * H1 - 1 });
    expect(r.exits).toEqual([{ price: 96, share: 1, kind: "taker" }]);
    expect(r.events.map((e) => e.type)).toEqual(["entry", "stop"]);
  });

  it("свічка, що зачепила і стоп, і +1R, рахується як стоп", () => {
    expect(run(long, [[104.5, 95.5, 100]])).toMatchObject({ status: "stopped", hit: 0 });
  });

  it("вихід за каналом: закриття 4h нижче мінімуму 10 попередніх свічок; +1R до того зараховано", () => {
    const h1: [number, number, number][] = [
      [101, 99.6, 100.8], [104.5, 100.5, 104], [104.2, 102, 103], [103.5, 102.5, 103], // перша свічка 4h: +1R пройдено
      [103, 100, 100.5], [100.8, 98.8, 99.2], [99.5, 98.5, 98.7], [99, 98.3, 98.5], // друга: закриття 98.5 < мінімуму каналу 99
    ];
    const h4: [number, number, number][] = [[104.5, 99.6, 103], [103, 98.3, 98.5]];
    const r = run(long, h1, h4);
    expect(r).toMatchObject({ status: "exited", hit: 1, resultR: -0.38, resolvedAt: T0 + 8 * H1 - 1 });
    expect(r.exits).toEqual([{ price: 98.5, share: 1, kind: "taker" }]);
    expect(r.events.map((e) => e.type)).toEqual(["entry", "exit"]);
  });

  it("закриття 4h над мінімумом каналу позицію не закриває, навіть якщо тінь нижче", () => {
    // Мінімум каналу 99: закриття 98.9 закриває позицію, закриття 99.2 при тіні до 98.5 — ні.
    const h1: [number, number, number][] = [[101, 99.6, 100.8], [101, 98.5, 100], [100.5, 99.5, 100], [100.5, 98.8, 98.9]];
    expect(run(long, h1, [[101, 98.5, 98.9]]).status).toBe("exited");
    const h1b: [number, number, number][] = [[101, 99.6, 100.8], [101, 98.5, 100], [100.5, 99.5, 100], [100.5, 99.1, 99.2]];
    expect(run(long, h1b, [[101, 98.5, 99.2]]).status).toBe("active");
  });

  it("закриття за часом із фактичним результатом", () => {
    const r = run(long, [[101, 99.5, 100.5], [102, 100, 102]], [], 2 * H1 - 1);
    expect(r).toMatchObject({ status: "exited", resultR: 0.5, hit: 0 });
    expect(r.events.map((e) => e.type)).toEqual(["entry", "timeout"]);
  });

  it("шорт дзеркальний: стоп угорі, вихід за максимумом каналу", () => {
    expect(run(short, [[104.1, 99, 103]])).toMatchObject({ status: "stopped", resultR: -1 });
    const h1: [number, number, number][] = [[100.4, 95.5, 96], [97, 96, 96.5], [99, 96.5, 98], [101.5, 98, 101.2]];
    expect(run(short, h1, [[101.5, 95.5, 101.2]])).toMatchObject({ status: "exited", hit: 1, resultR: -0.3 });
  });

  it("свічки, що закрились до сигналу, не враховуються", () => {
    const early = bars(H1, T0 - 2 * H1, [[101, 90, 95], [101, 90, 95]]);
    const r = replay(long, [...early, ...bars(H1, T0, [[101, 99.5, 100.5]])], before4h, HOLD);
    expect(r.status).toBe("active");
  });

  it("відтворення детерміноване", () => {
    const h1: [number, number, number][] = [[101, 99.5, 100.5], [104.5, 100, 104], [90, 80, 85]];
    expect(run(long, h1)).toEqual(run(long, h1));
    expect(run(long, h1)).toMatchObject({ status: "stopped", hit: 1 });
  });

  it("поточний рівень виходу за каналом", () => {
    expect(exitLevel("long", before4h)).toBe(99);
    expect(exitLevel("short", before4h)).toBe(101);
    expect(exitLevel("long", before4h.slice(0, 5))).toBeNull();
  });

  it("комісії в R: усі виконання ринкові", () => {
    const fees = { makerPct: 0.02, takerPct: 0.05 };
    const taker = { price: 100, kind: "taker" as const };
    // (100 + 108) × 0.05% = 0.104 на одиницю, ризик 4 → 0.026R.
    expect(feeR(taker, 96, [{ price: 108, share: 1, kind: "taker" }], fees)).toBe(0.026);
    expect(feeR({ price: 100, kind: "maker" }, 96, [{ price: 108, share: 1, kind: "maker" }], fees)).toBe(0.01);
    expect(feeR(taker, 96, [], fees)).toBe(0);
    expect(feeR(null, 96, [{ price: 108, share: 1, kind: "taker" }], fees)).toBe(0);
    expect(feeR(taker, 100, [{ price: 108, share: 1, kind: "taker" }], fees)).toBe(0);
  });
});

describe("вхід для моделі", () => {
  it("кандидат без цілі: вхід, стоп, рівень +1R і правило виходу", () => {
    const candidate: Candidate = { symbol: "ETHUSDT", side: "short", setup: "trend_breakout", entry: 2000, stop: 2100, quality: 40, facts: { breakout_atr: 0.4 } };
    const c = ohlc(trendBreakoutSeries());
    const snapshot = buildSnapshot({ symbol: "ETHUSDT", now: 1_800_000_000_000, candles: { "15m": c, "1h": c, "4h": c, "1d": c }, funding: null, openInterest: null });
    const input = reviewInput({
      candidate, rule: PLAYBOOK_DEFAULT.trend_breakout, snapshot, btc: null, news: [], minutesToMacro: null,
      market: { mood: "mixed", btcTrend: "range", breadth: 0.5, counted: 15 },
    });
    expect(input.candidate).toMatchObject({ entry: 2000, stop: 2100, one_r_level: 1900, stop_distance_pct: 5, breakout_quality: 40, measurements: { breakout_atr: 0.4 } });
    expect(input.candidate.exit_rule).toContain("максимумом 10");
    expect(Object.keys(input.candidate)).not.toContain("target_1");
  });
});

describe("аналітик і скептик", () => {
  const analyst = (over: Record<string, unknown> = {}) =>
    sanitizeAnalyst({ verdict: "take", probability_pct: 58, summary: "s", arguments_for: ["a"], arguments_against: ["b"], invalidation: "i", ...over });
  const skeptic = (pct: number) => sanitizeSkeptic({ probability_pct: pct, strongest_risk: "r", arguments_against: ["x"] });

  it("публікує лише коли аналітик бере, а скептик не нижче порога", () => {
    expect(decide(analyst(), skeptic(45), 0.45)).toEqual({ publish: true });
    expect(decide(analyst(), skeptic(44), 0.45)).toEqual({ publish: false, by: "skeptic" });
    expect(decide(analyst({ verdict: "skip" }), skeptic(90), 0.45)).toEqual({ publish: false, by: "analyst" });
    expect(decide(analyst(), null, 0.45)).toEqual({ publish: false, by: "skeptic" });
  });

  it("тримає ймовірність у межах і обрізає списки", () => {
    expect(analyst({ probability_pct: 100 }).probability).toBe(0.95);
    expect(skeptic(0).probability).toBe(0.05);
    expect(analyst({ arguments_for: ["1", "2", "3", "4", "5", 6, ""] }).argumentsFor).toEqual(["1", "2", "3", "4"]);
  });

  it("відповідь без вердикту чи ймовірності є помилкою, а не згодою", () => {
    expect(() => analyst({ verdict: "maybe" })).toThrow();
    expect(() => analyst({ probability_pct: "багато" })).toThrow();
    expect(() => sanitizeSkeptic({})).toThrow();
    expect(() => sanitizeAnalyst(null)).toThrow();
  });

  it("схема скептика не має полів аналітика", () => {
    expect(Object.keys(SKEPTIC_SCHEMA.properties)).toEqual(["probability_pct", "strongest_risk", "arguments_against"]);
    expect(ANALYST_SCHEMA.properties.verdict.enum).toEqual(["take", "skip"]);
  });

  it("після стелі витрат перевірка сигналів зупиняється", () => {
    const ai = { ...DEFAULT_AI, budgetUsd: 25 };
    expect(decideModel("analyst", 10, ai)).toEqual({ allowed: true, agent: DEFAULT_AI.agents.analyst });
    expect(decideModel("analyst", 25, ai).allowed).toBe(false);
    expect(decideModel("skeptic", 30, ai).allowed).toBe(false);
  });
});
