import { describe, expect, it } from "vitest";
import { choosePick, PICK_SCHEMA, pickInput, pickLevels, rankPicks, resolvePick, sanitizePick, scoreSide, type PickOption } from "../src/worker/pick";
import type { MarketRegime } from "../src/worker/regime";
import { netR, outcome, summarize, type PickRecord } from "../src/worker/pickStats";
import { buildSnapshot, type Snapshot } from "../src/worker/snapshot";
import { flip, ohlc, path, uptrend } from "./fixtures";

const H = 3_600_000;
const NOW = 1_800_000_000_000;

function snapshot(symbol: string, rows: [number, number, number, number][]): Snapshot {
  const c = ohlc(rows, NOW);
  return buildSnapshot({ symbol, now: NOW, candles: { "15m": c, "1h": c, "4h": c, "1d": c }, funding: null, openInterest: null });
}

const riskOn: MarketRegime = { mood: "risk_on", btcTrend: "up", breadth: 0.8, counted: 10 };
const riskOff: MarketRegime = { mood: "risk_off", btcTrend: "down", breadth: 0.2, counted: 10 };
const up = snapshot("ETHUSDT", path(uptrend(260)));
const down = snapshot("SOLUSDT", flip(path(uptrend(260)), 600));

describe("бал технічного аналізу", () => {
  it("висхідний тренд на ринку ризик-он дає лонг із високим балом, шорт із низьким", () => {
    const long = scoreSide(up, "long", riskOn);
    const short = scoreSide(up, "short", riskOn);
    expect(long.score).toBeGreaterThan(70);
    expect(short.score).toBeLessThan(30);
    expect(long.factors.some((f) => f.note.includes("ризик-он") && f.points > 0)).toBe(true);
    expect(long.score + short.score).toBeGreaterThan(0);
  });

  it("ринок проти угоди знижує бал", () => {
    expect(scoreSide(up, "long", riskOff).score).toBeLessThan(scoreSide(up, "long", riskOn).score);
  });

  it("бал у межах 0–100, ознаки впорядковані за вагою", () => {
    for (const side of ["long", "short"] as const) {
      const { score, factors } = scoreSide(down, side, riskOff);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      const weights = factors.map((f) => Math.abs(f.points));
      expect(weights).toEqual([...weights].sort((a, b) => b - a));
    }
  });

  it("для кожної монети береться кращий напрямок, найвищий бал першим", () => {
    const ranked = rankPicks([down, up], riskOn, { minStopPct: 1 });
    expect(ranked[0]!.symbol).toBe("ETHUSDT");
    expect(ranked[0]!.side).toBe("long");
    expect(ranked.find((o) => o.symbol === "SOLUSDT")!.side).toBe("short");
    expect(rankPicks([down, up], riskOn, { minStopPct: 1, top: 1 })).toHaveLength(1);
  });

  it("монета з відкритою ідеєю не береться знову", () => {
    const ranked = rankPicks([down, up], riskOn, { minStopPct: 1, exclude: new Set(["ETHUSDT"]) });
    expect(ranked.map((o) => o.symbol)).toEqual(["SOLUSDT"]);
    expect(rankPicks([down, up], riskOn, { minStopPct: 1, exclude: new Set(["ETHUSDT", "SOLUSDT"]) })).toEqual([]);
  });
});

describe("рівні ідеї", () => {
  it("стоп 1.5 ATR, ціль 2R; для шорта дзеркально", () => {
    expect(pickLevels("long", 100, 2, 1)).toEqual({ entry: 100, stop: 97, target: 106, stopPct: 3 });
    expect(pickLevels("short", 100, 2, 1)).toEqual({ entry: 100, stop: 103, target: 94, stopPct: 3 });
  });

  it("стоп не ближче min_stop_pct", () => {
    expect(pickLevels("long", 100, 0.2, 1)).toEqual({ entry: 100, stop: 99, target: 102, stopPct: 1 });
  });

  it("лімітний вхід нижче ціни для лонга, у межах відкату", () => {
    const [o] = rankPicks([up], riskOn, { minStopPct: 1 });
    if (o!.pullback) {
      expect(o!.pullback.entry).toBeLessThan(o!.price);
      expect(o!.pullback.stop).toBeLessThan(o!.pullback.entry);
    }
    expect(o!.market.entry).toBe(o!.price);
  });
});

