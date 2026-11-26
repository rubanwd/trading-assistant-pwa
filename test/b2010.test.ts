import { describe, expect, it } from "vitest";
import { runBacktest, type BacktestConfig, type BacktestInput } from "../src/b2010/backtest";
import { dec } from "../src/b2010/decimal";
import { checkCandles, checkFunding } from "../src/b2010/history";
import { summarize } from "../src/b2010/report";
import { adverse, sizePosition } from "../src/b2010/sizing";
import { channelStop, DAY_MS, evaluateEntry, HOUR_MS, loosens, roundStop, stopReached, trailStop } from "../src/b2010/strategy";
import type { Candle } from "../src/b2010/types";
import { d, daily, day, flat, SPEC } from "./b2010.helpers";

const cfg = (over: Partial<BacktestConfig> = {}): BacktestConfig => ({
  from: day(20),
  to: day(40),
  balance: dec(500),
  riskFraction: dec("0.005"),
  takerFee: dec(0),
  slippage: dec(0),
  leverage: dec(1),
  spec: SPEC,
  spotFee: dec(0),
  ...over,
});

const input = (candles: Candle[], extra: Partial<BacktestInput> = {}): BacktestInput => ({ daily: candles, hourly: [], markHourly: [], funding: [], spotDaily: [], ...extra });

/** 25 пласких днів, далі рядки з rows, далі пласкі до 41 дня. */
const series = (rows: [number, number, number, number][], tail: [number, number, number, number] = [100, 105, 95, 100]) => {
  const all = [...flat(25), ...rows];
  while (all.length < 41) all.push(tail);
  return daily(all);
};

describe("b2010: правило входу", () => {
  it("лонг лише за закриттям вище upper20, свічка t у канал не входить", () => {
    const c = daily([...flat(20), [100, 110, 99, 106]]);
    const ev = evaluateEntry(c);
    expect(ev.kind).toBe("signal");
    if (ev.kind === "signal") {
      expect(ev.side).toBe("long");
      expect(ev.upper.toString()).toBe("105");
      expect(ev.lower.toString()).toBe("95");
    }
  });

  it("шорт за закриттям нижче lower20", () => {
    const ev = evaluateEntry(daily([...flat(20), [100, 101, 90, 94]]));
    expect(ev.kind === "signal" && ev.side).toBe("short");
  });

  it("пробій лише тінню не дає сигналу", () => {
    expect(evaluateEntry(daily([...flat(20), [100, 120, 80, 104]])).kind).toBe("none");
  });

  it("рівність на межі не дає сигналу", () => {
    expect(evaluateEntry(daily([...flat(20), [100, 106, 99, 105]])).kind).toBe("none");
    expect(evaluateEntry(daily([...flat(20), [100, 101, 94, 95]])).kind).toBe("none");
  });

  it("потрібна 21 послідовна свічка", () => {
    expect(evaluateEntry(daily([...flat(19), [100, 110, 99, 106]])).kind).toBe("insufficient");
    const gap = daily([...flat(20), [100, 110, 99, 106]]);
    gap[5] = { ...gap[5], openTime: gap[5].openTime + 1 };
    expect(evaluateEntry(gap).kind).toBe("insufficient");
  });
});

describe("b2010: стоп", () => {
  it("початковий стоп — мінімум/максимум 10 свічок разом зі свічкою t", () => {
    const c = daily([...flat(10), [100, 110, 93, 106]]);
    expect(channelStop(c, "long")!.toString()).toBe("93");
    expect(channelStop(c, "short")!.toString()).toBe("110");
  });

  it("стоп лише в бік зменшення ризику", () => {
    expect(trailStop("long", d(99), d(95)).toString()).toBe("99");
    expect(trailStop("long", d(95), d(99)).toString()).toBe("99");
    expect(trailStop("short", d(101), d(105)).toString()).toBe("101");
    expect(loosens("long", d(99), d(95))).toBe(true);
    expect(loosens("short", d(101), d(105))).toBe(true);
  });

  it("округлення до tickSize від ціни: лонг вниз, шорт угору", () => {
    expect(roundStop("long", d("95.07"), d("0.1")).toString()).toBe("95");
    expect(roundStop("short", d("105.01"), d("0.1")).toString()).toBe("105.1");
  });

  it("спрацювання за LastPrice: лонг ≤, шорт ≥", () => {
    expect(stopReached("long", d(95), d(95))).toBe(true);
    expect(stopReached("long", d(95), d("95.1"))).toBe(false);
    expect(stopReached("short", d(105), d(105))).toBe(true);
  });
});

