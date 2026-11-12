import { DurableObject } from "cloudflare:workers";
import { marketContext } from "./context";
import type { Env } from "./env";
import { resolveForecast, type ForecastRule } from "./forecasts";
import {
  anthropicTransport,
  costUsd,
  decideModel,
  monthStart,
  type Effort,
  type Pipeline,
  type Transport,
} from "./llm";
import { BinanceFutures } from "./market/binance";
import type { MarketData } from "./market/types";
import { newsHash, parseFeed } from "./news/rss";
import { sanitizeTriage, TRIAGE_SYSTEM, triageSchema, triageUser, type TriageInput } from "./news/triage";
import { parseSubscription, sendPush, type PushMessage, type PushOutcome, type StoredSubscription } from "./push";
import type { MarketRegime } from "./regime";
import { reportInput, type NewsField, type PriorForecast } from "./report/input";
import { reportSchema, reportSystem, sanitizeReport, type ReportContent } from "./report/schema";
import { scan } from "./scan";
import type { Snapshot } from "./snapshot";
import { clock, dueReports, localTime, type ReportKind, type ReportTimes } from "./time";

export interface ProbeTarget {
  name: string;
  ok: boolean;
  status: number | null;
  ms: number;
  note?: string;
}

export interface ProbeResult {
  at: string;
  targets: ProbeTarget[];
}

export interface ScanSummary {
  runId: number;
  at: string;
  source: string;
  market: MarketRegime;
  /** Скільки монет у списку і скільки знімків записано. */
  symbols: number;
  snapshots: number;
  errors: { symbol: string | null; message: string }[];
}

export interface ReportSummary {
  id: number;
  kind: ReportKind;
  date: string;
  model: string;
  costUsd: number;
  forecasts: number;
  push: PushOutcome;
  /** Некритичні збої: джерела фону ринку. */
  warnings: string[];
}

/** Тіло звіту в reports.body. */
export interface ReportBody {
  v: 1;
  content: ReportContent;
  market: MarketRegime;
  context: Awaited<ReturnType<typeof marketContext>>["context"];
  /** Запуск скану, зі знімків якого складено звіт. */
  snapshotRunId: number;
  /** Новини, поля яких бачила модель. */
  newsIds: number[];
  /** Прогнози попереднього звіту з результатами на момент складання. */
  prior: PriorForecast[];
}

const HOUR = 3_600_000;
const REPORT_TITLE: Record<ReportKind, string> = { morning: "Ранковий звіт готовий", evening: "Вечірній звіт готовий" };

/**
 * Рушій. Усі серверні запити назовні (біржа, Claude API, новини)
 * виходять тільки звідси: об'єкт закріплено в юрисдикції eu.
 */
export class Engine extends DurableObject<Env> {
  private running = false;