describe("вибір моделі", () => {
  const options: PickOption[] = rankPicks([up, down], riskOn, { minStopPct: 1 });
  const answer = { choice: 1, entry: "market", probability_pct: 41, summary: "Шорт проти ринку", arguments_for: ["a"], arguments_against: ["b"], invalidation: "c" };

  it("вхід моделі без сирих свічок, з балом і рівнями від коду", () => {
    const input = pickInput({ options, snapshots: new Map([[up.symbol, up], [down.symbol, down]]), btc: null, market: riskOn, news: [], horizonHours: 24, minutesToMacro: null });
    expect(input.options).toHaveLength(2);
    expect(input.options[0]!.entry_market.stop).toBe(options[0]!.market.stop);
    expect(JSON.stringify(input)).not.toContain("openTime");
    expect(PICK_SCHEMA.required).toContain("choice");
  });

  it("перевіряє індекс і ймовірність", () => {
    expect(sanitizePick(answer, options).choice).toBe(1);
    expect(sanitizePick({ ...answer, probability_pct: 120 }, options).probability).toBe(0.95);
    expect(() => sanitizePick({ ...answer, choice: 5 }, options)).toThrow();
    expect(() => sanitizePick({ ...answer, choice: 0.5 }, options)).toThrow();
    expect(() => sanitizePick({ ...answer, probability_pct: "x" }, options)).toThrow();
  });

  it("лімітний вхід лише там, де код його порахував", () => {
    const noPullback = options.map((o) => ({ ...o, pullback: null }));
    expect(sanitizePick({ ...answer, entry: "pullback" }, noPullback).entry).toBe("market");
  });

  it("вибір моделі, відмова і робота без моделі", () => {
    const ai = sanitizePick(answer, options);
    expect(choosePick(options, ai)).toMatchObject({ verdict: "pick", option: { symbol: options[1]!.symbol }, entryKind: "market" });
    expect(choosePick(options, { ...ai, choice: -1 })).toMatchObject({ verdict: "pass", option: { symbol: options[0]!.symbol } });
    expect(choosePick(options, null)).toMatchObject({ verdict: "none", option: { symbol: options[0]!.symbol } });
    expect(choosePick([], null)).toBeNull();
  });
});

describe("результат ідеї", () => {
  const created = NOW;
  const trade = { side: "long" as const, entryKind: "market" as const, entry: 100, stop: 97, target: 106, createdAt: created, horizonMs: 24 * H };
  // Свічки 1h після ідеї: ohlc рахує час від закриття останньої.
  const after = (rows: [number, number, number, number][]) => ohlc(rows, created + rows.length * H);

  it("ціль раніше стопа", () => {
    const res = resolvePick(trade, after([[100, 102, 99, 101], [101, 106.5, 100, 106]]), created + 3 * H);
    expect(res).toMatchObject({ status: "target", resultR: 2 });
  });

  it("стоп має перевагу в одній свічці", () => {
    expect(resolvePick(trade, after([[100, 107, 96, 100]]), created + 2 * H).status).toBe("stop");
  });

  it("відкрита до горизонту, потім закриття за часом", () => {
    const rows = Array.from({ length: 24 }, () => [100, 101, 99, 101.5] as [number, number, number, number]);
    expect(resolvePick(trade, after(rows.slice(0, 5)), created + 5 * H).status).toBe("open");
    expect(resolvePick(trade, after(rows), created + 25 * H)).toMatchObject({ status: "expired", resultR: 0.5 });
  });

  it("лімітний вхід: без торкання ціни ідея не виконалась", () => {
    const limit = { ...trade, entryKind: "pullback" as const, entry: 99, stop: 96, target: 105 };
    const rows = Array.from({ length: 24 }, () => [100, 101, 99.5, 100] as [number, number, number, number]);
    expect(resolvePick(limit, after(rows), created + 25 * H)).toMatchObject({ status: "unfilled", resultR: null });
    const filled = resolvePick(limit, after([[100, 100.5, 98.8, 99.5], [99.5, 105.5, 99, 105]]), created + 3 * H);
    expect(filled.status).toBe("target");
    expect(filled.filledAt).not.toBeNull();
  });

  it("шорт дзеркально", () => {
    const short = { ...trade, side: "short" as const, stop: 103, target: 94 };
    expect(resolvePick(short, after([[100, 101, 93.5, 94]]), created + 2 * H)).toMatchObject({ status: "target", resultR: 2 });
  });
});