describe("b2010: розмір позиції", () => {
  it("контрольний приклад: 500 USDT, E 100000, X 95000, без комісій — 0.0005 BTC, при кроці 0.001 угоду пропущено", () => {
    const r = sizePosition({
      side: "long",
      equity: d(500),
      riskFraction: d("0.005"),
      entry: d(100000),
      stopExec: d(95000),
      fee: d(0),
      availableMargin: d(500),
      leverage: d(1),
      spec: { qtyStep: d("0.001"), minOrderQty: d("0.001"), minNotional: d(5), maxMktOrderQty: d(100) },
    });
    expect(r.riskBudget!.toString()).toBe("2.5");
    expect(r.rawQty!.toString()).toBe("0.0005");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("qty_below_min");
  });

  it("комісії входять у збиток на одиницю, кількість округлюється вниз", () => {
    const r = sizePosition({
      side: "short",
      equity: d(1000),
      riskFraction: d("0.005"),
      entry: d(100),
      stopExec: d(110),
      fee: d("0.001"),
      availableMargin: d(1000),
      leverage: d(1),
      spec: { qtyStep: d("0.01"), minOrderQty: d("0.01"), minNotional: d(5), maxMktOrderQty: d(100) },
    });
    expect(r.ok).toBe(true);
    // lossPerUnit = 10 + 0.1 + 0.11 = 10.21; raw = 5 / 10.21 = 0.4897…
    if (r.ok) {
      expect(r.lossPerUnit.toString()).toBe("10.21");
      expect(r.qty.toString()).toBe("0.48");
    }
  });

  it("обмеження маржею при плечі 1x і замалий номінал", () => {
    const base = { side: "long" as const, riskFraction: d("0.5"), entry: d(100), stopExec: d(99), fee: d(0), leverage: d(1), spec: { qtyStep: d("0.001"), minOrderQty: d("0.001"), minNotional: d(5), maxMktOrderQty: d(100) } };
    const r = sizePosition({ ...base, equity: d(1000), availableMargin: d(200) });
    expect(r.ok && r.cappedBy).toBe("margin");
    expect(r.ok && r.qty.toString()).toBe("2");
    const small = sizePosition({ ...base, equity: d(4), availableMargin: d(4) });
    expect(!small.ok && small.reason).toBe("notional_below_min");
  });

  it("прослизання несприятливе", () => {
    expect(adverse(d(100), "Buy", d("0.001")).toString()).toBe("100.1");
    expect(adverse(d(100), "Sell", d("0.001")).toString()).toBe("99.9");
  });
});

