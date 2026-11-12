import { describe, expect, it } from "vitest";
import { marketRegime, trend, volatility } from "../src/worker/regime";

describe("trend", () => {
  it("up, down, range і null без даних", () => {
    expect(trend({ close: 110, ema20: 108, ema50: 105, ema200: 100 })).toBe("up");
    expect(trend({ close: 90, ema20: 92, ema50: 95, ema200: 100 })).toBe("down");
    expect(trend({ close: 110, ema20: 104, ema50: 105, ema200: 100 })).toBe("range");
    expect(trend({ close: 110, ema20: 108, ema50: 105, ema200: null })).toBeNull();
  });
});

describe("volatility", () => {
  it("ділить за перцентилем ATR%", () => {
    expect(volatility(0.9)).toBe("high");
    expect(volatility(0.5)).toBe("normal");
    expect(volatility(0.1)).toBe("low");
    expect(volatility(null)).toBeNull();
  });
});

describe("marketRegime", () => {
  it("risk_on лише коли BTC вгору і ширина не нижче 60%", () => {
    expect(marketRegime("up", [true, true, true, false, null]).mood).toBe("risk_on");
    expect(marketRegime("up", [true, false, false, false]).mood).toBe("mixed");
    expect(marketRegime("range", [true, true, true]).mood).toBe("mixed");
  });

  it("risk_off лише коли BTC вниз і ширина не вище 40%", () => {
    const r = marketRegime("down", [false, false, true, false, false]);
    expect(r).toEqual({ mood: "risk_off", btcTrend: "down", breadth: 0.2, counted: 5 });
    expect(marketRegime("down", [true, true, false]).mood).toBe("mixed");
  });

  it("без даних mixed і breadth null", () => {
    expect(marketRegime(null, [null])).toEqual({ mood: "mixed", btcTrend: null, breadth: null, counted: 0 });
  });
});
