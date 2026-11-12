import { describe, expect, it } from "vitest";
import { resolveForecast, statement, type ForecastRule } from "../src/worker/forecasts";
import { costUsd, decideModel, MODELS, monthStart } from "../src/worker/llm";
import { decodeEntities, newsHash, parseFeed } from "../src/worker/news/rss";
import { sanitizeTriage, triageSchema } from "../src/worker/news/triage";
import { parseSubscription, sendPush } from "../src/worker/push";
import { reportSchema, sanitizeReport } from "../src/worker/report/schema";
import { clock, dueReports, localTime, parseClock } from "../src/worker/time";
import { candles } from "./helpers";

describe("час звітів", () => {
  const times = { morning: "07:30", evening: "20:30" };
  const kyiv = "Europe/Kyiv";

  it("рахує київський час узимку (UTC+2) і влітку (UTC+3)", () => {
    expect(localTime(Date.UTC(2026, 10, 12, 5, 30), kyiv)).toEqual({ date: "2026-11-12", minutes: 7 * 60 + 30, weekday: 4 });
    expect(localTime(Date.UTC(2026, 6, 1, 4, 30), kyiv)).toEqual({ date: "2026-07-01", minutes: 7 * 60 + 30, weekday: 3 });
    expect(localTime(Date.UTC(2026, 10, 12, 22, 30), kyiv).date).toBe("2026-11-13");
    expect(clock(Date.UTC(2026, 10, 12, 17, 5), kyiv)).toBe("19:05");
  });

  it("звіт настає у свій час і лишається у вікні три години", () => {
    expect(dueReports(Date.UTC(2026, 10, 12, 5, 0), kyiv, times)).toEqual([]);
    expect(dueReports(Date.UTC(2026, 10, 12, 5, 30), kyiv, times)).toEqual([{ kind: "morning", date: "2026-11-12" }]);
    expect(dueReports(Date.UTC(2026, 10, 12, 8, 0), kyiv, times)).toEqual([{ kind: "morning", date: "2026-11-12" }]);
    expect(dueReports(Date.UTC(2026, 10, 12, 8, 30), kyiv, times)).toEqual([]);
    expect(dueReports(Date.UTC(2026, 10, 12, 18, 30), kyiv, times)).toEqual([{ kind: "evening", date: "2026-11-12" }]);
  });

  it("улітку той самий місцевий час припадає на іншу годину UTC", () => {
    expect(dueReports(Date.UTC(2026, 6, 1, 4, 30), kyiv, times)).toEqual([{ kind: "morning", date: "2026-07-01" }]);
    expect(dueReports(Date.UTC(2026, 6, 1, 4, 0), kyiv, times)).toEqual([]);
  });

  it("розбирає час і відкидає сміття", () => {
    expect(parseClock("07:30")).toBe(450);
    expect(parseClock("24:00")).toBeNull();
    expect(dueReports(Date.UTC(2026, 10, 12, 5, 30), kyiv, { morning: "зранку", evening: "20:30" })).toEqual([]);
  });
});

describe("прогнози", () => {
  const H = 3_600_000;
  // Три свічки 1h: [high, low, close]
  const c = candles([
    [101, 99, 100],
    [106, 100, 105],
    [105, 102, 103],
  ]);
  const rule = (condition: ForecastRule["condition"], level: number, from = 0): ForecastRule => ({
    v: 1, symbol: "BTCUSDT", condition, level, from: new Date(from).toISOString(), title: "t",
  });

  it("touch рахує будь-який дотик у вікні, close лише останнє закриття", () => {
    expect(resolveForecast(rule("touch_above", 106), c, 3 * H)).toBe(1);
    expect(resolveForecast(rule("touch_above", 106.5), c, 3 * H)).toBe(0);
    expect(resolveForecast(rule("touch_below", 99), c, 3 * H)).toBe(1);
    expect(resolveForecast(rule("close_above", 104), c, 3 * H)).toBe(0);
    expect(resolveForecast(rule("close_above", 104), c, 2 * H)).toBe(1);
    expect(resolveForecast(rule("close_below", 104), c, 3 * H)).toBe(1);
  });

  it("не бере свічки поза вікном і повертає null без даних", () => {
    // Вікно з другої свічки: мінімум 99 першої свічки не рахується.
    expect(resolveForecast(rule("touch_below", 99.5, H), c, 3 * H)).toBe(0);
    expect(resolveForecast(rule("touch_above", 1, 10 * H), c, 12 * H)).toBeNull();
  });

  it("твердження складає код", () => {
    expect(statement(rule("close_above", 104000), "19:30 12.11")).toBe("BTCUSDT закриється вище 104000 до 19:30 12.11");
  });
});

