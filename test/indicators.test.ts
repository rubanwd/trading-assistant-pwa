import { describe, expect, it } from "vitest";
import { atr, ema, last, levels, percentileOfLast, pivots, rsi, sma, trueRange } from "../src/worker/indicators";
import { candles, fromCloses } from "./helpers";

describe("sma", () => {
  it("рахує середнє у вікні, до розгону NaN", () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(out.slice(2)).toEqual([2, 3, 4]);
  });
});

describe("ema", () => {
  it("починає з SMA і далі згладжує з k = 2/(n+1)", () => {
    const out = ema([1, 2, 3, 4, 5, 6], 3);
    expect(out.slice(0, 2).every(Number.isNaN)).toBe(true);
    // SMA(1,2,3)=2; k=0.5: 4*0.5+2*0.5=3; 5*0.5+3*0.5=4; 6*0.5+4*0.5=5
    expect(out.slice(2)).toEqual([2, 3, 4, 5]);
  });

  it("на сталій серії дорівнює константі", () => {
    expect(last(ema(new Array(50).fill(7), 20))).toBeCloseTo(7, 12);
  });

  it("повертає лише NaN, коли даних менше за період", () => {
    const out = ema([1, 2], 3);
    expect(out).toHaveLength(2);
    expect(out.every(Number.isNaN)).toBe(true);
    expect(last(out)).toBeNull();
  });

  it("коротша EMA ближча до ціни на зростанні", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + i);
    expect(last(ema(closes, 20))!).toBeGreaterThan(last(ema(closes, 50))!);
    expect(last(ema(closes, 50))!).toBeGreaterThan(last(ema(closes, 200))!);
  });
});

describe("rsi", () => {
  // Еталон: приклад Вайлдера з 14-періодним RSI (StockCharts, «RSI calculation»).
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0,
    46.03, 46.41, 46.22, 45.64, 46.21,
  ];

  it("збігається з еталонним прикладом", () => {
    const out = rsi(closes, 14);
    expect(out.slice(0, 14).every(Number.isNaN)).toBe(true);
    expect(out[14]).toBeCloseTo(70.46, 1);
    expect(out[15]).toBeCloseTo(66.25, 1);
    expect(out[16]).toBeCloseTo(66.48, 1);
    expect(out[17]).toBeCloseTo(69.35, 1);
    expect(out[18]).toBeCloseTo(66.29, 1);
    expect(out[19]).toBeCloseTo(57.92, 1);
    expect(out[20]).toBeCloseTo(62.88, 1);
  });

  it("100 без жодного падіння, 0 без жодного зростання, 50 на сталій ціні", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(last(rsi(up))).toBe(100);
    expect(last(rsi([...up].reverse()))).toBe(0);
    expect(last(rsi(new Array(30).fill(5)))).toBe(50);
  });

  it("лишається в межах 0..100", () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 10 + ((i * 7919) % 13));
    for (const v of rsi(noisy).filter(Number.isFinite)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe("atr", () => {
  it("істинний діапазон враховує розрив від попереднього закриття", () => {
    const c = candles([
      [10, 8, 9],
      [15, 13, 14], // розрив угору: max(2, |15-9|, |13-9|) = 6
      [12, 7, 8], // max(5, |12-14|, |7-14|) = 7
    ]);
    expect(trueRange(c)).toEqual([2, 6, 7]);
  });

  it("згладжує за Вайлдером, починаючи з середнього TR", () => {
    const c = candles([
      [10, 8, 9], // TR першої свічки в розрахунок не йде
      [11, 9, 10], // 2
      [13, 9, 12], // 4
      [14, 11, 13], // 3
      [19, 13, 18], // 6
    ]);
    const out = atr(c, 3);
    expect(out.slice(0, 3).every(Number.isNaN)).toBe(true);
    expect(out[3]).toBeCloseTo(3, 12); // (2+4+3)/3
    expect(out[4]).toBeCloseTo(4, 12); // (3*2+6)/3
  });

  it("на свічках сталого діапазону дорівнює цьому діапазону", () => {
    expect(last(atr(fromCloses(new Array(40).fill(100), 1), 14))).toBeCloseTo(2, 12);
  });
});

describe("pivots і levels", () => {
  // Пилка: вершини на 110 і 110.4, западини на 100 і 99.8.
  const zigzag = fromCloses([105, 107, 110, 107, 104, 100, 103, 106, 110.4, 107, 103, 99.8, 102, 105, 106], 0);

  it("знаходить підтверджені розворотні точки", () => {
    expect(pivots(zigzag, 2)).toEqual([
      { index: 2, price: 110, kind: "high" },
      { index: 5, price: 100, kind: "low" },
      { index: 8, price: 110.4, kind: "high" },
      { index: 11, price: 99.8, kind: "low" },
    ]);
  });

  it("не вважає точкою край серії, який ще не підтверджено", () => {
    const rising = fromCloses([1, 2, 3, 4, 5, 6, 7], 0);
    expect(pivots(rising, 2)).toEqual([]);
  });

  it("зливає близькі точки в рівень і ділить на підтримку й опір", () => {
    const l = levels(zigzag, 105, 1, { span: 2 });
    expect(l.resistance).toHaveLength(1);
    expect(l.resistance[0]!.price).toBeCloseTo(110.2, 10);
    expect(l.resistance[0]!.touches).toBe(2);
    expect(l.resistance[0]!.lastIndex).toBe(8);
    expect(l.support).toHaveLength(1);
    expect(l.support[0]!.price).toBeCloseTo(99.9, 10);
    expect(l.support[0]!.touches).toBe(2);
  });

  it("із нульовим допуском лишає точки окремими, найближчі першими", () => {
    const l = levels(zigzag, 105, 0, { span: 2 });
    expect(l.resistance.map((x) => x.price)).toEqual([110, 110.4]);
    expect(l.support.map((x) => x.price)).toEqual([100, 99.8]);
  });

  it("обмежує кількість рівнів з кожного боку", () => {
    const l = levels(zigzag, 105, 0, { span: 2, max: 1 });
    expect(l.resistance.map((x) => x.price)).toEqual([110]);
    expect(l.support.map((x) => x.price)).toEqual([100]);
  });
});

describe("percentileOfLast", () => {
  it("показує місце останнього значення у вікні", () => {
    expect(percentileOfLast([1, 2, 3, 4, 5], 5)).toBe(1);
    expect(percentileOfLast([5, 4, 3, 2, 1], 5)).toBe(0.2);
    expect(percentileOfLast([NaN, NaN, 3], 5)).toBeNull();
  });
});