describe("b2010: бектест", () => {
  it("лонг: вхід наступного дня за Open з прослизанням, вихід за трейлінг-стопом", () => {
    // День 25: закриття 106 > 105 — сигнал. День 26: Open 107 — вхід. Стоп 95.
    const c = series([
      [100, 107, 99, 106],
      [107, 109, 104, 108],
      [108, 112, 107, 111],
      [111, 112, 94, 96],
    ]);
    const r = runBacktest(input(c), cfg({ slippage: dec("0.001") }));
    expect(r.signals[0]).toMatchObject({ day: day(25), side: "long", status: "entered" });
    const t = r.trades[0];
    expect(t.entryTime).toBe(day(26));
    expect(t.entryBase.toString()).toBe("107");
    expect(t.entryPrice.toString()).toBe("107.107");
    expect(t.initialStop.toString()).toBe("95");
    expect(t.exitTime).toBe(day(28));
    expect(t.exitReason).toBe("stop");
    expect(t.exitPrice!.toString()).toBe(adverse(d(95), "Sell", d("0.001")).toString());
  });

  it("шорт симетрично", () => {
    const c = series([
      [100, 101, 93, 94],
      [93, 96, 90, 91],
      [91, 106, 90, 104],
    ]);
    const r = runBacktest(input(c), cfg());
    const t = r.trades[0];
    expect(t.side).toBe("short");
    expect(t.entryBase.toString()).toBe("93");
    expect(t.initialStop.toString()).toBe("105");
    expect(t.exitReason).toBe("stop");
    expect(t.exitBase!.toString()).toBe("105");
    expect(t.net.lt(0)).toBe(true);
  });

  it("стоп у день входу", () => {
    const c = series([
      [100, 107, 99, 106],
      [107, 108, 94, 100],
    ]);
    const t = runBacktest(input(c), cfg()).trades[0];
    expect(t.entryTime).toBe(day(26));
    expect(t.exitTime).toBe(day(26));
    expect(t.exitBase!.toString()).toBe("95");
  });

  it("геп за стопом: вихід за Open доби з прослизанням", () => {
    const c = series([
      [100, 107, 99, 106],
      [107, 109, 104, 108],
      [90, 92, 88, 91],
    ]);
    const t = runBacktest(input(c), cfg({ slippage: dec("0.001") })).trades[0];
    expect(t.exitReason).toBe("gap_stop");
    expect(t.exitBase!.toString()).toBe("90");
    expect(t.exitPrice!.toString()).toBe("89.91");
  });

  it("новий стоп після закриття діє лише з наступної доби", () => {
    // Свічка 26 має Low 104; після закриття 30 вікно 21..30 дає мін. Low 95 → 101? Будуємо підйом лоу.
    const rows: [number, number, number, number][] = [[100, 107, 99, 106]];
    for (let i = 0; i < 10; i++) rows.push([106 + i, 108 + i, 104 + i, 107 + i]);
    rows.push([117, 118, 112, 113]); // день 36: Low 112 — нижче нового стопа 113 (мін. Low 27..36 після закриття), вище чинного
    const c = series(rows, [113, 114, 112.5, 113]);
    const r = runBacktest(input(c), cfg());
    const t = r.trades[0];
    expect(t.exitTime === null || t.exitTime > day(36)).toBe(true);
  });

  it("сигнал за відкритої позиції ігнорується", () => {
    const c = series([
      [100, 107, 99, 106],
      [107, 109, 104, 108],
      [108, 115, 107, 114],
    ]);
    const r = runBacktest(input(c), cfg());
    expect(r.trades).toHaveLength(1);
    expect(r.signals.filter((s) => s.status === "ignored").every((s) => s.reason === "position_open")).toBe(true);
    expect(r.signals.some((s) => s.status === "ignored")).toBe(true);
  });

  it("замалий ордер — пропуск із причиною, не округлення вгору", () => {
    const c = series([
      [100, 107, 99, 106],
      [107, 109, 104, 108],
    ]);
    const r = runBacktest(input(c), cfg({ balance: dec("0.5"), spec: { ...SPEC, qtyStep: dec(1), minOrderQty: dec(1) } }));
    expect(r.trades).toHaveLength(0);
    expect(r.signals[0]).toMatchObject({ status: "skipped", reason: "qty_below_min" });
  });

  it("ціна на старті вже за стопом — вхід пропущено", () => {
    const c = series([
      [100, 107, 99, 106],
      [94, 96, 90, 95],
    ]);
    const r = runBacktest(input(c), cfg());
    expect(r.signals[0]).toMatchObject({ status: "skipped", reason: "price_beyond_stop" });
  });

  const fundingCase = (rate: string, rows: [number, number, number, number][]) => {
    const c = series(rows);
    const funding = [{ ts: day(27) + 8 * HOUR_MS, rate: dec(rate) }];
    const markHourly = [{ openTime: day(27) + 8 * HOUR_MS, open: d(108), high: d(108), low: d(108), close: d(108) }];
    return runBacktest(input(c, { funding, markHourly }), cfg());
  };
  const longRows: [number, number, number, number][] = [
    [100, 107, 99, 106],
    [107, 109, 104, 108],
    [108, 110, 106, 108],
  ];
  const shortRows: [number, number, number, number][] = [
    [100, 101, 93, 94],
    [93, 96, 90, 91],
    [91, 95, 89, 92],
  ];

  it("фандинг: додатна ставка — лонг платить, шорт отримує", () => {
    const l = fundingCase("0.0001", longRows);
    const lt = l.trades[0];
    expect(lt.funding.toString()).toBe(lt.qty.mul(108).mul("0.0001").neg().toString());
    const s = fundingCase("0.0001", shortRows);
    expect(s.trades[0].funding.gt(0)).toBe(true);
  });

  it("фандинг: від'ємна ставка — лонг отримує, шорт платить", () => {
    expect(fundingCase("-0.0001", longRows).trades[0].funding.gt(0)).toBe(true);
    expect(fundingCase("-0.0001", shortRows).trades[0].funding.lt(0)).toBe(true);
  });

  it("стоп і фандинг в одній годині: дохід консервативно не враховано, витрату враховано", () => {
    const rows: [number, number, number, number][] = [
      [100, 107, 99, 106],
      [107, 109, 104, 108],
      [108, 109, 94, 96],
    ];
    const c = series(rows);
    const ts = day(27) + 8 * HOUR_MS;
    const hourly: Candle[] = [];
    for (let h = 0; h < 24; h++) hourly.push({ openTime: day(27) + h * HOUR_MS, open: d(108), high: d(109), low: h === 8 ? d(94) : d(100), close: d(100) });
    const income = runBacktest(input(c, { hourly, funding: [{ ts, rate: dec("-0.0001") }] }), cfg());
    expect(income.funding[0]).toMatchObject({ ambiguous: true, applied: false });
    expect(income.trades[0].funding.toString()).toBe("0");
    const cost = runBacktest(input(c, { hourly, funding: [{ ts, rate: dec("0.0001") }] }), cfg());
    expect(cost.funding[0]).toMatchObject({ ambiguous: true, applied: true });
    // Нарахування до години стопа — враховано, після — ні.
    const before = runBacktest(input(c, { hourly, funding: [{ ts: day(27), rate: dec("-0.0001") }, { ts: day(27) + 16 * HOUR_MS, rate: dec("0.0001") }] }), cfg());
    expect(before.funding.map((f) => f.applied)).toEqual([true]);
    expect(before.trades[0].funding.gt(0)).toBe(true);
  });

  it("підсумок: складники дають результат без подвійного списання; просадка за денною equity", () => {
    const c = series([
      [100, 107, 99, 106],
      [107, 109, 104, 108],
      [108, 112, 107, 111],
      [111, 112, 94, 96],
    ]);
    const r = runBacktest(input(c, { funding: [{ ts: day(27), rate: dec("0.0003") }] }), cfg({ takerFee: dec("0.00055"), slippage: dec("0.0005") }));
    const s = summarize(r);
    expect(s.price.sub(s.slippage).sub(s.fees).add(s.funding).toFixed(10)).toBe(s.pnl.toFixed(10));
    expect(s.maxDrawdown.gt(0)).toBe(true);
    expect(s.trades).toBe(1);
    expect(s.long.trades).toBe(1);
  });

  it("відкрита на кінець позиція з нереалізованим результатом", () => {
    const c = series(
      [
        [100, 107, 99, 106],
        [107, 109, 104, 108],
      ],
      [108, 110, 106, 109],
    );
    const r = runBacktest(input(c), cfg({ to: day(30) }));
    expect(r.open).not.toBeNull();
    expect(r.open!.unrealized.toString()).toBe(r.open!.qty.mul(2).toString());
  });
});

describe("b2010: перевірка даних", () => {
  it("порядок, повтори й пропуски", () => {
    const c = daily(flat(5));
    const messy = [c[2], c[0], c[1], c[1], { ...c[3], close: d(1) }, c[3]];
    const r = checkCandles("x", messy, DAY_MS);
    expect(r.check.unordered).toBeGreaterThan(0);
    expect(r.check.duplicates).toBe(1);
    expect(r.check.conflicting).toBe(1);
    expect(r.check.gaps).toHaveLength(0);
    const gap = checkCandles("y", [c[0], c[2]], DAY_MS);
    expect(gap.check.gaps).toEqual([{ from: c[1].openTime, to: c[2].openTime - 1 }]);
    const f = checkFunding([{ ts: 0, rate: d(0) }, { ts: 16 * HOUR_MS, rate: d(0) }]);
    expect(f.check.gaps).toHaveLength(1);
  });
});
