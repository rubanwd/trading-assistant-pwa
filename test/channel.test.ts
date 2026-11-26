import { describe, expect, it } from "vitest";
import { simulateChannel } from "../src/backtest/channel";
import { CHANNEL_DEFAULTS, channelConfig, isTubeBot } from "../src/shared/bots";
import { validateSettings } from "../src/shared/settings";
import {
  advanceChannel,
  candleExit,
  channelFeeR,
  channelFunding,
  channelR,
  channelSignal,
  channelStop,
  DAY_MS,
  fillChannel,
  nextLevels,
  openTrack,
  trailStop,
} from "../src/worker/bots/channel";
import type { Candle } from "../src/worker/market/types";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const day = (i: number) => T0 + i * DAY_MS;

type Row = [open: number, high: number, low: number, close: number];
const candle = (openTime: number, step: number, [open, high, low, close]: Row): Candle => ({ openTime, closeTime: openTime + step - 1, open, high, low, close, volume: 1 });
const daily = (rows: Row[], start = 0) => rows.map((r, i) => candle(day(start + i), DAY_MS, r));
/** n пласких діб: open/close 100, high 105, low 95. */
const flat = (n: number): Row[] => Array.from({ length: n }, () => [100, 105, 95, 100]);
/** Годинні свічки доби: однакові, крім вказаних годин. */
const hours = (d: number, base: Row, special: Record<number, Row> = {}) => Array.from({ length: 24 }, (_, h) => candle(day(d) + h * HOUR, HOUR, special[h] ?? base));

describe("Channel 20/10: сигнал", () => {
  it("лонг лише за закриттям вище максимуму 20 попередніх діб; свічка сигналу в канал не входить", () => {
    const s = channelSignal(daily([...flat(20), [100, 110, 99, 106]]), 20)!;
    expect(s).toMatchObject({ side: "long", upper: 105, lower: 95, close: 106, day: day(20) });
  });

  it("шорт за закриттям нижче мінімуму", () => {
    expect(channelSignal(daily([...flat(20), [100, 101, 90, 94]]), 20)!.side).toBe("short");
  });

  it("пробій лише тінню і рівність на межі сигналу не дають", () => {
    expect(channelSignal(daily([...flat(20), [100, 120, 80, 104]]), 20)!.side).toBeNull();
    expect(channelSignal(daily([...flat(20), [100, 106, 99, 105]]), 20)!.side).toBeNull();
    expect(channelSignal(daily([...flat(20), [100, 101, 94, 95]]), 20)!.side).toBeNull();
  });

  it("потрібна 21 послідовна завершена свічка", () => {
    expect(channelSignal(daily([...flat(19), [100, 110, 99, 106]]), 20)).toBeNull();
    const gap = daily([...flat(20), [100, 110, 99, 106]]);
    gap[3] = { ...gap[3]!, openTime: gap[3]!.openTime + 1 };
    expect(channelSignal(gap, 20)).toBeNull();
  });
});

describe("Channel 20/10: стоп", () => {
  it("початковий стоп — канал 10 діб разом зі свічкою сигналу", () => {
    const d = daily([...flat(10), [100, 110, 93, 106]]);
    expect(channelStop(d, "long", 10)).toBe(93);
    expect(channelStop(d, "short", 10)).toBe(110);
  });

  it("стоп ніколи не послаблюється", () => {
    expect(trailStop("long", 99, 95)).toBe(99);
    expect(trailStop("short", 101, 105)).toBe(101);
  });

  it("вихід у свічці: за стопом або за Open, якщо свічка відкрилась за ним", () => {
    expect(candleExit("long", 95, candle(0, HOUR, [97, 98, 94, 96]))).toEqual({ price: 95, gap: false });
    expect(candleExit("long", 95, candle(0, HOUR, [90, 92, 88, 91]))).toEqual({ price: 90, gap: true });
    expect(candleExit("short", 105, candle(0, HOUR, [104, 104.5, 103, 104]))).toBeNull();
  });
});

