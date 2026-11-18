import { describe, expect, it } from "vitest";
import type { Candle } from "../src/worker/market/types";
import { daysOf, metricsFromCsv, metricsToCsv, parseFunding, parseMetrics } from "../src/research/data";
import { buildRows, FEATURES, outcome, toBin, trailingRanks, type Row } from "../src/research/features";
import { ALL, breakoutSplits, DEFAULT_SEARCH, searchPatterns } from "../src/research/patterns";
import { benjaminiHochberg, ClusterMean, normalCdf } from "../src/research/stats";

const HOUR = 3_600_000;
const T0 = Date.parse("2024-03-01T00:00:00Z");

const candle = (openTime: number, o: number, h: number, l: number, c: number, step = HOUR): Candle => ({
  openTime, closeTime: openTime + step - 1, open: o, high: h, low: l, close: c, volume: 1,
});

describe("архів метрик", () => {
  it("зводить 5-хвилинні записи до годинних: останній відкритий інтерес, середні купівлі/продажі", () => {
    const csv = [
      "create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio",
      "2024-03-01 00:00:00,ETHUSDT,100,300000,2.5,1.9,2.2,1.0",
      "2024-03-01 00:55:00,ETHUSDT,110,330000,2.5,2.0,2.3,2.0",
      "2024-03-01 01:00:00,ETHUSDT,120,360000,2.5,2.1,2.4,0.5",
    ].join("\n");
    const points = parseMetrics(csv);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ at: T0 + HOUR, oi: 110, oiUsd: 330000, topLsr: 2.0, lsr: 2.3, taker: 1.5 });
    expect(points[1]!.at).toBe(T0 + 2 * HOUR);
    expect(metricsFromCsv(metricsToCsv(points))).toEqual(points);
  });

  it("зводить фандинг до 8 годин", () => {
    const f = parseFunding("calc_time,funding_interval_hours,last_funding_rate\n1709251200000,8,0.0005\n1709265600000,4,0.0002\n");
    expect(f.map((x) => x.rate)).toEqual([0.0005, 0.0004]);
  });

  it("дні місяця", () => {
    expect(daysOf("2024-02")).toHaveLength(29);
    expect(daysOf("2025-11").at(-1)).toBe("2025-11-30");
  });
});

describe("результат після сигналу", () => {
  const h1 = [candle(T0, 100, 100.5, 99.5, 100), candle(T0 + HOUR, 100, 101.2, 99.8, 101), candle(T0 + 2 * HOUR, 101, 101, 98, 98)];

  it("перший зачеплений бар'єр вирішує результат", () => {
    const o = outcome(h1, T0, 100, 1, 3, 0)!;
    expect(o).toEqual({ move: 1, longNet: 1, shortNet: -1 });
  });

  it("обидва бар'єри в одній свічці: рух 0, обидві угоди в стопі", () => {
    const o = outcome([candle(T0, 100, 102, 98, 100)], T0, 100, 1, 1, 0)!;
    expect(o).toEqual({ move: 0, longNet: -1, shortNet: -1 });
  });

  it("без бар'єра — зміна до кінця горизонту мінус комісії", () => {
    const o = outcome(h1.slice(0, 1), T0, 100, 2, 1, 0.05)!;
    // Комісія 2 × 0.05% при одиниці 2% від ціни = 0.05R.
    expect(o.move).toBe(0);
    expect(o.longNet).toBeCloseTo(-0.05);
  });

  it("немає даних до кінця горизонту — null", () => {
    expect(outcome(h1.slice(0, 1), T0, 100, 2, 5, 0)).toBeNull();
  });
});

describe("перцентилі", () => {
  it("перцентиль у ковзному вікні, без заглядання вперед", () => {
    const r = trailingRanks([1, 2, 3, 4, null, 0], 3, 2);
    expect(r[0]).toBeNull();
    expect(r[1]).toBeCloseTo(0.75);
    expect(r[3]).toBeCloseTo(5 / 6);
    expect(r[4]).toBeNull();
    // У вікні лишились 4 і 0: нуль найменший.
    expect(r[5]).toBeCloseTo(0.25);
    expect([0, 0.19, 0.2, 0.99, 1].map(toBin)).toEqual([0, 0, 1, 4, 4]);
  });
});

describe("статистика", () => {
  it("кластерна похибка: однакові значення в кластері не додають незалежних спостережень", () => {
    const a = new ClusterMean();
    const b = new ClusterMean();
    const xs = [1, -1, 1, -1, 1, -1, 1, -1];
    xs.forEach((x, i) => {
      a.add(i, x, 0, 0);
      for (let k = 0; k < 10; k++) b.add(i, x, 0, 0);
    });
    expect(a.stat().mean).toBe(0);
    expect(b.stat().n).toBe(80);
    expect(b.stat().se).toBeCloseTo(a.stat().se);
  });

  it("нормальний розподіл і поправка Бенджаміні — Гохберга", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(benjaminiHochberg([0.001, 0.04, 0.03, 0.5], 0.05)).toEqual([true, false, false, false]);
    expect(benjaminiHochberg([0.01, 0.02, 0.03, 0.04], 0.05)).toEqual([true, true, true, true]);
  });
});

