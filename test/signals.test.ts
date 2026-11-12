import { describe, expect, it } from "vitest";
import { entryMid, feeR, positionSize, riskReward } from "../src/shared/risk";
import { DEFAULT_AI } from "../src/shared/ai";
import { decideModel } from "../src/worker/llm";
import { detect } from "../src/worker/signals/detectors";
import { candidateKey, minutesToMacro, reject, type FilterContext } from "../src/worker/signals/filter";
import { ANALYST_SCHEMA, decide, sanitizeAnalyst, sanitizeSkeptic, SKEPTIC_SCHEMA } from "../src/worker/signals/review";
import { replay, type TrackedSignal } from "../src/worker/signals/track";
import type { Candidate } from "../src/worker/signals/types";
import { breakoutSeries, flip, ohlc, path, pullbackSeries, sweepSeries, uptrend } from "./fixtures";

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

describe("детектори", () => {
  const one = (rows: [number, number, number, number][]) => {
    const c = ohlc(rows);
    return detect("BTCUSDT", c, c);
  };

  it("відкат у тренді: лонг зі стопом за мінімумом відкату", () => {
    const [s, ...rest] = one(pullbackSeries());
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ side: "long", setup: "trend_pullback" });
    expect(s!.stop).toBeLessThan(s!.entryLow);
    expect(s!.entryLow).toBeLessThan(s!.entryHigh);
    expect(s!.tp1).toBeGreaterThan(s!.entryHigh);
    expect(s!.rr).toBeCloseTo(riskReward(entryMid(s!.entryLow, s!.entryHigh), s!.stop, s!.tp1), 1);
    expect(s!.facts.pullback_depth_atr).toBeGreaterThanOrEqual(1.5);
  });

  it("шорт є точним дзеркалом лонга", () => {
    const long = one(pullbackSeries())[0]!;
    const short = one(flip(pullbackSeries(), 250))[0]!;
    expect(short).toMatchObject({ side: "short", setup: "trend_pullback", rr: long.rr });
    expect(short.entryLow).toBeCloseTo(250 - long.entryHigh, 2);
    expect(short.entryHigh).toBeCloseTo(250 - long.entryLow, 2);
    expect(short.stop).toBeCloseTo(250 - long.stop, 2);
    expect(short.tp1).toBeCloseTo(250 - long.tp1, 2);
    expect(short.stop).toBeGreaterThan(short.entryHigh);
    expect(short.facts.rsi14_1h).toBeCloseTo(100 - long.facts.rsi14_1h!, 1);
  });

  it("пробій із ретестом: вхід від пробитого рівня", () => {
    const [s] = one(breakoutSeries());
    expect(s).toMatchObject({ side: "long", setup: "breakout_retest" });
    expect(s!.entryLow).toBeGreaterThan(109);
    expect(s!.entryLow).toBeLessThan(110);
    expect(s!.facts).toMatchObject({ level_touches: 3, candles_since_breakout: 3 });
  });

  it("зняття ліквідності: вхід від проколотого мінімуму, стоп за тінню", () => {
    const rows = sweepSeries();
    const [s] = one(rows);
    const wickLow = rows[rows.length - 1]![2];
    expect(s).toMatchObject({ side: "long", setup: "liquidity_sweep" });
    expect(s!.stop).toBeLessThan(wickLow);
    expect(s!.entryLow).toBeGreaterThan(wickLow);
  });

  it("у рівному тренді без відкату й на короткій історії сетапів немає", () => {
    expect(one(path(uptrend(120)))).toEqual([]);
    expect(one(pullbackSeries().slice(-40))).toEqual([]);
    expect(detect("X", [], [])).toEqual([]);
  });

  it("без ретесту пробій не сетап", () => {
    expect(one(breakoutSeries().slice(0, -1)).filter((s) => s.setup === "breakout_retest")).toEqual([]);
  });
});