  /** Викликається з Cron Trigger раз на 30 хв. Збій одного кроку не зупиняє наступні. */
  async tick(): Promise<{ ran: string[] }> {
    if (this.running) return { ran: [] };
    this.running = true;
    const ran: string[] = [];
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        ran.push(name);
      } catch (e) {
        console.error(`крок ${name}:`, e);
      }
    };
    try {
      const now = Date.now();
      await step("scan", () => this.runScan());
      await step("news", () => this.runNews(now));
      await step("forecasts", () => this.resolveForecasts(now));
      for (const due of await this.dueReports(now)) {
        await step(`${due.kind}_report`, () => this.runReport(due.kind, due.date));
      }
      return { ran };
    } finally {
      this.running = false;
    }
  }

  /** Ручний запуск звіту з API. null, якщо рушій зайнятий; помилка, якщо звіт за цю дату вже є. */
  async reportNow(kind: ReportKind): Promise<ReportSummary | { error: string } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const now = Date.now();
      const date = localTime(now, await this.setting("timezone", "Europe/Kyiv")).date;
      if (await this.reportExists(kind, date)) return { error: "звіт за цю дату вже є" };
      await this.runNews(now).catch((e) => console.error("крок news:", e));
      await this.resolveForecasts(now).catch((e) => console.error("крок forecasts:", e));
      return await this.runReport(kind, date);
    } catch (e) {
      return { error: String(e) };
    } finally {
      this.running = false;
    }
  }

  /** Пробне сповіщення на всі підписки й у Telegram. */
  async pushTest(): Promise<PushOutcome> {
    return this.push({ title: "Асистент трейдера", body: "Сповіщення працюють.", url: "/", tag: "test" });
  }

  /** Ручний запуск скану з API. Не накладається на запуск за розкладом. */
  async scanNow(): Promise<ScanSummary | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.runScan();
    } finally {
      this.running = false;
    }
  }

  /** Джерело ринкових даних. Запасна біржа підставляється тут за тим самим інтерфейсом. */
  private market(): MarketData {
    return new BinanceFutures();
  }

  /** Скан без моделі: дані з біржі, індикатори, режим ринку, запис знімків у snapshots. */
  private async runScan(): Promise<ScanSummary> {
    const started = Date.now();
    const at = new Date(started).toISOString();
    const market = this.market();
    let symbols: string[] = [];
    let result: Awaited<ReturnType<typeof scan>> = {
      snapshots: [],
      market: { mood: "mixed", btcTrend: null, breadth: null, counted: 0 },
      errors: [],
    };
    try {
      symbols = await this.watchlist();
      result = await scan(market, symbols, started);
    } catch (e) {
      result.errors.push({ symbol: null, message: String(e) });
    }
    const failed = symbols.length === 0 || result.snapshots.length < symbols.length;
    const summary = {
      source: market.name,
      market: result.market,
      symbols: symbols.length,
      snapshots: result.snapshots.length,
      errors: result.errors,
    };
    const run = await this.env.DB.prepare(
      "INSERT INTO runs (kind, started_at, status, duration_ms, detail, error) VALUES ('scan', ?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(
        at,
        failed ? "error" : "ok",
        Date.now() - started,
        JSON.stringify(summary),
        failed ? result.errors.map((e) => (e.symbol ? `${e.symbol}: ${e.message}` : e.message)).join("; ").slice(0, 2000) || "порожній список монет" : null,
      )
      .first<{ id: number }>();
    const runId = run!.id;
    if (result.snapshots.length) {
      const insert = this.env.DB.prepare("INSERT INTO snapshots (run_id, symbol, features) VALUES (?, ?, ?)");
      await this.env.DB.batch(result.snapshots.map((s) => insert.bind(runId, s.symbol, JSON.stringify(s))));
    }
    return { runId, at, ...summary };
  }

  private async watchlist(): Promise<string[]> {
    const row = await this.env.DB.prepare("SELECT value FROM settings WHERE key = 'watchlist'").first<{ value: string }>();
    const list: unknown = row ? JSON.parse(row.value) : [];
    if (!Array.isArray(list)) throw new Error("settings.watchlist має бути масивом");
    return list.filter((s): s is string => typeof s === "string" && /^[A-Z0-9]{2,20}$/.test(s));
  }

  /** Перевірка: чи відповідають Binance і Claude API з дата-центру рушія. */
  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    const at = new Date(started).toISOString();
    const targets = await Promise.all([
      this.check("binance-futures", "https://fapi.binance.com/fapi/v1/time"),
      this.check("binance-spot-data", "https://data-api.binance.vision/api/v3/time"),
      this.checkClaude(),
    ]);
    const ok = targets.every((t) => t.ok);
    await this.env.DB.prepare(
      "INSERT INTO runs (kind, started_at, status, duration_ms, detail, error) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "probe",
        at,
        ok ? "ok" : "error",
        Date.now() - started,
        JSON.stringify(targets),
        ok ? null : targets.filter((t) => !t.ok).map((t) => `${t.name}: ${t.status ?? t.note}`).join("; "),
      )
      .run();
    return { at, targets };
  }

  private async check(name: string, url: string): Promise<ProbeTarget> {
    const t0 = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel();
      return {
        name,
        ok: res.ok,
        status: res.status,
        ms: Date.now() - t0,
        note: res.status === 451 ? "заборонена локація" : undefined,
      };
    } catch (e) {
      return { name, ok: false, status: null, ms: Date.now() - t0, note: String(e) };
    }
  }

  /**
   * Без ключа очікуємо 401: це означає, що API доступний з цієї локації.
   * 403 означає блокування за регіоном.
   */
  private async checkClaude(): Promise<ProbeTarget> {
    const t0 = Date.now();
    const key = this.env.ANTHROPIC_API_KEY;
    try {
      const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
        headers: { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) },
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel();
      const reachable = res.ok || (!key && res.status === 401);
      return {
        name: "claude-api",
        ok: reachable,
        status: res.status,
        ms: Date.now() - t0,
        note: key ? undefined : "ключ не задано, перевірено лише доступність",
      };
    } catch (e) {
      return { name: "claude-api", ok: false, status: null, ms: Date.now() - t0, note: String(e) };
    }
  }

  // ── Налаштування ─────────────────────────────────────────────────────────

  private async setting<T>(key: string, fallback: T): Promise<T> {
    const row = await this.env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  private async logRun(kind: string, started: number, detail: unknown, error: string | null): Promise<void> {
    await this.env.DB.prepare(
      "INSERT INTO runs (kind, started_at, status, duration_ms, detail, error) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(kind, new Date(started).toISOString(), error ? "error" : "ok", Date.now() - started, JSON.stringify(detail), error?.slice(0, 2000) ?? null)
      .run();
  }

  // ── Модель ───────────────────────────────────────────────────────────────

  /** Підміняється в тестах; у роботі це Claude API. */
  protected transport(): Transport {
    if (!this.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY не задано");
    return anthropicTransport(this.env.ANTHROPIC_API_KEY);
  }

  /**
   * Єдиний шлях до моделі: стеля місячних витрат перевіряється перед викликом,
   * кожен виклик пишеться в llm_calls. null, якщо стеля не дозволяє цей конвеєр.
   */
  private async llm(
    pipeline: Pipeline,
    req: { system: string; user: string; schema: Record<string, unknown>; maxTokens: number; effort: Effort },
  ): Promise<{ data: unknown; model: string; costUsd: number } | null> {
    const budget = await this.setting("llm_budget_usd", 25);
    const spent = await this.env.DB.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM llm_calls WHERE ts >= ?")
      .bind(monthStart(Date.now()))
      .first<{ spent: number }>();
    const decision = decideModel(pipeline, spent?.spent ?? 0, budget);
    if (!decision.allowed) return null;

    const t0 = Date.now();
    const res = await this.transport()({ ...req, model: decision.model });
    const cost = costUsd(res.model, res.usage);
    await this.env.DB.prepare(
      "INSERT INTO llm_calls (ts, pipeline, model, tokens_in, tokens_out, cost_usd, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(new Date(t0).toISOString(), pipeline, res.model, res.usage.inputTokens, res.usage.outputTokens, cost, Date.now() - t0)
      .run();
    return { data: JSON.parse(res.text) as unknown, model: res.model, costUsd: cost };
  }

  // ── Новини ───────────────────────────────────────────────────────────────

  /** Нові заголовки зі стрічок у news, потім сортувальник перетворює їх на поля. */
  private async runNews(now: number): Promise<void> {
    const started = Date.now();
    const errors: string[] = [];
    const feeds = (await this.setting<{ source: string; url: string }[]>("news_feeds", [])).filter(
      (f) => typeof f?.source === "string" && typeof f?.url === "string" && f.url.startsWith("https://"),
    );
    let added = 0;
    await Promise.all(
      feeds.map(async (feed) => {
        try {
          const res = await fetch(feed.url, {
            headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) {
            await res.body?.cancel();
            throw new Error(`HTTP ${res.status}`);
          }
          const items = parseFeed((await res.text()).slice(0, 2_000_000), 30).filter(
            (i) => i.ts === null || (i.ts >= now - 24 * HOUR && i.ts <= now + HOUR),
          );
          if (!items.length) return;
          const insert = this.env.DB.prepare(
            "INSERT OR IGNORE INTO news (ts, source, url, title, hash) VALUES (?, ?, ?, ?, ?)",
          );
          const results = await this.env.DB.batch(
            await Promise.all(
              items.map(async (i) =>
                insert.bind(new Date(i.ts ?? now).toISOString(), feed.source.slice(0, 40), i.url, i.title, await newsHash(i.url)),
              ),
            ),
          );
          added += results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
        } catch (e) {
          errors.push(`${feed.source}: ${String(e)}`);
        }
      }),
    );

    let triaged = 0;
    let skipped: string | null = null;
    try {
      const pending = await this.env.DB.prepare(
        "SELECT id, source, title FROM news WHERE relevance IS NULL AND ts >= ? ORDER BY ts DESC LIMIT 40",
      )
        .bind(new Date(now - 24 * HOUR).toISOString())
        .all<TriageInput>();
      if (pending.results.length) {
        const symbols = await this.watchlist();
        const res = await this.llm("news", {
          system: TRIAGE_SYSTEM,
          user: triageUser(pending.results),
          schema: triageSchema(symbols),
          maxTokens: 8000,
          effort: "low",
        });
        if (!res) skipped = "стелю витрат вичерпано";
        else {
          const rows = sanitizeTriage(res.data, pending.results, symbols);
          const update = this.env.DB.prepare(
            "UPDATE news SET relevance = ?, impact = ?, sentiment = ?, symbols = ?, category = ? WHERE id = ?",
          );
          if (rows.length) {
            await this.env.DB.batch(
              rows.map((r) => update.bind(r.relevance, r.impact, r.sentiment, JSON.stringify(r.symbols), r.category, r.id)),
            );
          }
          triaged = rows.length;
        }
      }
    } catch (e) {
      errors.push(`сортувальник: ${String(e)}`);
    }
    await this.logRun("news", started, { feeds: feeds.length, added, triaged, skipped, errors }, errors.length ? errors.join("; ") : null);
    if (errors.length && !added && !triaged) throw new Error(errors.join("; "));
  }

  // ── Прогнози ─────────────────────────────────────────────────────────────

  /** Закриває прогнози, чий термін настав: результат рахує код за свічками 1h. */
  private async resolveForecasts(now: number): Promise<void> {
    const due = await this.env.DB.prepare(
      "SELECT id, rule, resolve_at FROM forecasts WHERE outcome IS NULL AND resolve_at <= ? ORDER BY resolve_at LIMIT 30",
    )
      .bind(new Date(now).toISOString())
      .all<{ id: number; rule: string; resolve_at: string }>();
    if (!due.results.length) return;
    const market = this.market();
    const bySymbol = new Map<string, { id: number; rule: ForecastRule; resolveAt: number }[]>();
    for (const row of due.results) {
      try {
        const rule = JSON.parse(row.rule) as ForecastRule;
        const list = bySymbol.get(rule.symbol) ?? [];
        list.push({ id: row.id, rule, resolveAt: Date.parse(row.resolve_at) });
        bySymbol.set(rule.symbol, list);
      } catch {
        // Зіпсоване правило лишається відкритим і видимим у статистиці.
      }
    }
    const update = this.env.DB.prepare("UPDATE forecasts SET outcome = ?, resolved_at = ? WHERE id = ? AND outcome IS NULL");
    for (const [symbol, list] of bySymbol) {
      const oldest = Math.min(...list.map((f) => Date.parse(f.rule.from)));
      const limit = Math.min(498, Math.ceil((now - oldest) / HOUR) + 2);
      const candles = await market.candles(symbol, "1h", limit);
      const statements = list.flatMap((f) => {
        const outcome = resolveForecast(f.rule, candles, f.resolveAt);
        return outcome === null ? [] : [update.bind(outcome, new Date(now).toISOString(), f.id)];
      });
      if (statements.length) await this.env.DB.batch(statements);
    }
  }

  // ── Звіти ────────────────────────────────────────────────────────────────

  private async reportExists(kind: ReportKind, date: string): Promise<boolean> {
    return (await this.env.DB.prepare("SELECT 1 AS x FROM reports WHERE kind = ? AND date = ?").bind(kind, date).first()) !== null;
  }

  /** Звіти, час яких настав за місцевим часом і яких ще немає в базі. */
  private async dueReports(now: number): Promise<{ kind: ReportKind; date: string }[]> {
    const timezone = await this.setting("timezone", "Europe/Kyiv");
    const times = await this.setting<ReportTimes>("report_times", { morning: "07:30", evening: "20:30" });
    const out: { kind: ReportKind; date: string }[] = [];
    for (const due of dueReports(now, timezone, times)) {
      if (!(await this.reportExists(due.kind, due.date))) out.push(due);
    }
    return out;
  }

  private async runReport(kind: ReportKind, date: string): Promise<ReportSummary> {
    const started = Date.now();
    try {
      const summary = await this.buildReport(kind, date, started);
      await this.logRun(`${kind}_report`, started, summary, null);
      return summary;
    } catch (e) {
      await this.logRun(`${kind}_report`, started, null, String(e));
      throw e;
    }
  }

  private async buildReport(kind: ReportKind, date: string, now: number): Promise<ReportSummary> {
    const db = this.env.DB;
    const timezone = await this.setting("timezone", "Europe/Kyiv");

    // 1. Знімки останнього скану: звіт не складається зі застарілих даних.
    const scanRun = await db
      .prepare("SELECT id, detail FROM runs WHERE kind = 'scan' AND started_at >= ? ORDER BY id DESC LIMIT 1")
      .bind(new Date(now - 1.5 * HOUR).toISOString())
      .first<{ id: number; detail: string | null }>();
    const rows = scanRun
      ? await db.prepare("SELECT features FROM snapshots WHERE run_id = ? ORDER BY id").bind(scanRun.id).all<{ features: string }>()
      : null;
    const snapshots = (rows?.results ?? []).map((r) => JSON.parse(r.features) as Snapshot);
    if (!scanRun || !snapshots.length) throw new Error("немає свіжих знімків ринку: останній скан не вдався");
    const market = (JSON.parse(scanRun.detail ?? "{}") as { market: MarketRegime }).market;

    // 2. Фон ринку. Збій джерела не зупиняє звіт.
    const { context, errors: warnings } = await marketContext((input, init) => fetch(input, init), this.env.COINGECKO_API_KEY);

    // 3. Новини за 12 годин: до 8 найважливіших, лише поля сортувальника.
    const newsRows = await db
      .prepare(
        "SELECT id, ts, category, impact, sentiment, symbols, relevance FROM news WHERE ts >= ? AND relevance >= 0.4 ORDER BY relevance DESC, ts DESC LIMIT 8",
      )
      .bind(new Date(now - 12 * HOUR).toISOString())
      .all<{ id: number; ts: string; category: string; impact: string; sentiment: string; symbols: string; relevance: number }>();
    const news: NewsField[] = newsRows.results.map((n) => ({
      category: n.category,
      impact: n.impact,
      sentiment: n.sentiment,
      symbols: JSON.parse(n.symbols || "[]") as string[],
      relevance: n.relevance,
      age_hours: Math.round(((now - Date.parse(n.ts)) / HOUR) * 10) / 10,
    }));

    // 4. Прогнози попереднього звіту з результатами, які порахував код.
    const previous = await db
      .prepare("SELECT id FROM reports WHERE kind IN ('morning', 'evening') AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
      .bind(new Date(now - 36 * HOUR).toISOString())
      .first<{ id: number }>();
    const priorRows = previous
      ? await db
          .prepare("SELECT statement, probability, rule, outcome FROM forecasts WHERE source = ? ORDER BY id")
          .bind(`report:${previous.id}`)
          .all<{ statement: string; probability: number; rule: string; outcome: number | null }>()
      : null;
    const prior: PriorForecast[] = (priorRows?.results ?? []).map((f) => ({
      title: (JSON.parse(f.rule) as ForecastRule).title,
      statement: f.statement,
      probability_pct: Math.round(f.probability * 100),
      outcome: f.outcome === null ? "pending" : f.outcome === 1 ? "happened" : "did_not_happen",
    }));

    // 5. Відкриті сигнали (з'являться на етапі «Сигнали»).
    const signals = await db
      .prepare("SELECT symbol, side, setup, status FROM signals WHERE status IN ('pending', 'active') ORDER BY id")
      .all<{ symbol: string; side: string; setup: string; status: string }>();

    // 6. Автор звіту.
    const symbols = snapshots.map((s) => s.symbol);
    const input = reportInput({
      kind,
      localDate: date,
      localClock: clock(now, timezone),
      market,
      context,
      snapshots,
      news,
      priorForecasts: prior,
      openSignals: signals.results,
    });
    const res = await this.llm(`${kind}_report`, {
      system: reportSystem(kind),
      user: JSON.stringify(input),
      schema: reportSchema(symbols),
      maxTokens: 16000,
      effort: "medium",
    });
    if (!res) throw new Error("стеля витрат не дозволяє звіт");

    // 7. Перевірка відповіді кодом і запис.
    const content = sanitizeReport(res.data, {
      prices: new Map(snapshots.map((s) => [s.symbol, s.price])),
      now,
      deadlineLabel: (resolveAt) => `${clock(resolveAt, timezone)} ${localTime(resolveAt, timezone).date.slice(5).split("-").reverse().join(".")}`,
    });
    const body: ReportBody = { v: 1, content, market, context, snapshotRunId: scanRun.id, newsIds: newsRows.results.map((n) => n.id), prior };
    const inserted = await db
      .prepare("INSERT INTO reports (kind, date, body, model, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(kind, date, JSON.stringify(body), res.model, res.costUsd, new Date(now).toISOString())
      .first<{ id: number }>();
    const id = inserted!.id;

    // Кожна ймовірність стає рядком у forecasts із правилом перевірки.
    const insertForecast = db.prepare(
      "INSERT INTO forecasts (source, statement, probability, resolve_at, rule) VALUES (?, ?, ?, ?, ?)",
    );
    const forecasts = content.scenarios.flatMap((s) =>
      s.rule && s.statement && s.resolveAt
        ? [insertForecast.bind(`report:${id}`, s.statement, s.probability, s.resolveAt, JSON.stringify(s.rule))]
        : [],
    );
    if (forecasts.length) await db.batch(forecasts);

    const push = await this.push({ title: REPORT_TITLE[kind], body: content.headline, url: `/?report=${id}`, tag: `report-${id}` });
    return { id, kind, date, model: res.model, costUsd: res.costUsd, forecasts: forecasts.length, push, warnings };
  }

  // ── Сповіщення ───────────────────────────────────────────────────────────

  private async push(message: PushMessage): Promise<PushOutcome> {
    const rows = await this.env.DB.prepare("SELECT endpoint, keys FROM push_subscriptions").all<{ endpoint: string; keys: string }>();
    const subscriptions = rows.results.flatMap((r): StoredSubscription[] => {
      try {
        const s = parseSubscription({ endpoint: r.endpoint, keys: JSON.parse(r.keys) });
        return s ? [s] : [];
      } catch {
        return [];
      }
    });
    const outcome = await sendPush(
      (input, init) => fetch(input, init),
      {
        vapidPrivateKey: this.env.VAPID_PRIVATE_KEY,
        vapidSubject: this.env.VAPID_SUBJECT,
        telegramToken: this.env.TELEGRAM_BOT_TOKEN,
        telegramChatId: this.env.TELEGRAM_CHAT_ID,
      },
      subscriptions,
      message,
      this.env.APP_ORIGIN,
    );
    if (outcome.webPush.expired.length) {
      const del = this.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?");
      await this.env.DB.batch(outcome.webPush.expired.map((e) => del.bind(e)));
    }
    return outcome;
  }
}