/** Синтетичні рядки: у монеті A високий квінтиль ознаки 0 означає рух униз, решта — шум. */
function synthetic(seed = 3): Row[] {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const rows: Row[] = [];
  for (let i = 0; i < 6000; i++) {
    const t = T0 + i * 4 * HOUR;
    for (const symbol of ["AUSDT", "BUSDT"]) {
      const bins = new Int8Array(FEATURES.length).map(() => Math.floor(rand() * 5));
      const edge = symbol === "AUSDT" && bins[0] === 4 ? -0.4 : 0;
      const move = Math.max(-1, Math.min(1, edge + (rand() - 0.5) * 2));
      rows.push({ symbol, t, raw: [], bins, move, longNet: move - 0.05, shortNet: -move - 0.05 });
    }
  }
  return rows;
}

describe("пошук закономірностей", () => {
  const rows = synthetic();
  const split = T0 + 3000 * 4 * HOUR;
  const r = searchPatterns(rows, { ...DEFAULT_SEARCH, split });

  it("знаходить закладену закономірність і підтверджує її на тесті", () => {
    const hit = r.confirmed.find((p) => p.slice === "AUSDT" && p.conditions.length === 1 && p.conditions[0]!.feature === FEATURES[0] && p.conditions[0]!.bin === 4);
    expect(hit?.side).toBe("short");
    expect(hit!.test!.short).toBeGreaterThan(0);
  });

  it("не підтверджує шум у монеті без закономірності", () => {
    expect(r.confirmed.filter((p) => p.slice === "BUSDT")).toEqual([]);
    // Пари з тією самою ознакою не сильніші за неї окремо.
    for (const p of r.confirmed.filter((x) => x.conditions.length === 2)) expect(p.lift!.train).toBeGreaterThan(0);
  });

  it("клітинка за весь період і база", () => {
    expect(r.base[ALL]!.train.n + r.base[ALL]!.test.n).toBeLessThanOrEqual(rows.length);
    const st = r.cell("AUSDT", [{ feature: FEATURES[0], bin: 4 }], 2)!;
    expect(st.mean).toBeLessThan(-0.2);
  });

  it("пробої за ознаками: шорти дзеркаляться для ознак з напрямом", () => {
    const sample = rows.filter((x) => x.symbol === "AUSDT").slice(0, 4000);
    const trades = sample.map((x) => ({ symbol: x.symbol, side: "short" as const, createdAt: x.t, netR: x.bins[0] === 4 ? -1 : 0.2 }));
    const res = breakoutSplits(trades, sample, split);
    const ret = res.find((s) => s.feature === FEATURES[0])!;
    // ret_24h має напрям: для шорта верхній квінтиль стає нижнім.
    expect(ret.directional).toBe(true);
    expect(ret.train.low.mean).toBeLessThan(ret.train.high.mean);
  });
});

describe("рядки з монети", () => {
  it("будує ознаки та результат лише з того, що вже відомо", () => {
    const h1: Candle[] = [];
    for (let i = 0; i < 24 * 400; i++) h1.push(candle(T0 + i * HOUR, 100 + Math.sin(i / 30) * 5, 100 + Math.sin(i / 30) * 5 + 1, 100 + Math.sin(i / 30) * 5 - 1, 100 + Math.sin((i + 1) / 30) * 5));
    const h4: Candle[] = [];
    for (let i = 0; i + 4 <= h1.length; i += 4) {
      const g = h1.slice(i, i + 4);
      h4.push({ openTime: g[0]!.openTime, closeTime: g[3]!.closeTime, open: g[0]!.open, high: Math.max(...g.map((c) => c.high)), low: Math.min(...g.map((c) => c.low)), close: g[3]!.close, volume: 4 });
    }
    const metrics = h1.map((c, i) => ({ at: c.closeTime + 1, oi: 1000 + i, oiUsd: 1e5, topLsr: 1.5, lsr: 2, taker: 1 }));
    const rows = buildRows({ symbol: "XUSDT", h1, h4, metrics, funding: [] }, new Map(), 24, 0.05);
    expect(rows.length).toBeGreaterThan(1000);
    const last = rows[rows.length - 1]!;
    // Результат відомий: або бар'єр зачеплено в межах даних, або горизонт закінчився.
    expect(last.t).toBeLessThan(h1[h1.length - 1]!.closeTime);
    const oi = FEATURES.indexOf("oi_chg_24h");
    // Відкритий інтерес росте рівно на 24 за добу; береться точка, відома на момент t.
    const cur = metrics.find((m) => m.at === last.t)!;
    expect(last.raw[oi]).toBeCloseTo(24 / (cur.oi - 24), 9);
    expect(last.bins[FEATURES.indexOf("funding")]).toBe(-1);
  });
});
