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
import { scan, type ScanResult } from "./scan";
import { entryMid, positionSize } from "../shared/risk";
import { detect } from "./signals/detectors";
import { candidateKey, minutesToMacro, reject, type Rejection } from "./signals/filter";
import {
  ANALYST_SCHEMA,
  ANALYST_SYSTEM,
  decide,
  PLAYBOOK_V1,
  reviewInput,
  sanitizeAnalyst,
  sanitizeSkeptic,
  SKEPTIC_SCHEMA,
  SKEPTIC_SYSTEM,
  type Reasoning,
  type SkepticView,
} from "./signals/review";
import { replay, type EventType } from "./signals/track";
import { SETUP_NAME, type Candidate, type SetupId, type SignalStatus } from "./signals/types";
import type { Snapshot } from "./snapshot";
import { clock, dueReports, localTime, parseClock, type ReportKind, type ReportTimes } from "./time";

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

export interface SignalsSummary {
  /** Скільки відкритих сигналів змінило стан. */
  updated: number;
  /** Чи шукали нові сетапи: лише одразу після закриття свічки 1h. */
  detection: boolean;
  detected: number;
  filtered: Partial<Record<Rejection, number>>;
  /** Кандидати, що пройшли фільтр і пішли до моделі. */
  reviewed: number;
  published: number;
  rejected: number;
  notes: string[];
}

interface SignalRow {
  id: number;
  created_at: string;
  symbol: string;
  side: "long" | "short";
  setup: string;
  entry_low: number;
  entry_high: number;
  stop: number;
  tp1: number;
  rr: number;
  status: SignalStatus;
  expires_at: string;
}

const HOUR = 3_600_000;
const SIDE_NAME = { long: "лонг", short: "шорт" } as const;
const coin = (symbol: string) => symbol.replace(/USDT$/, "");
const REPORT_TITLE: Record<ReportKind, string> = { morning: "Ранковий звіт готовий", evening: "Вечірній звіт готовий" };

/**
 * Рушій. Усі серверні запити назовні (біржа, Claude API, новини)
 * виходять тільки звідси: об'єкт закріплено в юрисдикції eu.
 */
