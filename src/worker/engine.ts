import { DurableObject } from "cloudflare:workers";
import { isTeamDomain, type AccessJwk } from "./access";
import { marketContext } from "./context";
import type { Env } from "./env";
import { resolveForecast, type ForecastRule } from "./forecasts";
import { AGENTS, AI_KEYS, aiFromSettings, type AgentConfig, type AgentId, type AiConfig, type ModelInfo } from "../shared/ai";
import {
  compactModels,
  costUsd,
  decideModel,
  LlmError,
  monthStart,
  OPENROUTER,
  openRouterTransport,
  parseKeyInfo,
  type KeyInfo,
  type Pipeline,
  type Transport,
} from "./llm";
import { loadStats } from "./stats";
import { sanitizeWeekly, WEEKLY_SCHEMA, WEEKLY_SYSTEM, weeklyBody, weeklyInput, type WeeklyReview } from "./weekly";
import { BinanceFutures } from "./market/binance";
import { BybitLinear } from "./market/bybit";
import { FailoverMarket } from "./market/failover";
import type { Candle, MarketData } from "./market/types";
import { newsHash, parseFeed } from "./news/rss";
import { sanitizeTriage, TRIAGE_SYSTEM, triageSchema, triageUser, type TriageInput } from "./news/triage";
import { parseSubscription, sendPush, type PushMessage, type PushOutcome, type StoredSubscription } from "./push";
import type { MarketRegime } from "./regime";
import { reportInput, type NewsField, type PriorForecast } from "./report/input";
import { reportSchema, reportSystem, sanitizeReport, type ReportContent } from "./report/schema";
import { CANDLE_LIMIT, CHUNK_SIZE, marketFromSnapshots, scanChunk, type ChunkResult } from "./scan";
import { CachedMarket, SqlCandleStorage } from "./market/cache";
import { entryMid, feeR, positionSize, type Fees } from "../shared/risk";
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
import { clock, dueReports, dueWeekly, localTime, parseClock, type ReportKind, type ReportTimes } from "./time";

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

/** Стан циклу між кроками. Лежить у сховищі Durable Object, тож переживає перезапуск рушія. */
interface PipelineState {
  startedAt: number;
  /** Список монет на момент планування: усі кроки скану працюють з тим самим списком. */
  symbols: string[];
  /** Черга кроків: scan:N, scan:done, news, signals, review:N, forecasts, reports, weekly, cleanup. */
  steps: string[];
  log: { step: string; ms: number; requests: number; error?: string }[];
  scan?: { runId: number; market: MarketRegime };
  candidates?: Candidate[];
  signals?: SignalsSummary;
}

