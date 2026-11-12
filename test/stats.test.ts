import { describe, expect, it } from "vitest";
import { SETTINGS, validatePlaybook, validateSettings } from "../src/shared/settings";
import { calibration, computeStats, hit, type SignalStatRow, type StatsInput } from "../src/worker/stats";
import { dueWeekly, localTime } from "../src/worker/time";
import { sanitizeWeekly, weeklyBody } from "../src/worker/weekly";

let id = 0;
const sig = (over: Partial<SignalStatRow> = {}): SignalStatRow => ({
  id: ++id, created_at: "2026-11-10T10:00:00.000Z", resolved_at: null, setup: "trend_pullback", status: "pending",
  result_r: null, fee_r: null, p_analyst: 0.55, p_skeptic: 0.62, playbook_version: 1, shadow_status: null, shadow_r: null, action: null, ...over,
});
const input = (signals: SignalStatRow[], over: Partial<StatsInput> = {}): StatsInput => ({
  signals, forecasts: [], funnel: [], spend: [], budgetUsd: 25, riskPct: 1, btc: { start: null, end: null }, from: null, to: "2026-11-12T00:00:00.000Z", ...over,
});

describe("статистика", () => {
  const rows = [
    sig({ status: "tp1", result_r: 2, fee_r: 0.05, action: "taken" }),
    sig({ status: "tp2", result_r: 3, fee_r: 0.06, setup: "breakout_retest", action: "skipped" }),
    sig({ status: "stopped", result_r: -1, fee_r: 0.05, action: "taken" }),
    sig({ status: "expired", result_r: null }), // без входу: не угода
    sig({ status: "expired", result_r: -0.4, fee_r: 0.04 }), // закрито за часом
    sig({ status: "active" }),
    sig({ status: "rejected", shadow_status: "stopped", shadow_r: -1.05, p_skeptic: 0.4 }),
    sig({ status: "rejected", shadow_status: "pending", shadow_r: null }),
  ];
  const s = computeStats(input(rows, { btc: { start: 100_000, end: 95_000 }, riskPct: 1 }));

  it("рахує лише угоди з результатом і віднімає комісії", () => {
    expect(s.summary).toMatchObject({ published: 6, open: 1, closed: 4, wins: 2, winRate: 0.5, totalR: 3.4, avgR: 0.85, avgFeeR: 0.05 });
    // 1.95 + 2.94 − 1.05 − 0.44 = 3.4
  });

  it("порівнює з утриманням BTC", () => {
    expect(s.summary.equityPct).toBe(3.4);
    expect(s.summary.btcHoldPct).toBe(-5);
  });

  it("розбивка за сетапами, версіями правил і журналом", () => {
    expect(s.bySetup.map((g) => [g.setup, g.published, g.closed, g.totalR])).toEqual([
      ["breakout_retest", 1, 1, 2.94],
      ["trend_pullback", 5, 3, 0.46],
    ]);
    expect(s.byVersion).toEqual([{ version: 1, closed: 4, wins: 2, winRate: 0.5, avgR: 0.85, totalR: 3.4 }]);
    expect(s.journal.taken).toMatchObject({ closed: 2, totalR: 0.9 });
    expect(s.journal.skipped).toMatchObject({ closed: 1, totalR: 2.94 });
    expect(s.journal.none).toMatchObject({ closed: 1, totalR: -0.44 });
  });

  it("тіньовий результат відхилених", () => {
    expect(s.rejected).toMatchObject({ count: 2, closed: 1, totalR: -1.05 });
  });

  it("калібрування: ціль раніше за стоп; прострочені не рахуються; відхилені за тіньовим результатом", () => {
    expect(hit("tp2")).toBe(1);
    expect(hit("expired")).toBeNull();
    // tp1, tp2, stopped опубліковані + один тіньовий stopped
    expect(s.calibration.analyst.n).toBe(4);
    expect(s.calibration.skeptic.bins).toEqual([
      { from: 0.4, to: 0.5, n: 1, predicted: 0.4, actual: 0 },
      { from: 0.6, to: 0.7, n: 3, predicted: 0.62, actual: 0.667 },
    ]);
  });

  it("бал Браєра і кошики", () => {
    const c = calibration([{ p: 0.6, hit: 1 }, { p: 0.6, hit: 0 }, { p: 1, hit: 1 }]);
    expect(c.brier).toBeCloseTo((0.16 + 0.36 + 0) / 3, 3);
    expect(c.bins.map((b) => [b.from, b.n])).toEqual([[0.6, 2], [0.9, 1]]);
    expect(calibration([])).toEqual({ n: 0, brier: null, bins: [] });
  });

  it("воронка й витрати", () => {
    const t = computeStats(input([], {
      funnel: [{ detection: true, detected: 3, filtered: { rr: 2 }, reviewed: 1, published: 1, rejected: 0 }, { detection: false }, { detection: true, detected: 1, filtered: { rr: 1, regime: 1 } }],
      spend: [{ pipeline: "news", usd: 0.1, calls: 10 }, { pipeline: "analyst", usd: 0.5, calls: 3 }],
    }));
    expect(t.funnel).toEqual({ scans: 2, detected: 4, filtered: { rr: 3, regime: 1 }, reviewed: 1, published: 1, rejected: 0 });
    expect(t.spend.monthUsd).toBe(0.6);
    expect(t.spend.byPipeline[0]!.pipeline).toBe("analyst");
    expect(t.summary).toMatchObject({ closed: 0, winRate: null, avgR: null, btcHoldPct: null });
  });
});