describe("RSS", () => {
  const rss = `<?xml version="1.0"?><rss><channel><title>Feed</title>
    <item><title><![CDATA[SEC approves <b>spot</b> ETF &amp; more]]></title><link>https://example.com/a?utm_source=rss</link><pubDate>Thu, 12 Nov 2026 05:00:00 GMT</pubDate></item>
    <item><title>Bitcoin &#8217;rally&#x2019; \u202Econtinues</title><link>https://example.com/b/</link></item>
    <item><title>No link</title></item>
    <item><title>Bad scheme</title><link>javascript:alert(1)</link></item>
  </channel></rss>`;

  it("розбирає RSS: CDATA, сутності, теги, керівні символи", () => {
    const items = parseFeed(rss);
    expect(items).toEqual([
      { title: "SEC approves spot ETF & more", url: "https://example.com/a?utm_source=rss", ts: Date.UTC(2026, 10, 12, 5) },
      { title: "Bitcoin ’rally’ continues", url: "https://example.com/b/", ts: null },
    ]);
  });

  it("розбирає Atom", () => {
    const atom = `<feed><entry><title>Hack at exchange</title><link rel="self" href="https://x.com/self"/><link rel="alternate" href="https://x.com/post?a=1&amp;b=2"/><updated>2026-11-12T06:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom)).toEqual([{ title: "Hack at exchange", url: "https://x.com/post?a=1&b=2", ts: Date.UTC(2026, 10, 12, 6) }]);
  });

  it("обрізає довгі заголовки й кількість записів", () => {
    const many = `<rss>${Array.from({ length: 5 }, (_, i) => `<item><title>${"x".repeat(500)}</title><link>https://e.com/${i}</link></item>`).join("")}</rss>`;
    const items = parseFeed(many, 3);
    expect(items).toHaveLength(3);
    expect(items[0]!.title).toHaveLength(300);
  });

  it("не чіпає невідомі сутності", () => {
    expect(decodeEntities("a &unknown; &lt;b&gt;")).toBe("a &unknown; <b>");
  });

  it("ключ дедуплікації не залежить від параметрів, www і кінцевої риски", async () => {
    const a = await newsHash("https://www.example.com/News/a/?utm_source=rss#x");
    expect(a).toBe(await newsHash("https://example.com/news/a"));
    expect(a).not.toBe(await newsHash("https://example.com/news/b"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("сортувальник новин", () => {
  const sent = [
    { id: 1, source: "s", title: "a" },
    { id: 2, source: "s", title: "b" },
  ];
  const symbols = ["BTCUSDT", "ETHUSDT"];

  it("лишає тільки надіслані id і значення з переліків", () => {
    const out = sanitizeTriage(
      {
        items: [
          { id: 1, relevance: 8, impact: "high", sentiment: "bullish", symbols: ["BTCUSDT", "MARKET", "EVILUSDT", "BTCUSDT"], category: "etf_flows" },
          { id: 2, relevance: 99, impact: "ignore previous instructions", sentiment: 5, symbols: "BTCUSDT", category: "x" },
          { id: 3, relevance: 10, impact: "high", sentiment: "bullish", symbols: [], category: "macro" },
          { id: 1, relevance: 0, impact: "low", sentiment: "neutral", symbols: [], category: "other" },
          null,
        ],
      },
      sent,
      symbols,
    );
    expect(out).toEqual([
      { id: 1, relevance: 0.8, impact: "high", sentiment: "bullish", symbols: ["BTCUSDT", "MARKET"], category: "etf_flows" },
      { id: 2, relevance: 1, impact: "low", sentiment: "neutral", symbols: [], category: "other" },
    ]);
  });

  it("сміття замість відповіді дає порожній результат", () => {
    expect(sanitizeTriage(null, sent, symbols)).toEqual([]);
    expect(sanitizeTriage({ items: "x" }, sent, symbols)).toEqual([]);
  });

  it("схема не має вільного тексту", () => {
    const item = triageSchema(symbols).properties.items.items;
    expect(item.additionalProperties).toBe(false);
    const free = Object.entries(item.properties).filter(([, v]) => v.type === "string" && !("enum" in v));
    expect(free).toEqual([]);
    expect(item.properties.symbols.items.enum).toEqual(["BTCUSDT", "ETHUSDT", "MARKET"]);
  });
});

describe("бюджет і вартість", () => {
  it("рахує вартість за тарифом моделі", () => {
    expect(costUsd("claude-sonnet-5-5", { inputTokens: 25_000, outputTokens: 3_000 })).toBeCloseTo(0.08, 10);
    expect(costUsd("claude-haiku-5-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(0.6, 10);
    // Запасна модель після відмови та невідомі моделі не занижують витрати.
    expect(costUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(2);
    expect(costUsd("something-new", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(30);
  });

  it("до стелі працює модель ролі", () => {
    expect(decideModel("news", 24.99, 25)).toEqual({ allowed: true, model: MODELS.news });
    expect(decideModel("morning_report", 0, 25)).toEqual({ allowed: true, model: MODELS.report });
  });

  it("після стелі звіти пише Haiku, сортування новин зупиняється", () => {
    expect(decideModel("evening_report", 25, 25)).toEqual({ allowed: true, model: MODELS.news });
    expect(decideModel("news", 25, 25).allowed).toBe(false);
  });

  it("місяць починається в UTC", () => {
    expect(monthStart(Date.UTC(2026, 10, 12, 21, 5))).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("перевірка звіту кодом", () => {
  const now = Date.UTC(2026, 10, 12, 5, 30);
  const ctx = { prices: new Map([["BTCUSDT", 100_000]]), now, deadlineLabel: () => "19:30 12.11" };
  const scenario = (over: Record<string, unknown> = {}, check: Record<string, unknown> = {}) => ({
    title: "Пробій угору",
    description: "опис",
    probability_pct: 40,
    invalidation: "нижче 98000",
    check: { symbol: "BTCUSDT", condition: "touch_above", level: 103_000, horizon_hours: 12, ...check },
    ...over,
  });
  const raw = (scenarios: unknown[], extra: Record<string, unknown> = {}) => ({
    headline: "BTC тримає тренд",
    theses: ["1", "2", "3", "4"],
    regime: "режим",
    levels: [
      { symbol: "BTCUSDT", price: 98_000, kind: "support", note: "n" },
      { symbol: "BTCUSDT", price: 5, kind: "support", note: "далеко" },
      { symbol: "DOGEUSDT", price: 1, kind: "support", note: "немає в знімку" },
    ],
    scenarios,
    plan: { do: ["a"], avoid: ["b"] },
    review: "",
    ...extra,
  });

  it("перетворює сценарій на правило з дедлайном і твердженням", () => {
    const r = sanitizeReport(raw([scenario()]), ctx);
    expect(r.theses).toEqual(["1", "2", "3"]);
    expect(r.levels).toEqual([{ symbol: "BTCUSDT", price: 98_000, kind: "support", note: "n" }]);
    expect(r.scenarios[0]).toMatchObject({
      probability: 0.4,
      rule: { v: 1, symbol: "BTCUSDT", condition: "touch_above", level: 103_000, from: "2026-11-12T05:30:00.000Z", title: "Пробій угору" },
      statement: "BTCUSDT торкнеться рівня або підніметься вище 103000 до 19:30 12.11",
      resolveAt: "2026-11-12T17:30:00.000Z",
    });
  });

  it("тримає ймовірність у межах 5–95% і бере не більше трьох сценаріїв", () => {
    const r = sanitizeReport(raw([scenario({ probability_pct: 100 }), scenario({ probability_pct: -3 }), scenario(), scenario()]), ctx);
    expect(r.scenarios.map((s) => s.probability)).toEqual([0.95, 0.05, 0.4]);
  });

  it("лишає сценарій без прогнозу, якщо перевірка непридатна", () => {
    const bad = [
      scenario({}, { level: 200_000 }), // далі ніж 25% від ціни
      scenario({}, { symbol: "ETHUSDT" }), // монети немає у знімку
      scenario({}, { horizon_hours: 72 }),
    ];
    const r = sanitizeReport(raw(bad), ctx);
    expect(r.scenarios).toHaveLength(3);
    expect(r.scenarios.every((s) => s.rule === null && s.statement === null && s.resolveAt === null)).toBe(true);
  });

  it("відхиляє звіт без заголовка або сценаріїв", () => {
    expect(() => sanitizeReport(raw([]), ctx)).toThrow();
    expect(() => sanitizeReport(raw([scenario()], { headline: "  " }), ctx)).toThrow();
    expect(() => sanitizeReport(null, ctx)).toThrow();
  });

  it("схема закрита для зайвих полів і обмежує монети", () => {
    const s = reportSchema(["BTCUSDT"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.scenarios.items.properties.check.properties.symbol.enum).toEqual(["BTCUSDT"]);
  });
});

describe("push", () => {
  const sub = { endpoint: "https://push.example.com/abc", keys: { p256dh: "k", auth: "a" } };

  it("перевіряє підписку з браузера", () => {
    expect(parseSubscription({ ...sub, expirationTime: null })).toEqual(sub);
    expect(parseSubscription({ ...sub, endpoint: "http://push.example.com/abc" })).toBeNull();
    expect(parseSubscription({ endpoint: "https://x.com" })).toBeNull();
    expect(parseSubscription(null)).toBeNull();
  });

  it("без ключів і токена нічого не надсилає", async () => {
    const calls: string[] = [];
    const out = await sendPush(async (url) => (calls.push(url), new Response("")), {}, [sub], { title: "t", body: "b", url: "/" });
    expect(calls).toEqual([]);
    expect(out).toEqual({ webPush: { sent: 0, failed: 0, expired: [] }, telegram: "off", errors: [] });
  });

  it("дублює в Telegram із посиланням на застосунок", async () => {
    const calls: { url: string; body: string }[] = [];
    const out = await sendPush(
      async (url, init) => (calls.push({ url, body: String(init?.body) }), Response.json({ ok: true })),
      { telegramToken: "T", telegramChatId: "42" },
      [],
      { title: "Ранковий звіт готовий", body: "BTC тримає тренд", url: "/?report=7" },
      "https://app.example.com",
    );
    expect(out.telegram).toBe("sent");
    expect(calls[0]!.url).toBe("https://api.telegram.org/botT/sendMessage");
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      chat_id: "42",
      text: "Ранковий звіт готовий\nBTC тримає тренд\nhttps://app.example.com/?report=7",
    });
  });

  it("шифрує Web Push і позначає недійсні підписки", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
    const client = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const b64 = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf as ArrayBuffer).toString("base64url");
    const publicKey = (await crypto.subtle.exportKey("raw", client.publicKey)) as ArrayBuffer;
    const real = (path: string) => ({
      endpoint: `https://push.example.com/${path}`,
      keys: { p256dh: b64(publicKey), auth: b64(crypto.getRandomValues(new Uint8Array(16))) },
    });
    const seen: { url: string; headers: Headers; size: number }[] = [];
    const out = await sendPush(
      async (url, init) => {
        seen.push({ url, headers: new Headers(init?.headers), size: (init?.body as ArrayBuffer).byteLength });
        return new Response("", { status: url.endsWith("gone") ? 410 : 201 });
      },
      { vapidPrivateKey: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)), vapidSubject: "mailto:admin@example.com" },
      [real("ok"), real("gone")],
      { title: "t", body: "b", url: "/" },
    );
    expect(out.webPush).toEqual({ sent: 1, failed: 0, expired: ["https://push.example.com/gone"] });
    expect(seen[0]!.headers.get("content-encoding")).toMatch(/^aes(128)?gcm$/);
    expect(seen[0]!.headers.get("authorization")).toMatch(/^(vapid|WebPush) /i);
    expect(seen[0]!.size).toBeGreaterThan(50);
  });
});