export class Engine extends DurableObject<Env> {
  private running = false;
  /** Останній скан цього екземпляра: свічки потрібні детекторам і супроводу сигналів. */
  private lastScan: { runId: number; at: number; result: ScanResult } | null = null;

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
      await step("signals", () => this.runSignals());
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
      const summary = await this.runScan();
      await this.runSignals().catch((e) => console.error("крок signals:", e));
      return summary;
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
    let result: ScanResult = {
      snapshots: [],
      candles: new Map(),
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
    this.lastScan = { runId, at: started, result };
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

  // ── Сигнали ──────────────────────────────────────────────────────────────

  /** Супровід відкритих сигналів, потім пошук нових сетапів на свіжій свічці 1h. */
  private async runSignals(): Promise<SignalsSummary> {
    const started = Date.now();
    const scanned = this.lastScan;
    const summary: SignalsSummary = { updated: 0, detection: false, detected: 0, filtered: {}, reviewed: 0, published: 0, rejected: 0, notes: [] };
    if (!scanned || started - scanned.at > 10 * 60_000) throw new Error("немає свіжого скану для сигналів");
    let error: string | null = null;
    try {
      summary.updated = await this.trackSignals(started, scanned.result);
      await this.findSignals(started, scanned, summary);
    } catch (e) {
      error = String(e);
    }
    await this.env.DB.prepare(
      "INSERT INTO runs (kind, started_at, status, duration_ms, candidates, detail, error) VALUES ('signals', ?, ?, ?, ?, ?, ?)",
    )
      .bind(new Date(started).toISOString(), error ? "error" : "ok", Date.now() - started, summary.reviewed, JSON.stringify(summary), error)
      .run();
    if (error) throw new Error(error);
    return summary;
  }

  /** Вхід, ціль, стоп або прострочення для кожного відкритого сигналу. Повертає кількість змін. */
  private async trackSignals(now: number, scanned: ScanResult): Promise<number> {
    const db = this.env.DB;
    const open = await db
      .prepare("SELECT id, created_at, symbol, side, setup, entry_low, entry_high, stop, tp1, rr, status, expires_at FROM signals WHERE status IN ('pending', 'active') ORDER BY id")
      .all<SignalRow>();
    if (!open.results.length) return 0;
    const maxHoldMs = (await this.setting("signal_max_hold_hours", 48)) * HOUR;
    let updated = 0;
    for (const sig of open.results) {
      // Монету могли прибрати зі списку: тоді свічки беремо окремим запитом.
      const candles = scanned.candles.get(sig.symbol)?.["15m"] ?? (await this.market().candles(sig.symbol, "15m", 498));
      const res = replay(
        {
          side: sig.side,
          entryLow: sig.entry_low,
          entryHigh: sig.entry_high,
          stop: sig.stop,
          tp1: sig.tp1,
          createdAt: Date.parse(sig.created_at),
          expiresAt: Date.parse(sig.expires_at),
        },
        candles,
        now,
        maxHoldMs,
      );
      const known = await db.prepare("SELECT type FROM signal_events WHERE signal_id = ?").bind(sig.id).all<{ type: string }>();
      const have = new Set(known.results.map((e) => e.type));
      const fresh = res.events.filter((e) => !have.has(e.type));
      if (!fresh.length && res.status === sig.status) continue;
      updated++;
      const insert = db.prepare("INSERT INTO signal_events (signal_id, ts, type, price) VALUES (?, ?, ?, ?)");
      await db.batch([
        ...fresh.map((e) => insert.bind(sig.id, new Date(e.ts).toISOString(), e.type, e.price)),
        db
          .prepare("UPDATE signals SET status = ?, result_r = ?, resolved_at = ? WHERE id = ?")
          .bind(res.status, res.resultR, res.resolvedAt === null ? null : new Date(res.resolvedAt).toISOString(), sig.id),
      ]);
      const name = `${coin(sig.symbol)} ${SIDE_NAME[sig.side]}`;
      const text: Partial<Record<EventType, [title: string, body: string]>> = {
        entry: [`Вхід: ${name}`, `Ціна в зоні входу ${sig.entry_low}–${sig.entry_high}. Стоп ${sig.stop}, ціль ${sig.tp1}.`],
        tp1: [`Ціль: ${name}`, `Ціна дійшла до ${sig.tp1}. Результат +${res.resultR ?? sig.rr}R.`],
        stop: [`Стоп: ${name}`, `Ціна дійшла до стопа ${sig.stop}. Результат −1R.`],
        timeout: [`Закрито за часом: ${name}`, `Сигнал не дійшов ні до цілі, ні до стопа. Результат ${res.resultR}R.`],
      };
      // Якщо за один запуск сталося кілька подій, сповіщаємо лише про останню.
      const lastEvent = [...fresh].reverse().find((e) => text[e.type]);
      if (lastEvent) {
        const [title, body] = text[lastEvent.type]!;
        await this.signalPush(sig.id, { title, body, url: `/?signal=${sig.id}`, tag: `signal-${sig.id}` }, now);
      }
    }
    return updated;
  }

  /** Детектори → фільтр → аналітик → скептик → публікація. */
  private async findSignals(
    now: number,
    scanned: { runId: number; result: ScanResult },
    summary: SignalsSummary,
  ): Promise<void> {
    const db = this.env.DB;
    const { snapshots, candles, market } = scanned.result;
    // Сетапи шукаємо лише на свічці 1h, що закрилась щойно: о пів на годину вона вже застаріла.
    const fresh = snapshots.filter((s) => now - Date.parse(s.tf["1h"].closedAt) <= 20 * 60_000);
    summary.detection = fresh.length > 0;
    if (!fresh.length) return;

    const [minRr, maxActive, blackout, macro, threshold, ttl, cooldown, perScan] = await Promise.all([
      this.setting("min_rr", 2),
      this.setting("max_active_signals", 3),
      this.setting("macro_blackout_hours", 2),
      this.setting<unknown>("macro_events", []),
      this.setting("skeptic_threshold", 0.6),
      this.setting("signal_ttl_hours", 12),
      this.setting("signal_cooldown_hours", 6),
      this.setting("max_candidates_per_scan", 3),
    ]);
    const open = await db.prepare("SELECT symbol FROM signals WHERE status IN ('pending', 'active')").all<{ symbol: string }>();
    const recent = await db
      .prepare("SELECT symbol, setup, side FROM signals WHERE created_at >= ?")
      .bind(new Date(now - cooldown * HOUR).toISOString())
      .all<Pick<Candidate, "symbol" | "setup" | "side">>();
    const openSymbols = new Set(open.results.map((r) => r.symbol));
    let openCount = open.results.length;
    const toMacro = minutesToMacro(macro, now);
    const tally = (reason: Rejection) => (summary.filtered[reason] = (summary.filtered[reason] ?? 0) + 1);

    const passed: Candidate[] = [];
    for (const snap of fresh) {
      const c = candles.get(snap.symbol);
      if (!c) continue;
      for (const candidate of detect(snap.symbol, c["1h"], c["4h"])) {
        summary.detected++;
        const reason = reject(candidate, {
          minRr,
          regime: snap.regime,
          mood: market.mood,
          openSymbols,
          recent: new Set(recent.results.map(candidateKey)),
          minutesToMacro: toMacro,
          macroBlackoutHours: blackout,
          openCount,
          maxActive,
        });
        if (reason) tally(reason);
        else passed.push(candidate);
      }
    }
    if (!passed.length) return;

    // Найкращий за R:R кандидат на монету; до моделі йде обмежена кількість за скан.
    passed.sort((a, b) => b.rr - a.rr);
    const queue = passed.filter((c, i) => passed.findIndex((x) => x.symbol === c.symbol) === i).slice(0, perScan);
    const playbook = await this.playbook();
    const btc = snapshots.find((s) => s.symbol === "BTCUSDT") ?? null;
    const newsRows = await db
      .prepare("SELECT ts, category, impact, sentiment, symbols, relevance FROM news WHERE ts >= ? AND relevance >= 0.4 ORDER BY relevance DESC, ts DESC LIMIT 30")
      .bind(new Date(now - 12 * HOUR).toISOString())
      .all<{ ts: string; category: string; impact: string; sentiment: string; symbols: string; relevance: number }>();
    const news: NewsField[] = newsRows.results.map((n) => ({
      category: n.category,
      impact: n.impact,
      sentiment: n.sentiment,
      symbols: JSON.parse(n.symbols || "[]") as string[],
      relevance: n.relevance,
      age_hours: Math.round(((now - Date.parse(n.ts)) / HOUR) * 10) / 10,
    }));

    for (const candidate of queue) {
      if (openCount >= maxActive) {
        tally("max_active");
        continue;
      }
      try {
        const snapshot = snapshots.find((s) => s.symbol === candidate.symbol)!;
        const user = JSON.stringify(
          reviewInput({
            candidate,
            rule: playbook.rules[candidate.setup] ?? PLAYBOOK_V1[candidate.setup],
            snapshot,
            btc,
            market,
            news: news.filter((n) => n.symbols.includes(candidate.symbol) || n.symbols.includes("MARKET")).slice(0, 6),
            minutesToMacro: toMacro,
          }),
        );
        const review = { user, maxTokens: 8000, effort: "medium" as const };
        const first = await this.llm("analyst", { ...review, system: ANALYST_SYSTEM, schema: ANALYST_SCHEMA });
        if (!first) {
          summary.notes.push("стелю витрат вичерпано: нові сигнали не публікуються");
          break;
        }
        summary.reviewed++;
        const analyst = sanitizeAnalyst(first.data);
        // Скептик працює окремим викликом і не бачить відповіді аналітика.
        let skeptic: SkepticView | null = null;
        if (analyst.verdict === "take") {
          const second = await this.llm("skeptic", { ...review, system: SKEPTIC_SYSTEM, schema: SKEPTIC_SCHEMA });
          if (!second) {
            summary.notes.push("стелю витрат вичерпано: нові сигнали не публікуються");
            break;
          }
          skeptic = sanitizeSkeptic(second.data);
        }
        const decision = decide(analyst, skeptic, threshold);
        const reasoning: Reasoning = { v: 1, facts: candidate.facts, analyst, skeptic, rejectedBy: decision.publish ? null : decision.by };
        const createdAt = new Date(now).toISOString();
        const snapshotRow = await db.prepare("SELECT id FROM snapshots WHERE run_id = ? AND symbol = ?").bind(scanned.runId, candidate.symbol).first<{ id: number }>();
        const row = await db
          .prepare(
            `INSERT INTO signals (created_at, symbol, side, setup, entry_low, entry_high, stop, tp1, tp2, rr, p_analyst, p_skeptic,
               status, expires_at, resolved_at, reasoning, snapshot_id, playbook_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          )
          .bind(
            createdAt, candidate.symbol, candidate.side, candidate.setup, candidate.entryLow, candidate.entryHigh, candidate.stop,
            candidate.tp1, candidate.tp2, candidate.rr, analyst.probability, skeptic?.probability ?? null,
            decision.publish ? "pending" : "rejected", new Date(now + ttl * HOUR).toISOString(), decision.publish ? null : createdAt,
            JSON.stringify(reasoning), snapshotRow?.id ?? null, playbook.version,
          )
          .first<{ id: number }>();
        if (!decision.publish) {
          summary.rejected++;
          continue;
        }
        summary.published++;
        openCount++;
        openSymbols.add(candidate.symbol);
        await this.signalPush(row!.id, await this.signalMessage(row!.id, candidate), now);
      } catch (e) {
        summary.notes.push(`${candidate.symbol} ${candidate.setup}: ${String(e)}`);
      }
    }
  }

  /** Текст сповіщення про новий сигнал. Розмір позиції рахує код від ризику на угоду. */
  private async signalMessage(id: number, c: Candidate): Promise<PushMessage> {
    const [deposit, riskPct] = await Promise.all([this.setting<number | null>("deposit_usd", null), this.setting("risk_per_trade_pct", 1)]);
    const size = deposit ? positionSize(deposit, riskPct, entryMid(c.entryLow, c.entryHigh), c.stop) : null;
    return {
      title: `Сигнал: ${coin(c.symbol)} ${SIDE_NAME[c.side]}`,
      body:
        `${SETUP_NAME[c.setup]} · вхід ${c.entryLow}–${c.entryHigh} · стоп ${c.stop} · ціль ${c.tp1} · R:R ${c.rr}` +
        (size ? ` · розмір $${Math.round(size.notionalUsd)}` : ""),
      url: `/?signal=${id}`,
      tag: `signal-${id}`,
    };
  }

  /** Активні правила сетапів. Першу версію рушій кладе в базу сам; наступні вмикає людина. */
  private async playbook(): Promise<{ version: number; rules: Partial<Record<SetupId, string>> }> {
    const db = this.env.DB;
    const active = await db.prepare("SELECT version, content FROM playbook_versions WHERE active = 1 ORDER BY version DESC LIMIT 1").first<{ version: number; content: string }>();
    if (active) {
      try {
        return { version: active.version, rules: JSON.parse(active.content) as Partial<Record<SetupId, string>> };
      } catch {
        return { version: active.version, rules: {} };
      }
    }
    const created = await db
      .prepare("INSERT INTO playbook_versions (created_at, content, active) VALUES (?, ?, 1) RETURNING version")
      .bind(new Date().toISOString(), JSON.stringify(PLAYBOOK_V1))
      .first<{ version: number }>();
    return { version: created!.version, rules: PLAYBOOK_V1 };
  }

  /**
   * Сповіщення про сигнал: не в тихі години і не більше ліміту на місцеву добу.
   * Надіслане лягає в signal_events подією push, за нею і рахується ліміт.
   */
  private async signalPush(signalId: number, message: PushMessage, now: number): Promise<void> {
    const [timezone, quiet, limit] = await Promise.all([
      this.setting("timezone", "Europe/Kyiv"),
      this.setting<{ from?: string; to?: string } | null>("quiet_hours", null),
      this.setting("max_signal_pushes_per_day", 5),
    ]);
    const local = localTime(now, timezone);
    const from = parseClock(quiet?.from ?? "");
    const to = parseClock(quiet?.to ?? "");
    if (from !== null && to !== null && from !== to) {
      const m = local.minutes;
      if (from < to ? m >= from && m < to : m >= from || m < to) return;
    }
    const dayStart = new Date(now - local.minutes * 60_000).toISOString();
    const sent = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM signal_events WHERE type = 'push' AND ts >= ?").bind(dayStart).first<{ n: number }>();
    if ((sent?.n ?? 0) >= limit) return;
    await this.push(message);
    await this.env.DB.prepare("INSERT INTO signal_events (signal_id, ts, type, price) VALUES (?, ?, 'push', NULL)")
      .bind(signalId, new Date(now).toISOString())
      .run();
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