describe("облік ідей", () => {
  const fees = { makerPct: 0.02, takerPct: 0.05 };
  const base: PickRecord = {
    id: 1, created_at: "2026-11-17T10:00:00.000Z", symbol: "SOLUSDT", side: "long", entry_kind: "market", entry: 100, stop: 97, target: 106,
    score: 70, verdict: "pick", probability: 0.4, status: "target", result_r: 2, resolved_at: "2026-11-17T15:00:00.000Z", repeats: 0,
  };

  it("підтвердилась: ціль або закриття за часом у плюсі; програла: стоп або за часом у мінусі", () => {
    expect(outcome(base)).toBe("win");
    expect(outcome({ ...base, status: "stop", result_r: -1 })).toBe("loss");
    expect(outcome({ ...base, status: "expired", result_r: 0.4 })).toBe("win");
    expect(outcome({ ...base, status: "expired", result_r: -0.3 })).toBe("loss");
    expect(outcome({ ...base, status: "open", result_r: null })).toBe("open");
    expect(outcome({ ...base, status: "unfilled", result_r: null })).toBe("none");
  });

  it("результат після комісій: вхід за ринком taker, ціль maker, стоп taker", () => {
    // (100 × 0.05% + 106 × 0.02%) / 3 = 0.0237R
    expect(netR(base, fees)).toBe(1.98);
    // (100 × 0.05% + 97 × 0.05%) / 3 = 0.0328R
    expect(netR({ ...base, status: "stop", result_r: -1 }, fees)).toBe(-1.03);
    expect(netR({ ...base, status: "open", result_r: null }, fees)).toBeNull();
  });

  it("підсумок і розріз", () => {
    const rows: PickRecord[] = [
      base,
      { ...base, id: 2, status: "stop", result_r: -1 },
      { ...base, id: 3, side: "short", stop: 103, target: 94, status: "expired", result_r: -0.5, verdict: "pass", probability: null },
      { ...base, id: 4, status: "open", result_r: null },
      { ...base, id: 5, entry_kind: "pullback", status: "unfilled", result_r: null },
    ];
    const s = summarize(rows, fees);
    expect(s.all).toMatchObject({ ideas: 5, open: 1, unfilled: 1, wins: 1, losses: 2, target: 1, stop: 1, expired: 1 });
    expect(s.all.winRate).toBeCloseTo(1 / 3);
    expect(s.all.totalR).toBeCloseTo(1.98 - 1.03 - 0.53, 2);
    expect(s.byVerdict.pick).toMatchObject({ ideas: 4, wins: 1, losses: 1 });
    expect(s.bySide.short).toMatchObject({ ideas: 1, losses: 1 });
    expect(s.byEntry.pullback).toMatchObject({ ideas: 1, unfilled: 1 });
    expect(s.calibration).toEqual({ n: 2, predicted: 0.4, actual: 0.5 });
  });
});