describe("фільтр", () => {
  const c: Candidate = {
    symbol: "ETHUSDT", side: "long", setup: "trend_pullback",
    entryLow: 99, entryHigh: 101, stop: 98, tp1: 105, tp2: null, rr: 2.5, facts: {},
  };
  const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
    minRr: 2,
    regime: { trend: "up", higherTrend: "up", volatility: "normal" },
    mood: "mixed",
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
    expect(reject({ ...c, rr: 2 }, ctx())).toBeNull();
  });

  it("відсіює за R:R", () => {
    expect(reject({ ...c, rr: 1.99 }, ctx())).toBe("rr");
  });

  it("відкат лише за трендом 4h і не проти 1d", () => {
    expect(reject(c, ctx({ regime: { trend: "range", higherTrend: "up", volatility: "normal" } }))).toBe("regime");
    expect(reject(c, ctx({ regime: { trend: "up", higherTrend: "down", volatility: "normal" } }))).toBe("regime");
    expect(reject({ ...c, side: "short" }, ctx())).toBe("regime");
    expect(reject({ ...c, side: "short" }, ctx({ regime: { trend: "down", higherTrend: "range", volatility: "normal" } }))).toBeNull();
  });

  it("пробій і зняття ліквідності дозволені в боковику, але не проти тренду 4h", () => {
    const range = { trend: "range", higherTrend: "down", volatility: "normal" } as const;
    expect(reject({ ...c, setup: "breakout_retest" }, ctx({ regime: range }))).toBeNull();
    expect(reject({ ...c, setup: "liquidity_sweep" }, ctx({ regime: { ...range, trend: "down" } }))).toBe("regime");
    expect(reject({ ...c, setup: "liquidity_sweep" }, ctx({ regime: { ...range, trend: null } }))).toBe("regime");
  });

  it("не йде проти настрою ринку", () => {
    expect(reject(c, ctx({ mood: "risk_off" }))).toBe("market");
    expect(reject(c, ctx({ mood: "risk_on" }))).toBeNull();
  });

  it("дубль по монеті, охолодження, макроподія, ліміт активних", () => {
    expect(reject(c, ctx({ openSymbols: new Set(["ETHUSDT"]) }))).toBe("duplicate");
    expect(reject(c, ctx({ recent: new Set([candidateKey(c)]) }))).toBe("cooldown");
    expect(reject(c, ctx({ recent: new Set(["ETHUSDT|trend_pullback|short"]) }))).toBeNull();
    expect(reject(c, ctx({ minutesToMacro: 120 }))).toBe("macro");
    expect(reject(c, ctx({ minutesToMacro: 121 }))).toBeNull();
    expect(reject(c, ctx({ openCount: 3 }))).toBe("max_active");
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
  const M15 = 900_000;
  const T0 = 1_800_000_000_000;
  const HOLD = 48 * 3_600_000;
  const sig = (over: Partial<TrackedSignal> = {}): TrackedSignal => ({
    side: "long", entryLow: 99, entryHigh: 101, stop: 98, tp1: 104, tp2: null, createdAt: T0, expiresAt: T0 + 12 * 3_600_000, ...over,
  });
  /** Свічки 15m від T0: [high, low, close]. */
  const bars = (rows: [number, number, number][]) =>
    rows.map(([high, low, close], i) => ({ openTime: T0 + i * M15, closeTime: T0 + (i + 1) * M15 - 1, open: close, high, low, close, volume: 1 }));
  const run = (rows: [number, number, number][], s = sig(), now = T0 + rows.length * M15) => replay(s, bars(rows), now, HOLD);

  it("чекає входу, поки ціна над зоною", () => {
    expect(run([[103, 102, 102.5]])).toEqual({ status: "pending", events: [], resultR: null, resolvedAt: null, exits: [] });
  });

  it("вхід, потім ціль: результат дорівнює R:R від середини зони", () => {
    const r = run([[103, 102, 102.5], [102, 100.5, 101], [103, 100.8, 102.8], [104.2, 102.5, 104]]);
    expect(r.status).toBe("tp1");
    expect(r.events.map((e) => e.type)).toEqual(["entry", "tp1"]);
    expect(r.resultR).toBe(2); // (104 − 100) / (100 − 98)
    expect(r.resolvedAt).toBe(T0 + 4 * M15 - 1);
  });

  it("вхід, потім стоп: −1R", () => {
    const r = run([[102, 100.5, 101], [101, 97.9, 98.2]]);
    expect(r).toMatchObject({ status: "stopped", resultR: -1 });
  });

  it("свічка, що зачепила і стоп, і ціль, рахується як стоп", () => {
    expect(run([[102, 100.5, 101], [104.5, 97.5, 100]])).toMatchObject({ status: "stopped", resultR: -1 });
  });

  it("у свічці входу ціль не зараховується, а стоп зараховується", () => {
    expect(run([[104.5, 100.5, 104]]).status).toBe("active");
    expect(run([[102, 97.5, 98]]).events.map((e) => e.type)).toEqual(["entry", "stop"]);
  });

  it("ціна дійшла до цілі без входу: сигнал пропущено", () => {
    const r = run([[103, 102, 102.5], [104.1, 102.2, 104]]);
    expect(r).toMatchObject({ status: "expired", resultR: null });
    expect(r.events.map((e) => e.type)).toEqual(["missed"]);
  });

  it("без входу до кінця терміну сигнал прострочено", () => {
    const s = sig({ expiresAt: T0 + 2 * M15 });
    const r = run([[103, 102, 102.5], [103, 102, 102.5], [102, 100, 100.5]], s);
    expect(r).toMatchObject({ status: "expired", resultR: null, resolvedAt: T0 + 2 * M15 });
    expect(r.events.map((e) => e.type)).toEqual(["expired"]);
  });

  it("активний сигнал закривається за часом із фактичним результатом", () => {
    const r = replay(sig(), bars([[102, 100.5, 101], [102, 100.6, 101], [102, 100.6, 101.5]]), T0 + 3 * M15, 2 * M15 - 2);
    expect(r).toMatchObject({ status: "expired", resultR: 0.75 }); // (101.5 − 100) / 2
    expect(r.events.map((e) => e.type)).toEqual(["entry", "timeout"]);
  });

  it("шорт дзеркальний", () => {
    const s = sig({ side: "short", entryLow: 99, entryHigh: 101, stop: 102, tp1: 96 });
    expect(run([[98, 97, 97.5]], s).status).toBe("pending");
    expect(run([[99.5, 98, 99], [99, 95.9, 96.5]], s)).toMatchObject({ status: "tp1", resultR: 2 });
    expect(run([[99.5, 98, 99], [102.1, 99, 101]], s)).toMatchObject({ status: "stopped", resultR: -1 });
  });

  it("свічки до створення сигналу не враховуються", () => {
    const s = sig({ createdAt: T0 + 2 * M15 });
    expect(run([[102, 97, 98], [102, 97, 98], [103, 102, 102.5]], s).status).toBe("pending");
  });

  describe("друга ціль", () => {
    const s2 = sig({ tp2: 108 });
    const entered: [number, number, number][] = [[102, 100.5, 101], [104.2, 101, 104]];

    it("половина на першій цілі, решта на другій", () => {
      const r = run([...entered, [106, 103, 105], [108.5, 105, 108]], s2);
      expect(r.status).toBe("tp2");
      expect(r.events.map((e) => e.type)).toEqual(["entry", "tp1", "tp2"]);
      expect(r.resultR).toBe(3); // 0.5 × 2 + 0.5 × 4
      expect(r.exits).toEqual([{ price: 104, share: 0.5 }, { price: 108, share: 0.5 }]);
    });

    it("після першої цілі стоп у беззбитку: результат лише з першої половини", () => {
      const r = run([...entered, [103, 99.8, 100.2]], s2);
      expect(r).toMatchObject({ status: "tp1", resultR: 1 });
      expect(r.events.map((e) => e.type)).toEqual(["entry", "tp1", "breakeven"]);
    });

    it("поки перша ціль не взята, сигнал активний; після неї теж, доки не закриється решта", () => {
      expect(run(entered, s2).status).toBe("active");
      expect(run(entered, s2).events.map((e) => e.type)).toEqual(["entry", "tp1"]);
    });

    it("у свічці першої цілі друга не рахується, а свічка з беззбитком і другою ціллю дає беззбиток", () => {
      expect(run([[102, 100.5, 101], [108.5, 101, 108]], s2).status).toBe("active");
      expect(run([...entered, [108.5, 99.5, 104]], s2).status).toBe("tp1");
    });

    it("закриття за часом після першої цілі", () => {
      const r = replay(s2, bars([...entered, [105, 103, 104], [105, 103, 102]]), T0 + 4 * M15, 3 * M15 - 2);
      expect(r).toMatchObject({ status: "tp1", resultR: 1.5 }); // 0.5 × 2 + 0.5 × (102 − 100) / 2
    });
  });

  it("комісії в R", () => {
    // Вхід 100, стоп 98, вихід 104: обіг 204 × 0.05% = 0.102 на одиницю, ризик 2 → 0.051R.
    expect(feeR(100, 98, [{ price: 104, share: 1 }], 0.05)).toBe(0.051);
    expect(feeR(100, 98, [{ price: 104, share: 0.5 }, { price: 108, share: 0.5 }], 0.05)).toBeCloseTo(0.0515, 2); // обіг 206
    expect(feeR(100, 98, [], 0.05)).toBe(0);
    expect(feeR(100, 100, [{ price: 104, share: 1 }], 0.05)).toBe(0);
  });

  it("відтворення детерміноване: повторний прогін дає той самий результат", () => {
    const rows: [number, number, number][] = [[102, 100.5, 101], [103, 100.8, 102.8], [104.2, 102.5, 104], [90, 80, 85]];
    expect(run(rows)).toEqual(run(rows));
    expect(run(rows).status).toBe("tp1");
  });
});

describe("аналітик і скептик", () => {
  const analyst = (over: Record<string, unknown> = {}) =>
    sanitizeAnalyst({ verdict: "take", probability_pct: 58, summary: "s", arguments_for: ["a"], arguments_against: ["b"], invalidation: "i", ...over });
  const skeptic = (pct: number) => sanitizeSkeptic({ probability_pct: pct, strongest_risk: "r", arguments_against: ["x"] });

  it("публікує лише коли аналітик бере, а скептик не нижче порога", () => {
    expect(decide(analyst(), skeptic(60), 0.6)).toEqual({ publish: true });
    expect(decide(analyst(), skeptic(59), 0.6)).toEqual({ publish: false, by: "skeptic" });
    expect(decide(analyst({ verdict: "skip" }), skeptic(90), 0.6)).toEqual({ publish: false, by: "analyst" });
    expect(decide(analyst(), null, 0.6)).toEqual({ publish: false, by: "skeptic" });
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