describe("тижневий розбір", () => {
  it("настає в неділю за місцевим часом", () => {
    // 15.11.2026 неділя; 12:00 за Києвом = 10:00 UTC.
    expect(localTime(Date.UTC(2026, 10, 15, 10, 0), "Europe/Kyiv").weekday).toBe(0);
    expect(dueWeekly(Date.UTC(2026, 10, 15, 10, 0), "Europe/Kyiv", "12:00")).toEqual({ date: "2026-11-15" });
    expect(dueWeekly(Date.UTC(2026, 10, 15, 9, 59), "Europe/Kyiv", "12:00")).toBeNull();
    expect(dueWeekly(Date.UTC(2026, 10, 14, 12, 0), "Europe/Kyiv", "12:00")).toBeNull();
    // 23:30 UTC суботи вже неділя в Києві.
    expect(dueWeekly(Date.UTC(2026, 10, 14, 23, 30), "Europe/Kyiv", "00:00")).toEqual({ date: "2026-11-15" });
  });

  it("перевіряє відповідь моделі", () => {
    const r = sanitizeWeekly({
      headline: "Відкати працюють, пробої ні",
      summary: "s",
      working: ["a", "b", "c", "d"],
      failing: [],
      calibration: "c",
      proposals: [{ target: "breakout_retest", change: "вимагати обсяг", reason: "r", evidence: "e" }, { target: "evil", change: "x", reason: "", evidence: "" }, { target: "filter", change: "", reason: "", evidence: "" }],
      next_week: ["n"],
    });
    expect(r.working).toHaveLength(3);
    expect(r.proposals).toEqual([{ target: "breakout_retest", change: "вимагати обсяг", reason: "r", evidence: "e" }]);
    expect(() => sanitizeWeekly({})).toThrow();
  });

  it("без розбору моделі заголовок складає код", () => {
    const stats = computeStats(input([sig({ status: "tp1", result_r: 2, fee_r: 0.1 })]));
    const body = weeklyBody(stats, stats, null, "стеля витрат вичерпана");
    expect(body.content).toEqual({ headline: "Тиждень: 1 закритих сигналів, +1.9R після комісій", theses: [] });
    expect(body.reviewNote).toBe("стеля витрат вичерпана");
  });
});

describe("налаштування", () => {
  it("приймає коректні значення й нормалізує їх", () => {
    const { values, errors } = validateSettings({
      watchlist: ["btcusdt", "ETHUSDT", "BTCUSDT"],
      min_rr: 2.5,
      quiet_hours: null,
      macro_events: [{ at: "2026-12-16T19:00:00Z", name: "ФРС" }, "2026-12-10T13:30:00Z"],
      report_times: { morning: "07:30", evening: "20:30", extra: 1 },
      deposit_usd: null,
      timezone: "Europe/Kyiv",
    });
    expect(errors).toEqual({});
    expect(values.watchlist).toEqual(["BTCUSDT", "ETHUSDT"]);
    expect(values.macro_events).toEqual([{ at: "2026-12-10T13:30:00.000Z", name: "" }, { at: "2026-12-16T19:00:00.000Z", name: "ФРС" }]);
    expect(values.report_times).toEqual({ morning: "07:30", evening: "20:30" });
  });

  it("відхиляє некоректні значення й невідомі ключі", () => {
    const { values, errors } = validateSettings({
      min_rr: 0.5, skeptic_threshold: 60, max_active_signals: 2.5, watchlist: ["BTC"], quiet_hours: { from: "25:00", to: "07:00" },
      news_feeds: [{ source: "x", url: "http://insecure.com/rss" }], timezone: "Mars/Olympus", market_source: "kraken", secret: 1,
    });
    expect(values).toEqual({});
    expect(Object.keys(errors).sort()).toEqual(["market_source", "max_active_signals", "min_rr", "news_feeds", "quiet_hours", "secret", "skeptic_threshold", "timezone", "watchlist"]);
  });

  it("кожне стартове налаштування з міграцій проходить перевірку", () => {
    const defaults: Record<string, unknown> = {
      timezone: "Europe/Kyiv", report_times: { morning: "07:30", evening: "20:30" }, risk_per_trade_pct: 1, min_rr: 2, skeptic_threshold: 0.6,
      max_active_signals: 3, macro_blackout_hours: 2, max_signal_pushes_per_day: 5, llm_budget_usd: 25, signal_ttl_hours: 12, signal_max_hold_hours: 48,
      signal_cooldown_hours: 6, max_candidates_per_scan: 3, quiet_hours: { from: "23:00", to: "07:00" }, macro_events: [], deposit_usd: null,
      fee_pct_per_side: 0.05, retention_days: 30, weekly_review_time: "12:00", playbook_min_days: 14, market_source: "auto",
      watchlist: ["BTCUSDT", "ETHUSDT"], news_feeds: [{ source: "coindesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss" }],
    };
    expect(validateSettings(defaults).errors).toEqual({});
    expect(SETTINGS.map((s) => s.key).sort()).toEqual(Object.keys(defaults).sort());
  });

  it("правила сетапів: усі три й розумна довжина", () => {
    const text = "x".repeat(60);
    expect(validatePlaybook({ trend_pullback: text, breakout_retest: text, liquidity_sweep: text }).ok).toBe(true);
    expect(validatePlaybook({ trend_pullback: text, breakout_retest: text })).toEqual({ ok: false, error: "liquidity_sweep: від 50 до 3000 символів" });
    expect(validatePlaybook(null).ok).toBe(false);
  });
});