describe("Channel 20/10: вхід і супровід", () => {
  const signalDays = daily([...flat(25), [100, 107, 99, 106]]);

  it("вхід за Open першої свічки після постановки; ціна вже за стопом — пропуск", () => {
    const m15 = [candle(day(26), 900_000, [107, 108, 106, 107]), candle(day(26) + 900_000, 900_000, [107.5, 108, 107, 107.5])];
    const placedAt = day(26) + 3 * 60_000;
    expect(fillChannel({ side: "long", stop: 95, placedAt, expiresAt: placedAt + HOUR }, m15, placedAt + HOUR)).toEqual({ status: "open", filledAt: day(26) + 900_000, entry: 107.5 });
    expect(fillChannel({ side: "long", stop: 108, placedAt, expiresAt: placedAt + HOUR }, m15, placedAt + HOUR)).toMatchObject({ status: "cancelled", reason: "beyond_stop" });
    expect(fillChannel({ side: "long", stop: 95, placedAt: day(27), expiresAt: day(27) + HOUR }, m15, day(27) + 10)).toEqual({ status: "pending" });
    expect(fillChannel({ side: "long", stop: 95, placedAt: day(27), expiresAt: day(27) + HOUR }, m15, day(27) + HOUR)).toMatchObject({ status: "cancelled", reason: "no_price" });
  });

  it("стоп у день входу", () => {
    const track = openTrack("long", 107, 95, day(26), day(25));
    const intraday = hours(26, [107, 108, 104, 106], { 5: [104, 105, 94, 96] });
    const adv = advanceChannel(track, signalDays, intraday, day(27) - 1, 10);
    expect(adv.exit).toMatchObject({ price: 95, from: day(26) + 5 * HOUR, gap: false, daily: false });
    expect(channelR(adv.track, 95)).toBe(-1);
  });

  it("новий стоп після закриття доби діє лише з наступної доби; геп за стопом — вихід за Open", () => {
    // Після закриття 36-ї доби канал 27…36 дає Low 106 → стоп 106. Low 36-ї доби 106.5 вище; 37-ма відкрилась на 104.
    const rows: Row[] = [...flat(25), [100, 107, 99, 106]];
    for (let i = 26; i <= 36; i++) rows.push([107, 109, i === 26 ? 104 : 106.5, 108]);
    const d = daily(rows);
    const intraday = [...Array.from({ length: 11 }, (_, k) => hours(26 + k, [107, 109, k === 0 ? 104 : 106.5, 108])).flat(), ...hours(37, [104, 105, 103, 104])];
    const adv = advanceChannel(openTrack("long", 107, 95, day(26), day(25)), d, intraday, day(38), 10);
    expect(adv.trailed.at(-1)).toEqual({ day: day(36), stop: 106.5 });
    expect(adv.exit).toMatchObject({ from: day(37), price: 104, gap: true });
  });

  it("стоп не послаблюється, навіть якщо канал нижчий", () => {
    const d = daily([...flat(25), [100, 107, 99, 106], [107, 108, 104, 107]]);
    const track = { ...openTrack("long", 107, 95, day(26), day(25)), stop: 99 };
    const adv = advanceChannel(track, d, hours(26, [107, 108, 104, 107]), day(27) + 1, 10);
    expect(adv.track.stop).toBe(99);
    expect(adv.exit).toBeNull();
  });

  it("без дрібніших свічок перевіряє денними; стан переживає повторний виклик", () => {
    const d = daily([...flat(25), [100, 107, 99, 106], [107, 108, 104, 107], [107, 108, 94, 96]]);
    const first = advanceChannel(openTrack("long", 107, 95, day(26), day(25)), d.slice(0, 27), [], day(27), 10);
    expect(first.exit).toBeNull();
    expect(first.track.checkedTo).toBe(day(27));
    const second = advanceChannel(first.track, d, [], day(28), 10);
    expect(second.exit).toMatchObject({ from: day(27), price: 95, daily: true });
  });
});