const PIPELINE_KEY = "pipeline";
const PIPELINE_STALE_MS = 25 * 60_000;

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
  tp2: number | null;
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
  /** Лічильник зовнішніх запитів поточного кроку: безкоштовний план Workers дозволяє 50 за один запуск. */
  private requests = 0;
  /** Усі запити назовні йдуть через цю обгортку, щоб їх рахувати. */
  private readonly http = (input: string, init?: RequestInit): Promise<Response> => {
    this.requests++;
    return fetch(input, init);
  };

  // ── Цикл кроками ─────────────────────────────────────────────────────────

  /**
   * Викликається з Cron Trigger раз на 30 хв. Лише планує цикл: самі кроки виконує будильник (alarm),
   * по одному на запуск. Кожен запуск має власні ліміти (50 запитів, 10 мс процесора на безкоштовному плані),
   * тож цикл не впирається в них, хоч би скільки монет було в списку.
   */
  async tick(): Promise<{ queued: boolean; steps?: string[] }> {
    return this.startPipeline(Date.now());
  }

  private async pipelineState(): Promise<PipelineState | undefined> {
    return this.ctx.storage.get<PipelineState>(PIPELINE_KEY);
  }

  /** Чи триває цикл. Завислий понад 25 хв вважається мертвим і не заважає новому. */
  private async busy(): Promise<boolean> {
    const state = await this.pipelineState();
    return !!state && Date.now() - state.startedAt < PIPELINE_STALE_MS;
  }

  private async startPipeline(now: number): Promise<{ queued: boolean; steps?: string[] }> {
    if (await this.busy()) return { queued: false };
    this.settingsCache = null;
    const symbols = await this.watchlist();
    const steps = [
      ...Array.from({ length: Math.ceil(symbols.length / CHUNK_SIZE) }, (_, i) => `scan:${i}`),
      "scan:done",
      "news",
      "signals",
      "forecasts",
      "reports",
      "weekly",
      "cleanup",
    ];
    await this.ctx.storage.put<PipelineState>(PIPELINE_KEY, { startedAt: now, symbols, steps, log: [] });
    await this.ctx.storage.setAlarm(Date.now());
    return { queued: true, steps };
  }

  /** Один крок циклу на один запуск будильника. Збій кроку записується й не зупиняє наступні. */
  async alarm(): Promise<void> {
    const state = await this.pipelineState();
    if (!state) return;
    const step = state.steps.shift();
    if (!step) return this.finishPipeline(state);
    // Крок знімається з черги до виконання: якщо запуск упаде посередині, цикл не застрягне на ньому.
    await this.ctx.storage.put(PIPELINE_KEY, state);
    this.settingsCache = null;
    this.requests = 0;
    const t0 = Date.now();
    let error: string | undefined;
    try {
      await this.runStep(step, state);
    } catch (e) {
      error = String(e).slice(0, 500);
      console.error(`крок ${step}:`, e);
    }
    state.log.push({ step, ms: Date.now() - t0, requests: this.requests, ...(error ? { error } : {}) });
    if (!state.steps.length) return this.finishPipeline(state);
    await this.ctx.storage.put(PIPELINE_KEY, state);
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async runStep(step: string, state: PipelineState): Promise<void> {
    const now = Date.now();
    const [name, arg] = step.split(":");
    switch (name) {
      case "scan":
        return arg === "done" ? this.finishScan(state) : this.scanPart(state, Number(arg));
      case "news":
        return this.runNews(now);
      case "signals":
        return this.runSignals(state, now);
      case "review":
        return this.reviewCandidate(state, Number(arg), now);
      case "forecasts":
        return this.resolveForecasts(now);
      case "reports":
        for (const due of await this.dueReports(now)) await this.runReport(due.kind, due.date);
        return;
      case "weekly":
        await this.runWeekly(now);
        return;
      case "cleanup":
        return this.cleanup(now);
    }
  }

  /** Підсумок циклу: що зроблено, скільки запитів пішло на кожен крок. */
  private async finishPipeline(state: PipelineState): Promise<void> {
    await this.ctx.storage.delete(PIPELINE_KEY);
    const db = this.env.DB;
    const failed = state.log.filter((l) => l.error);
    const statements = [
      db
        .prepare("INSERT INTO runs (kind, started_at, status, duration_ms, detail, error) VALUES ('pipeline', ?, ?, ?, ?, ?)")
        .bind(
          new Date(state.startedAt).toISOString(),
          failed.length ? "error" : "ok",
          Date.now() - state.startedAt,
          JSON.stringify({ steps: state.log }),
          failed.length ? failed.map((l) => `${l.step}: ${l.error}`).join("; ").slice(0, 2000) : null,
        ),
    ];
    if (state.signals) {
      statements.push(
        db
          .prepare("INSERT INTO runs (kind, started_at, status, duration_ms, candidates, detail, error) VALUES ('signals', ?, 'ok', ?, ?, ?, NULL)")
          .bind(new Date(state.startedAt).toISOString(), Date.now() - state.startedAt, state.signals.reviewed, JSON.stringify(state.signals)),
      );
    }
    await db.batch(statements);
  }

  /** Ручний запуск звіту з API. null, якщо рушій зайнятий; помилка, якщо звіт за цю дату вже є. */
  async reportNow(kind: ReportKind): Promise<ReportSummary | { error: string } | null> {
    if (await this.busy()) return null;
    try {
      const now = Date.now();
      const date = localTime(now, await this.setting("timezone", "Europe/Kyiv")).date;
      if (await this.reportExists(kind, date)) return { error: "звіт за цю дату вже є" };
      await this.runNews(now).catch((e) => console.error("крок news:", e));
      await this.resolveForecasts(now).catch((e) => console.error("крок forecasts:", e));
      return await this.runReport(kind, date);
    } catch (e) {
      return { error: String(e) };
    }
  }

  /** Пробне сповіщення на всі підписки й у Telegram. */
  async pushTest(): Promise<PushOutcome> {
    return this.push({ title: "Асистент трейдера", body: "Сповіщення працюють.", url: "/", tag: "test" });
  }

  /** Ручний запуск циклу з API. Результат з'являється за хвилину: кроки йдуть через будильник. */
  async scanNow(): Promise<{ queued: boolean; steps?: string[] }> {
    return this.startPipeline(Date.now());
  }

  private marketCache: { source: string; market: MarketData } | null = null;
  private candleStorage: SqlCandleStorage | null = null;

  /**
   * Джерело ринкових даних за settings.market_source: binance, bybit або auto
   * (Binance, а якщо він відмовляє за локацією, то Bybit до перезапуску рушія).
   * Свічки йдуть через кеш у сховищі рушія: біржа докачує лише нові.
   */
  private async market(): Promise<MarketData> {
    const source = await this.setting("market_source", "auto");
    if (this.marketCache?.source !== source) {
      const binance = () => new BinanceFutures(this.http);
      const bybit = () => new BybitLinear(this.http);
      const inner = source === "binance" ? binance() : source === "bybit" ? bybit() : new FailoverMarket(binance(), bybit());
      this.candleStorage ??= new SqlCandleStorage(this.ctx.storage.sql);
      this.marketCache = { source, market: new CachedMarket(inner, this.candleStorage) };
    }
    return this.marketCache.market;
  }

  /** Частина скану: кілька монет, результат чекає в сховищі рушія на крок scan:done. */
  private async scanPart(state: PipelineState, index: number): Promise<void> {
    const symbols = state.symbols.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
    const part = await scanChunk(await this.market(), symbols, state.startedAt);
    await this.ctx.storage.put(`scan-part:${index}`, part);
  }

  /** Збирає частини скану: режим ринку, запис запуску й знімків у базу, денні ціни. */
  private async finishScan(state: PipelineState): Promise<void> {
    const db = this.env.DB;
    const keys = Array.from({ length: Math.ceil(state.symbols.length / CHUNK_SIZE) }, (_, i) => `scan-part:${i}`);
    const parts = await this.ctx.storage.get<ChunkResult>(keys);
    const snapshots: Snapshot[] = [];
    const errors: ChunkResult["errors"] = [];
    for (const key of keys) {
      const part = parts.get(key);
      if (!part) {
        errors.push({ symbol: null, message: `частина скану ${key.split(":")[1]} не виконалась` });
        continue;
      }
      snapshots.push(...part.snapshots);
      // Збій фандингу повторюється в кожній частині: лишаємо один запис.
      for (const e of part.errors) if (e.symbol !== null || !errors.some((x) => x.message === e.message)) errors.push(e);
    }
    const market = marketFromSnapshots(snapshots);
    const source = (await this.market()).name;
    const failed = state.symbols.length === 0 || snapshots.length < state.symbols.length;
    const summary = { source, market, symbols: state.symbols.length, snapshots: snapshots.length, errors };
    const run = await db
      .prepare("INSERT INTO runs (kind, started_at, status, duration_ms, detail, error) VALUES ('scan', ?, ?, ?, ?, ?) RETURNING id")
      .bind(
        new Date(state.startedAt).toISOString(),
        failed ? "error" : "ok",
        Date.now() - state.startedAt,
        JSON.stringify(summary),
        failed ? errors.map((e) => (e.symbol ? `${e.symbol}: ${e.message}` : e.message)).join("; ").slice(0, 2000) || "порожній список монет" : null,
      )
      .first<{ id: number }>();
    const runId = run!.id;
    // Кілька знімків одним запитом: менше звернень до бази за запуск (ліміт 100 параметрів на запит).
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < snapshots.length; i += 30) {
      const rows = snapshots.slice(i, i + 30);
      statements.push(
        db
          .prepare(`INSERT INTO snapshots (run_id, symbol, features) VALUES ${rows.map(() => "(?, ?, ?)").join(", ")}`)
          .bind(...rows.flatMap((s) => [runId, s.symbol, JSON.stringify(s)])),
      );
    }
    if (statements.length) await db.batch(statements);
    await this.ctx.storage.delete(keys);
    state.scan = { runId, market };
    await this.recordDailyPrices(snapshots.map((s) => s.symbol)).catch((e) => console.error("денні ціни:", e));
  }

  /**
   * Денні закриття для порівняння з утриманням BTC. Щоразу пишемо останню закриту денну свічку;
   * якщо таблиця порожня, заповнюємо 120 днів історії. Свічки беруться з кешу, біржу не питаємо.
   */
  private async recordDailyPrices(symbols: string[]): Promise<void> {
    const db = this.env.DB;
    const empty = (await db.prepare("SELECT 1 AS x FROM prices_daily LIMIT 1").first()) === null;
    const market = await this.market();
    const rows: [string, string, number][] = [];
    for (const symbol of symbols) {
      const daily = await market.candles(symbol, "1d", CANDLE_LIMIT);
      for (const d of daily.slice(empty ? -120 : -1)) rows.push([symbol, new Date(d.closeTime).toISOString().slice(0, 10), d.close]);
    }
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < rows.length; i += 30) {
      const part = rows.slice(i, i + 30);
      statements.push(
        db.prepare(`INSERT OR IGNORE INTO prices_daily (symbol, date, close) VALUES ${part.map(() => "(?, ?, ?)").join(", ")}`).bind(...part.flat()),
      );
    }
    if (statements.length) await db.batch(statements);
  }

  private async watchlist(): Promise<string[]> {
    const list = await this.setting<unknown>("watchlist", []);
    if (!Array.isArray(list)) throw new Error("settings.watchlist має бути масивом");
    return list.filter((s): s is string => typeof s === "string" && /^[A-Z0-9]{2,20}$/.test(s));
  }

  /** Свічки для графіка в застосунку: з кешу рушія, біржа докачує лише нові. */
  async candles(symbol: string, timeframe: "15m" | "1h" | "4h", limit: number): Promise<Candle[]> {
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new Error("невідомий символ");
    const n = Math.min(Math.max(Math.trunc(limit) || 96, 10), 300);
    return (await (await this.market()).candles(symbol, timeframe, n)).slice(-n);
  }

  private accessKeysCache: { domain: string; keys: AccessJwk[]; at: number } | null = null;

  /** Публічні ключі команди Cloudflare Access для перевірки токенів у Worker. Кеш на 10 хв. */
  async accessKeys(teamDomain: string): Promise<AccessJwk[]> {
    if (!isTeamDomain(teamDomain)) throw new Error("ACCESS_TEAM_DOMAIN має бути <команда>.cloudflareaccess.com");
    const cached = this.accessKeysCache;
    if (cached && cached.domain === teamDomain && Date.now() - cached.at < 10 * 60_000) return cached.keys;
    const res = await this.http(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`ключі Access: HTTP ${res.status}`);
    const keys = ((await res.json()) as { keys?: AccessJwk[] }).keys ?? [];
    this.accessKeysCache = { domain: teamDomain, keys, at: Date.now() };
    return keys;
  }

  /** Перевірка: чи відповідають Binance і Claude API з дата-центру рушія. */
  async probe(): Promise<ProbeResult> {
    const started = Date.now();
    const at = new Date(started).toISOString();
    const targets = await Promise.all([
      this.check("binance-futures", "https://fapi.binance.com/fapi/v1/time"),
      this.check("binance-spot-data", "https://data-api.binance.vision/api/v3/time"),
      this.check("bybit-linear", "https://api.bybit.com/v5/market/time"),
      this.checkOpenRouter(),
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
      const res = await this.http(url, { signal: AbortSignal.timeout(10_000) });
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

  /** OpenRouter: з ключем перевіряємо сам ключ, без ключа лише доступність каталогу моделей. */
  private async checkOpenRouter(): Promise<ProbeTarget> {
    const t0 = Date.now();
    const key = this.env.OPENROUTER_API_KEY;
    try {
      const res = await this.http(key ? `${OPENROUTER}/key` : `${OPENROUTER}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel();
      return {
        name: "openrouter",
        ok: res.ok,
        status: res.status,
        ms: Date.now() - t0,
        note: key ? (res.status === 401 ? "ключ не прийнято" : undefined) : "ключ не задано, перевірено лише доступність",
      };
    } catch (e) {
      return { name: "openrouter", ok: false, status: null, ms: Date.now() - t0, note: String(e) };
    }
  }

  // ── Налаштування ─────────────────────────────────────────────────────────

  private settingsCache: { at: number; values: Map<string, unknown> } | null = null;

  /**
   * Усі налаштування одним запитом і кеш на кілька секунд: на безкоштовному плані за один запуск
   * можна не більше 50 звернень до бази. Кожен крок циклу починає зі свіжого читання.
   */
  private async settingsMap(): Promise<Map<string, unknown>> {
    if (this.settingsCache && Date.now() - this.settingsCache.at < 5_000) return this.settingsCache.values;
    const rows = await this.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
    const values = new Map<string, unknown>();
    for (const r of rows.results) {
      try {
        values.set(r.key, JSON.parse(r.value));
      } catch {
        // Пошкоджене значення: візьметься значення за замовчуванням.
      }
    }
    this.settingsCache = { at: Date.now(), values };
    return values;
  }

  private async setting<T>(key: string, fallback: T): Promise<T> {
    const value = (await this.settingsMap()).get(key);
    return value === undefined ? fallback : (value as T);
  }

  private async logRun(kind: string, started: number, detail: unknown, error: string | null): Promise<void> {
    await this.env.DB.prepare(
      "INSERT INTO runs (kind, started_at, status, duration_ms, detail, error) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(kind, new Date(started).toISOString(), error ? "error" : "ok", Date.now() - started, JSON.stringify(detail), error?.slice(0, 2000) ?? null)
      .run();
  }

  // ── Модель ───────────────────────────────────────────────────────────────

  /** Підміняється в тестах; у роботі це OpenRouter. */
  protected transport(): Transport {
    if (!this.env.OPENROUTER_API_KEY) throw new LlmError("OPENROUTER_API_KEY не задано");
    return openRouterTransport(this.env.OPENROUTER_API_KEY, this.env.APP_ORIGIN || undefined, this.http);
  }

  private async aiConfig(): Promise<AiConfig> {
    return aiFromSettings(Object.fromEntries(await this.settingsMap()));
  }

  private async spentThisMonth(): Promise<number> {
    const row = await this.env.DB.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM llm_calls WHERE ts >= ?")
      .bind(monthStart(Date.now()))
      .first<{ spent: number }>();
    return row?.spent ?? 0;
  }

  /**
   * Єдиний шлях до моделі: стеля місячних витрат перевіряється перед викликом,
   * кожен виклик пишеться в llm_calls. Модель, рівень міркування й ліміт беруться з налаштувань агента.
   * null, якщо стеля не дозволяє цей конвеєр.
   */
  private async llm(
    pipeline: Exclude<Pipeline, "test">,
    req: { system: string; user: string; schema: Record<string, unknown> },
  ): Promise<{ data: unknown; model: string; costUsd: number } | null> {
    const ai = await this.aiConfig();
    const decision = decideModel(pipeline, await this.spentThisMonth(), ai);
    if (!decision.allowed) return null;
    const res = await this.call(pipeline, decision.agent, ai, req);
    return { data: JSON.parse(res.text) as unknown, model: res.model, costUsd: res.cost };
  }

  /** Виклик і запис у llm_calls. Вартість: від OpenRouter, інакше за ціною з каталогу. */
  private async call(pipeline: Pipeline, agent: AgentConfig, ai: AiConfig, req: { system: string; user: string; schema: Record<string, unknown> }) {
    const t0 = Date.now();
    const res = await this.transport()({
      ...req,
      model: agent.model,
      fallback: agent.fallback,
      effort: agent.effort,
      maxTokens: agent.maxTokens,
      dataCollection: ai.dataCollection,
    });
    const price = res.costUsd === null ? ((await this.models().catch(() => [] as ModelInfo[])).find((m) => m.id === res.model) ?? null) : null;
    const cost = costUsd(res.costUsd, res.usage, price);
    const latencyMs = Date.now() - t0;
    await this.env.DB.prepare(
      "INSERT INTO llm_calls (ts, pipeline, model, tokens_in, tokens_out, cost_usd, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(new Date(t0).toISOString(), pipeline, res.model, res.usage.inputTokens, res.usage.outputTokens, cost, latencyMs)
      .run();
    return { ...res, cost, latencyMs };
  }

  private modelsCache: { at: number; models: ModelInfo[] } | null = null;

  /** Каталог моделей OpenRouter із підтримкою JSON-схеми. Кеш на 6 годин. */
  async models(): Promise<ModelInfo[]> {
    // Стиснутий каталог живе й у сховищі рушія: великий файл OpenRouter розбирається не частіше ніж раз на 6 годин,
    // навіть якщо рушій перезапускався (безкоштовний план дає 10 мс процесора на запуск).
    this.modelsCache ??= (await this.ctx.storage.get<{ at: number; models: ModelInfo[] }>("models")) ?? null;
    if (this.modelsCache && Date.now() - this.modelsCache.at < 6 * HOUR) return this.modelsCache.models;
    const res = await this.http(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`каталог моделей OpenRouter: HTTP ${res.status}`);
    const models = compactModels(((await res.json()) as { data?: Parameters<typeof compactModels>[0] }).data ?? []);
    this.modelsCache = { at: Date.now(), models };
    await this.ctx.storage.put("models", this.modelsCache);
    return models;
  }

  /** Стан ключа OpenRouter: використано, ліміт. null, якщо ключа немає. */
  async keyInfo(): Promise<KeyInfo | null> {
    const key = this.env.OPENROUTER_API_KEY;
    if (!key) return null;
    const res = await this.http(`${OPENROUTER}/key`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(res.status === 401 ? "OpenRouter не прийняв ключ" : `OpenRouter: HTTP ${res.status}`);
    return parseKeyInfo(await res.json());
  }

  /**
   * Пробний виклик агента з поточними (або переданими з форми) налаштуваннями: чи відповідає модель JSON за схемою.
   * Теж під стелею витрат і теж пишеться в llm_calls.
   */
  async testAgent(
    id: AgentId,
    override?: AgentConfig,
  ): Promise<{ ok: boolean; model?: string; latencyMs?: number; costUsd?: number; error?: string }> {
    if (!AGENTS.some((a) => a.id === id)) return { ok: false, error: "невідомий агент" };
    const ai = await this.aiConfig();
    if ((await this.spentThisMonth()) >= ai.budgetUsd) return { ok: false, error: `стелю $${ai.budgetUsd} вичерпано` };
    try {
      const res = await this.call("test", override ?? ai.agents[id], ai, {
        system: "Ти перевіряєш з'єднання. Поверни JSON за схемою: ok = true, echo = слово з поля word у вхідних даних.",
        user: JSON.stringify({ word: "ping" }),
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["ok", "echo"],
          properties: { ok: { type: "boolean" }, echo: { type: "string" } },
        },
      });
      const data = JSON.parse(res.text) as { ok?: unknown };
      const ok = data.ok === true;
      return { ok, model: res.model, latencyMs: res.latencyMs, costUsd: res.cost, ...(ok ? {} : { error: "модель відповіла не за схемою" }) };
    } catch (e) {
      return { ok: false, error: e instanceof LlmError ? e.message : String(e) };
    }
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
          const res = await this.http(feed.url, {
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
    const market = await this.market();
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

  private async reportExists(kind: ReportKind | "weekly", date: string): Promise<boolean> {
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
    const { context, errors: warnings } = await marketContext(this.http, this.env.COINGECKO_API_KEY);

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

  /**
   * Супровід відкритих сигналів, потім пошук нових сетапів на свіжій свічці 1h.
   * Кандидати, що пройшли фільтр, стають окремими кроками review: так виклики моделей
   * не збираються в один запуск і не впираються в його ліміти.
   */
  private async runSignals(state: PipelineState, now: number): Promise<void> {
    const summary: SignalsSummary = { updated: 0, detection: false, detected: 0, filtered: {}, reviewed: 0, published: 0, rejected: 0, notes: [] };
    state.signals = summary;
    summary.updated = await this.trackSignals(now);
    if (!state.scan) {
      summary.notes.push("скан не вдався: нові сетапи не шукались");
      return;
    }
    state.candidates = await this.findCandidates(now, state.scan, summary);
    state.steps.unshift(...state.candidates.map((_, i) => `review:${i}`));
  }

  /** Вхід, ціль, стоп або прострочення для кожного відкритого сигналу. Повертає кількість змін. */
  private async trackSignals(now: number): Promise<number> {
    const db = this.env.DB;
    const open = await db
      .prepare("SELECT id, created_at, symbol, side, setup, entry_low, entry_high, stop, tp1, tp2, rr, status, expires_at FROM signals WHERE status IN ('pending', 'active') ORDER BY id")
      .all<SignalRow>();
    const maxHoldMs = (await this.setting("signal_max_hold_hours", 48)) * HOUR;
    const fees: Fees = { makerPct: await this.setting("fee_maker_pct", 0.02), takerPct: await this.setting("fee_taker_pct", 0.05) };
    let updated = 0;
    const market = await this.market();
    for (const sig of open.results) {
      // Свічки з кешу: якщо монета в списку, скан їх щойно оновив, і біржу не питаємо.
      const candles = await market.candles(sig.symbol, "15m", CANDLE_LIMIT);
      const res = replay(
        {
          side: sig.side,
          entryLow: sig.entry_low,
          entryHigh: sig.entry_high,
          stop: sig.stop,
          tp1: sig.tp1,
          tp2: sig.tp2,
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
          .prepare("UPDATE signals SET status = ?, result_r = ?, fee_r = ?, resolved_at = ? WHERE id = ?")
          .bind(
            res.status,
            res.resultR,
            res.resolvedAt === null ? null : feeR(res.entry, sig.stop, res.exits, fees),
            res.resolvedAt === null ? null : new Date(res.resolvedAt).toISOString(),
            sig.id,
          ),
      ]);
      const name = `${coin(sig.symbol)} ${SIDE_NAME[sig.side]}`;
      const text: Partial<Record<EventType, [title: string, body: string]>> = {
        entry: [`Вхід: ${name}`, `Ціна дійшла до середини зони входу ${Number(entryMid(sig.entry_low, sig.entry_high).toPrecision(6))}. Стоп ${sig.stop}, ціль ${sig.tp1}.`],
        tp1:
          sig.tp2 === null
            ? [`Ціль: ${name}`, `Ціна дійшла до ${sig.tp1}. Результат +${res.resultR ?? sig.rr}R.`]
            : [`Ціль 1: ${name}`, `Ціна дійшла до ${sig.tp1}. Половину зафіксовано, стоп решти в беззбиток, далі ціль ${sig.tp2}.`],
        tp2: [`Ціль 2: ${name}`, `Ціна дійшла до ${sig.tp2}. Результат +${res.resultR}R.`],
        breakeven: [`Беззбиток: ${name}`, `Решта позиції закрилась у беззбиток. Результат +${res.resultR}R.`],
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
    await this.trackShadows(now, maxHoldMs, fees);
    return updated;
  }

  /**
   * Тіньовий супровід відхилених моделлю кандидатів: ті самі правила, але без подій і сповіщень.
   * shadow_r зберігається вже після комісій. Потрібен, щоб калібрувати оцінки й бачити, що відсіяв скептик.
   */
  private async trackShadows(now: number, maxHoldMs: number, fees: Fees): Promise<void> {
    const db = this.env.DB;
    const rows = await db
      .prepare(
        `SELECT id, created_at, symbol, side, entry_low, entry_high, stop, tp1, tp2, expires_at FROM signals
         WHERE status = 'rejected' AND (shadow_status IS NULL OR shadow_status IN ('pending', 'active')) AND created_at >= ?`,
      )
      .bind(new Date(now - 4 * 24 * HOUR).toISOString())
      .all<SignalRow>();
    const update = db.prepare("UPDATE signals SET shadow_status = ?, shadow_r = ? WHERE id = ?");
    const statements: D1PreparedStatement[] = [];
    const market = await this.market();
    const watched = new Set(await this.watchlist());
    for (const sig of rows.results) {
      // Тінь ведемо лише для монет зі списку: їхні свічки вже в кеші, зайвих запитів до біржі немає.
      if (!watched.has(sig.symbol)) continue;
      const candles = await market.candles(sig.symbol, "15m", CANDLE_LIMIT);
      const res = replay(
        { side: sig.side, entryLow: sig.entry_low, entryHigh: sig.entry_high, stop: sig.stop, tp1: sig.tp1, tp2: sig.tp2, createdAt: Date.parse(sig.created_at), expiresAt: Date.parse(sig.expires_at) },
        candles,
        now,
        maxHoldMs,
      );
      const shadowR = res.resultR === null ? null : Number((res.resultR - feeR(res.entry, sig.stop, res.exits, fees)).toFixed(3));
      statements.push(update.bind(res.status, shadowR, sig.id));
    }
    if (statements.length) await db.batch(statements);
  }

  /**
   * Детектори → фільтр. Повертає кандидатів для моделі; самі виклики аналітика і скептика
   * йдуть окремими кроками review, по одному кандидату на запуск.
   */
  private async findCandidates(now: number, scan: { runId: number; market: MarketRegime }, summary: SignalsSummary): Promise<Candidate[]> {
    const db = this.env.DB;
    const rows = await db.prepare("SELECT features FROM snapshots WHERE run_id = ?").bind(scan.runId).all<{ features: string }>();
    const snapshots = rows.results.map((r) => JSON.parse(r.features) as Snapshot);
    // Сетапи шукаємо лише на свічці 1h, що закрилась щойно: о пів на годину вона вже застаріла.
    const fresh = snapshots.filter((s) => now - Date.parse(s.tf["1h"].closedAt) <= 20 * 60_000);
    summary.detection = fresh.length > 0;
    if (!fresh.length) return [];

    const [minRr, minStopPct, maxActive, blackout, macro, cooldown, perScan] = await Promise.all([
      this.setting("min_rr", 2),
      this.setting("min_stop_pct", 1),
      this.setting("max_active_signals", 3),
      this.setting("macro_blackout_hours", 2),
      this.setting<unknown>("macro_events", []),
      this.setting("signal_cooldown_hours", 6),
      this.setting("max_candidates_per_scan", 3),
    ]);
    const [open, recent] = await Promise.all([
      db.prepare("SELECT symbol FROM signals WHERE status IN ('pending', 'active')").all<{ symbol: string }>(),
      db
        .prepare("SELECT symbol, setup, side FROM signals WHERE created_at >= ?")
        .bind(new Date(now - cooldown * HOUR).toISOString())
        .all<Pick<Candidate, "symbol" | "setup" | "side">>(),
    ]);
    const openSymbols = new Set(open.results.map((r) => r.symbol));
    const recentKeys = new Set(recent.results.map(candidateKey));
    const toMacro = minutesToMacro(macro, now);
    const market = await this.market();

    const passed: Candidate[] = [];
    for (const snap of fresh) {
      // Свічки з кешу: скан щойно їх оновив, біржу не питаємо.
      const [h1, h4] = await Promise.all([market.candles(snap.symbol, "1h", CANDLE_LIMIT), market.candles(snap.symbol, "4h", CANDLE_LIMIT)]);
      for (const candidate of detect(snap.symbol, h1, h4)) {
        summary.detected++;
        const reason = reject(candidate, {
          minRr,
          minStopPct,
          regime: snap.regime,
          mood: scan.market.mood,
          openSymbols,
          recent: recentKeys,
          minutesToMacro: toMacro,
          macroBlackoutHours: blackout,
          openCount: open.results.length,
          maxActive,
        });
        if (reason) summary.filtered[reason] = (summary.filtered[reason] ?? 0) + 1;
        else passed.push(candidate);
      }
    }
    // Найкращий за R:R кандидат на монету; до моделі йде обмежена кількість за скан.
    passed.sort((a, b) => b.rr - a.rr);
    return passed.filter((c, i) => passed.findIndex((x) => x.symbol === c.symbol) === i).slice(0, perScan);
  }

  /** Аналітик → скептик → публікація для одного кандидата. Окремий крок циклу. */
  private async reviewCandidate(state: PipelineState, index: number, now: number): Promise<void> {
    const candidate = state.candidates?.[index];
    const summary = state.signals;
    const scan = state.scan;
    if (!candidate || !summary || !scan) return;
    const db = this.env.DB;
    const [maxActive, macro, threshold, ttl] = await Promise.all([
      this.setting("max_active_signals", 3),
      this.setting<unknown>("macro_events", []),
      this.setting("skeptic_threshold", 0.6),
      this.setting("signal_ttl_hours", 12),
    ]);
    // Попередні кроки могли вже опублікувати сигнали: ліміт перевіряється заново.
    const open = await db.prepare("SELECT symbol FROM signals WHERE status IN ('pending', 'active')").all<{ symbol: string }>();
    if (open.results.length >= maxActive || open.results.some((r) => r.symbol === candidate.symbol)) {
      const reason: Rejection = open.results.length >= maxActive ? "max_active" : "duplicate";
      summary.filtered[reason] = (summary.filtered[reason] ?? 0) + 1;
      return;
    }
    try {
      const snaps = await db
        .prepare("SELECT id, symbol, features FROM snapshots WHERE run_id = ? AND symbol IN (?, 'BTCUSDT')")
        .bind(scan.runId, candidate.symbol)
        .all<{ id: number; symbol: string; features: string }>();
      const own = snaps.results.find((r) => r.symbol === candidate.symbol);
      if (!own) throw new Error("немає знімка монети");
      const btcRow = snaps.results.find((r) => r.symbol === "BTCUSDT");
      const playbook = await this.playbook();
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
      const toMacro = minutesToMacro(macro, now);
      const user = JSON.stringify(
        reviewInput({
          candidate,
          rule: playbook.rules[candidate.setup] ?? PLAYBOOK_V1[candidate.setup],
          snapshot: JSON.parse(own.features) as Snapshot,
          btc: btcRow ? (JSON.parse(btcRow.features) as Snapshot) : null,
          market: scan.market,
          news: news.filter((n) => n.symbols.includes(candidate.symbol) || n.symbols.includes("MARKET")).slice(0, 6),
          minutesToMacro: toMacro,
        }),
      );
      const stopReviews = () => {
        summary.notes.push("стелю витрат вичерпано: нові сигнали не публікуються");
        state.steps = state.steps.filter((s) => !s.startsWith("review:"));
      };
      const first = await this.llm("analyst", { user, system: ANALYST_SYSTEM, schema: ANALYST_SCHEMA });
      if (!first) return stopReviews();
      summary.reviewed++;
      const analyst = sanitizeAnalyst(first.data);
      // Скептик працює окремим викликом і не бачить відповіді аналітика.
      let skeptic: SkepticView | null = null;
      if (analyst.verdict === "take") {
        const second = await this.llm("skeptic", { user, system: SKEPTIC_SYSTEM, schema: SKEPTIC_SCHEMA });
        if (!second) return stopReviews();
        skeptic = sanitizeSkeptic(second.data);
      }
      const decision = decide(analyst, skeptic, threshold);
      const reasoning: Reasoning = { v: 1, facts: candidate.facts, analyst, skeptic, rejectedBy: decision.publish ? null : decision.by };
      const createdAt = new Date(now).toISOString();
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
          JSON.stringify(reasoning), own.id, playbook.version,
        )
        .first<{ id: number }>();
      if (!decision.publish) {
        summary.rejected++;
        return;
      }
      summary.published++;
      await this.signalPush(row!.id, await this.signalMessage(row!.id, candidate), now);
    } catch (e) {
      summary.notes.push(`${candidate.symbol} ${candidate.setup}: ${String(e)}`);
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

  // ── Тижневий розбір ──────────────────────────────────────────────────────

  /**
   * У неділю рахує статистику тижня й просить агента «Тижневий розбір» пояснити її.
   * Якщо стеля витрат не дозволяє або виклик не вдався, звіт виходить зі статистикою без розбору моделі.
   */
  private async runWeekly(now: number, force = false): Promise<{ status: "saved" | "exists" | "not_due"; id?: number }> {
    const db = this.env.DB;
    const timezone = await this.setting("timezone", "Europe/Kyiv");
    const due = force ? { date: localTime(now, timezone).date } : dueWeekly(now, timezone, await this.setting("weekly_review_time", "12:00"));
    if (!due) return { status: "not_due" };
    if (await this.reportExists("weekly", due.date)) return { status: "exists" };

    const started = Date.now();
    const [week, allTime] = await Promise.all([
      loadStats(db, { from: new Date(now - 7 * 24 * HOUR).toISOString(), now }),
      loadStats(db, { from: null, now }),
    ]);
    const stats = { week, allTime };

    const playbook = await this.playbook();
    const notes = await db
      .prepare("SELECT ts, action, note FROM journal WHERE ts >= ? AND note IS NOT NULL ORDER BY id DESC LIMIT 20")
      .bind(new Date(now - 7 * 24 * HOUR).toISOString())
      .all<{ ts: string; action: string | null; note: string }>();
    const settings = Object.fromEntries(
      await Promise.all(
        ["min_rr", "min_stop_pct", "skeptic_threshold", "max_active_signals", "signal_ttl_hours", "signal_max_hold_hours", "fee_maker_pct", "fee_taker_pct"].map(async (k) => [k, await this.setting<unknown>(k, null)] as const),
      ),
    );
    const input = weeklyInput({ week, allTime, playbook: { version: playbook.version, rules: playbook.rules as Record<string, string> }, settings, notes: notes.results.map((n) => ({ ...n, note: n.note.slice(0, 300) })) });
    let review: WeeklyReview | null = null;
    let note: string | null = null;
    let llm: { model: string; cost: number } | null = null;
    try {
      const res = await this.llm("weekly_review", { system: WEEKLY_SYSTEM, user: JSON.stringify(input), schema: WEEKLY_SCHEMA });
      if (!res) note = "стеля витрат вичерпана: розбір моделі пропущено";
      else {
        llm = { model: res.model, cost: res.costUsd };
        review = sanitizeWeekly(res.data);
      }
    } catch (e) {
      note = `розбір моделі не вдався: ${e instanceof Error ? e.message : String(e)}`;
    }
    return { status: "saved", id: await this.saveWeekly(due.date, stats, review, note, started, llm) };
  }

  /** Тижневий розбір поза розкладом: за сьогоднішньою місцевою датою. */
  async weeklyNow(): Promise<{ status: string; id?: number; error?: string } | null> {
    if (await this.busy()) return null;
    try {
      return await this.runWeekly(Date.now(), true);
    } catch (e) {
      return { status: "error", error: String(e) };
    }
  }

  private async saveWeekly(
    date: string,
    stats: { week: Awaited<ReturnType<typeof loadStats>>; allTime: Awaited<ReturnType<typeof loadStats>> },
    review: WeeklyReview | null,
    note: string | null,
    started: number,
    llm: { model: string; cost: number } | null = null,
  ): Promise<number | undefined> {
    if (await this.reportExists("weekly", date)) return undefined;
    const body = weeklyBody(stats.week, stats.allTime, review, note);
    const row = await this.env.DB.prepare("INSERT INTO reports (kind, date, body, model, cost_usd, created_at) VALUES ('weekly', ?, ?, ?, ?, ?) RETURNING id")
      .bind(date, JSON.stringify(body), llm?.model ?? null, llm?.cost ?? null, new Date().toISOString())
      .first<{ id: number }>();
    await this.logRun("weekly_review", started, { id: row!.id, date, review: review !== null, note }, null);
    await this.push({ title: "Тижневий розбір готовий", body: body.content.headline, url: `/?report=${row!.id}`, tag: `report-${row!.id}` });
    return row!.id;
  }

  // ── Прибирання ───────────────────────────────────────────────────────────

  /**
   * Раз на добу видаляє старі знімки (крім тих, на які посилаються сигнали), новини і журнал запусків.
   * Видаляє порціями, щоб не впертися в ліміти D1.
   */
  private async cleanup(now: number): Promise<void> {
    const db = this.env.DB;
    const last = await db.prepare("SELECT started_at FROM runs WHERE kind = 'cleanup' ORDER BY id DESC LIMIT 1").first<{ started_at: string }>();
    if (last && now - Date.parse(last.started_at) < 20 * HOUR) return;
    const started = Date.now();
    const days = await this.setting("retention_days", 30);
    const cutoff = new Date(now - days * 24 * HOUR).toISOString();
    const runsCutoff = new Date(now - Math.max(days, 90) * 24 * HOUR).toISOString();
    const [snapshots, news, runs] = await db.batch<never>([
      db
        .prepare(
          `DELETE FROM snapshots WHERE id IN (
             SELECT s.id FROM snapshots s JOIN runs r ON r.id = s.run_id
             WHERE r.started_at < ? AND s.id NOT IN (SELECT snapshot_id FROM signals WHERE snapshot_id IS NOT NULL)
             LIMIT 20000)`,
        )
        .bind(cutoff),
      db.prepare("DELETE FROM news WHERE id IN (SELECT id FROM news WHERE ts < ? LIMIT 20000)").bind(cutoff),
      db
        .prepare(
          `DELETE FROM runs WHERE id IN (
             SELECT id FROM runs WHERE started_at < ? AND kind IN ('scan', 'news', 'signals', 'probe', 'pipeline')
               AND id NOT IN (SELECT run_id FROM snapshots) LIMIT 20000)`,
        )
        .bind(runsCutoff),
    ]);
    await this.logRun("cleanup", started, { retentionDays: days, snapshots: snapshots!.meta.changes, news: news!.meta.changes, runs: runs!.meta.changes }, null);
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
      this.http,
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