describe("Channel 20/10: фандинг і витрати", () => {
  const track = { side: "long" as const, entry: 100, initialStop: 90 };
  const price = () => 100;

  it("додатна ставка: лонг платить, шорт отримує; від'ємна — навпаки; нарахування в момент входу не належить позиції", () => {
    const ev = [{ at: 0, rate: 0.001 }, { at: 8 * HOUR, rate: 0.001 }];
    expect(channelFunding(track, ev, 0, null, 10 * HOUR, price)).toEqual({ r: -0.01, events: 1, ambiguous: 0 });
    expect(channelFunding({ ...track, side: "short", initialStop: 110 }, ev, 0, null, 10 * HOUR, price).r).toBe(0.01);
    expect(channelFunding(track, [{ at: 8 * HOUR, rate: -0.001 }], 0, null, 10 * HOUR, price).r).toBe(0.01);
  });

  it("нарахування в свічці виходу: витрата враховується, дохід — ні", () => {
    const exit = { from: 8 * HOUR, to: 9 * HOUR - 1 };
    expect(channelFunding(track, [{ at: 8 * HOUR, rate: 0.001 }], 0, exit, 0, price)).toEqual({ r: -0.01, events: 1, ambiguous: 1 });
    expect(channelFunding(track, [{ at: 8 * HOUR, rate: -0.001 }], 0, exit, 0, price)).toEqual({ r: 0, events: 0, ambiguous: 1 });
    expect(channelFunding(track, [{ at: 16 * HOUR, rate: 0.001 }], 0, exit, 0, price).events).toBe(0);
  });

  it("комісії taker на вході й виході в R", () => {
    expect(channelFeeR(track, 120, { makerPct: 0.02, takerPct: 0.05 })).toBeCloseTo((100 * 0.0005 + 120 * 0.0005) / 10, 6);
  });

  it("межі на наступне закриття", () => {
    expect(nextLevels(daily([...flat(19), [100, 110, 90, 100]]), { entryDays: 20, exitDays: 10 })).toEqual({ upper: 110, lower: 90, longStop: 90, shortStop: 110 });
  });
});

describe("Channel 20/10: бектест", () => {
  it("вхід наступного дня за Open, сигнали за відкритої позиції ігноруються", () => {
    const rows: Row[] = [...flat(25), [100, 107, 99, 106], [107, 109, 104, 108], [108, 115, 107, 114], [114, 116, 94, 96], ...flat(5)];
    const d = daily(rows);
    const intraday = d.flatMap((c, i) => hours(i, [c.open, c.high, c.low, c.close]));
    const { trades, stats } = simulateChannel(d, intraday, [], day(20), day(40), { cfg: { entryDays: 20, exitDays: 10 }, fees: { makerPct: 0, takerPct: 0 }, slippagePct: 0 });
    expect(trades[0]).toMatchObject({ side: "long", filledAt: day(26), entry: 107, initialStop: 95 });
    expect(trades[0]!.exit!.from).toBe(day(28));
    expect(trades[0]!.netR).toBe(-1);
    expect(stats.ignored).toBeGreaterThan(0);
    expect(stats.entered).toBe(trades.length);
  });
});

describe("Channel 20/10: налаштування", () => {
  it("стартові значення й перевірка", () => {
    expect(channelConfig({})).toEqual(CHANNEL_DEFAULTS);
    expect(channelConfig({ chn_entry_days: 55, chn_exit_days: 2.5, chn_symbol: "ETHUSDT" })).toMatchObject({ entryDays: 55, exitDays: 10, symbol: "ETHUSDT" });
    expect(isTubeBot("c2010")).toBe(false);
    expect(validateSettings({ chn_entry_days: 20, chn_enabled: "off", chn_symbol: "btcusdt" })).toEqual({ values: { chn_entry_days: 20, chn_enabled: "off", chn_symbol: "BTCUSDT" }, errors: {} });
    expect(Object.keys(validateSettings({ chn_exit_days: 1 }).errors)).toEqual(["chn_exit_days"]);
  });
});
