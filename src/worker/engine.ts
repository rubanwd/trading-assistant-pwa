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
import { BOT_IDS, botEnabledKey, botInfo, carryConfig, channelConfig, isTubeBot, SPOT_TAKER_PCT, TUBE_BOT_IDS, TUBE_FALLBACK, tubeConfig, type ChannelConfig, type TubeBotId, type TubeConfig } from "../shared/bots";
import { carryLegCost, carryNetPct, DAY_MS as CARRY_DAY, fundingApr, planCarry, spotBase, type FundingEvent } from "./bots/carry";
import {
  advanceChannel,
  channelFeeR,
  channelFunding,
  channelR,
  channelSignal,
  channelStop,
  fillChannel,
  nextLevels,
  openTrack,
  type ChannelExit,
  type ChannelFunding,
  type ChannelSignal,
  type ChannelTrack,
} from "./bots/channel";
import { planCycle, resolveTube, TUBE_H1_LIMIT, TUBE_H4_LIMIT, tubeFeatures, tubeFeeR, type CyclePlan, type TubeFeatures, type TubeStatus } from "./bots/tube";
import { marketCaps, topUniverse } from "./bots/universe";
import { atr } from "./indicators";
import { choosePick, PICK_MIN_RSI_1H, PICK_SCHEMA, PICK_SYSTEM, pickInput, rankPicks, resolvePick, sanitizePick, shortMarket, type PickAi, type PickOption, type PickStyle, type ShortMarket } from "./pick";
import { loadStats } from "./stats";
import { sanitizeWeekly, WEEKLY_SCHEMA, WEEKLY_SYSTEM, weeklyBody, weeklyInput, type WeeklyReview } from "./weekly";
import { BinanceFutures } from "./market/binance";
import { BybitLinear } from "./market/bybit";
import { FailoverMarket } from "./market/failover";
import type { Candle, MarketData } from "./market/types";
import { newsHash, parseFeed } from "./news/rss";
import { categoriesFor, sanitizeTriage, triageSchema, triageSystem, triageUser, type TriageInput } from "./news/triage";
import { CRYPTO_LEADER, DESK_LABEL, deskKey, parseDesk, STOCKS_LEADER_DEFAULT, usSessionOpen, usTradingDay, type Desk } from "../shared/desk";
import { forDesk } from "./desk";
import { parseSubscription, sendPush, type PushMessage, type PushOutcome, type StoredSubscription } from "./push";
import type { MarketRegime } from "./regime";
import { reportInput, type NewsField, type PriorForecast } from "./report/input";
import { reportSchema, reportSystem, sanitizeReport, type ReportContent } from "./report/schema";
import { CANDLE_LIMIT, CHUNK_SIZE, marketFromSnapshots, scanChunk, type ChunkResult } from "./scan";
import { CachedMarket, SqlCandleStorage } from "./market/cache";
import { feeR, positionSize, stopDistancePct, type Fees } from "../shared/risk";
import { detect, EXIT_BARS } from "./signals/detectors";
import { candidateKey, minutesToMacro, reject, shortlist, type Rejection } from "./signals/filter";
import {
  ANALYST_SCHEMA,
  ANALYST_SYSTEM,
  decide,
  PLAYBOOK_DEFAULT,
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
import { timeframeFeatures, type Snapshot } from "./snapshot";
import { clock, dueReports, dueWeekly, inQuietHours, localTime, type ReportKind, type ReportTimes } from "./time";

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

/** Стан одного режиму (крипто або акції) у циклі. */
interface DeskState {
  /** Список інструментів на момент планування: усі кроки скану працюють з тим самим списком. */
  symbols: string[];
  /** Орієнтир ринку: BTCUSDT для крипто, ETF індексу для акцій. */
  leader: string;
  scan?: { runId: number; market: MarketRegime };
  candidates?: Candidate[];
  signals?: SignalsSummary;
}

/** Стан циклу між кроками. Лежить у сховищі Durable Object, тож переживає перезапуск рушія. */
interface PipelineState {
  startedAt: number;
  desks: Partial<Record<Desk, DeskState>>;
  /**
   * Черга кроків. Раз на годину першими йдуть кроки ботів: bot:universe, bot:data:N (спільні), bot:<id>:run.
   * Для кожного режиму: scan:<desk>:N, scan:<desk>:done, news:<desk>, signals:<desk>, review:<desk>:N, pick:<desk>;
   * потім forecasts, reports:<desk>, weekly:<desk>, cleanup.
   */
  steps: string[];
  log: { step: string; ms: number; requests: number; error?: string }[];
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
  /** Фон ринку крипто; null у звітах по акціях. */
  context: Awaited<ReturnType<typeof marketContext>>["context"] | null;
  /** Запуск скану, зі знімків якого складено звіт. */
  snapshotRunId: number;
  /** Новини, поля яких бачила модель. */
  newsIds: number[];
  /** Прогнози попереднього звіту з результатами на момент складання. */
  prior: PriorForecast[];
}

/** Тіло ідеї скану в picks.body. */
export interface PickBody {
  v: 1;
  /** З чого склався бал вибраного варіанта. */
  factors: PickOption["factors"];
  roomAtr: number | null;
  /** Усі варіанти, які бачила модель, від найвищого балу. */
  options: PickOption[];
  ai: PickAi | null;
  /** Чому модель не відповіла. */
  note: string | null;
  market: MarketRegime;
  /** Стиль балу і ринок «зараз»; у старих ідеях полів немає (тоді це swing). */
  style?: PickStyle;
  /** Поріг фільтра імпульсу на момент ідеї; 0 — вимкнено, у старих ідеях поля немає. */
  minRsi1h?: number;
  marketNow?: ShortMarket | null;
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
  tp1: number | null;
  tp2: number | null;
  rr: number | null;
  status: SignalStatus;
  expires_at: string;
  hit: 0 | 1 | null;
}

const HOUR = 3_600_000;
const SIDE_NAME = { long: "лонг", short: "шорт" } as const;

const BOT_CHUNK = 5;
/** Список монет ботів у сховищі рушія: спільний для всіх ботів. */
const UNIVERSE_KEY = "bot-universe";
/** Невиконаний ордер живе годину: до наступного циклу бота. */
const ORDER_TTL_MS = HOUR;

const feeNum = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback);
/** Комісії ботів із налаштувань. */
const botFees = (values: Record<string, unknown>): Fees => ({ makerPct: feeNum(values.fee_maker_pct, 0.02), takerPct: feeNum(values.fee_taker_pct, 0.05) });
/** Скільки денних свічок бере Channel 20/10: канали й перерахунок стопа за тривалу позицію. */
const CHANNEL_D1_LIMIT = 120;

/** Список монет ботів у сховищі рушія. */
interface BotUniverse {
  /** Коли список востаннє вдалося оновити; 0 — ще ніколи. */
  at: number;
  symbols: string[];
  source: "coingecko" | "fallback";
  error?: string;
}

interface BotPart {
  features: TubeFeatures[];
  errors: string[];
}

interface BotActiveRow {
  id: number;
  created_at: string;
  symbol: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  expires_at: string;
  max_hold_hours: number;
  status: "pending" | "open";
  filled_at: string | null;
}

/** Тіло ордера бота в bot_orders.body. */
export interface TubeOrderBody {
  v: 1;
  /** Ознаки монети в момент постановки. */
  features: TubeFeatures;
  offsetAtr: number;
  market: MarketRegime;
  cfg: Pick<TubeConfig, "entryAtr" | "biasRatio" | "biasSide" | "stopAtr" | "targetR" | "minStopPct" | "trendOnly" | "skipNeutral">;
}

/** Підсумок години бота в runs.detail (kind = 'bot'). */
export interface TubeCycleDetail {
  bot: string;
  bias: CyclePlan["bias"] | null;
  market: MarketRegime | null;
  universe: { source: string; at: string | null; size: number; error: string | null };
  ranked: Pick<TubeFeatures, "symbol" | "price" | "atrPct" | "volRatio" | "score" | "trend4h" | "change24hPct" | "ema20">[];
  chosen: string[];
  placed: number;
  skipped: CyclePlan["skipped"];
  resolved: Record<"filled" | "target" | "stop" | "timeout" | "cancelled", number>;
  open: number;
  note: string | null;
  errors: string[];
}

/** Підсумок доби Funding Carry у runs.detail (kind = 'bot'). Поля bias, chosen, placed, open — як у інших ботів. */
export interface CarryCycleDetail {
  bot: "carry";
  universe: { source: string; size: number; withSpot: number; error: string | null };
  /** Фандинг монет списку й відкритих позицій, % річних, від найвищого; spot — чи є спот на Bybit. */
  ranked: { symbol: string; apr: number | null; spot: boolean; open: boolean }[];
  entered: { symbol: string; apr: number }[];
  exited: { symbol: string; apr: number | null; reason: string; netPct: number }[];
  /** Нараховано за позиціями до цього циклу й комісії входів і виходів доби, % капіталу. */
  fundingPct: number;
  feePct: number;
  bias: null;
  chosen: string[];
  placed: number;
  open: number;
  note: string | null;
  errors: string[];
}

/** Тіло ордера Channel 20/10 у bot_orders.body: сигнал, стан супроводу, перерахунки стопа, вихід і фандинг. */
export interface ChannelOrderBody {
  v: 1;
  kind: "channel";
  signal: ChannelSignal;
  cfg: Pick<ChannelConfig, "entryDays" | "exitDays">;
  /** ATR(14) 1d у % від ціни на свічці сигналу. */
  atrPct: number | null;
  track: ChannelTrack | null;
  trailed: { day: string; stop: number }[];
  exit: ChannelExit | null;
  funding: ChannelFunding | null;
  /** Чому вхід не відбувся: beyond_stop — ціна вже за стопом, no_price — немає ціни у вікні входу. */
  skip: "beyond_stop" | "no_price" | null;
}

export type ChannelAction = "placed" | "ignored" | "expired" | "disabled" | "none";

/** Підсумок години Channel 20/10 у runs.detail (kind = 'bot'). Поля bias, chosen, placed, open — як у ботів «труби». */
export interface ChannelCycleDetail {
  bot: "c2010";
  symbol: string;
  price: number | null;
  /** Межі каналу на наступне денне закриття й стоп, яким був би вхід зараз. */
  levels: ReturnType<typeof nextLevels>;
  /** Сигнал свіжої денної свічки (лише в першу годину нової доби). */
  signal: (Omit<ChannelSignal, "day"> & { day: string; action: ChannelAction; note: string | null }) | null;
  position: { id: number; side: "long" | "short"; status: "pending" | "open"; entry: number; stop: number; initialStop: number; filledAt: string | null; r: number | null } | null;
  resolved: { filled: number; stop: number; cancelled: number };
  trailed: { day: string; stop: number }[];
  bias: null;
  chosen: string[];
  placed: number;
  open: number;
  note: string | null;
  errors: string[];
}

const coin = (symbol: string) => symbol.replace(/USDT$/, "");
const REPORT_TITLE: Record<ReportKind, string> = { morning: "Ранковий звіт готовий", evening: "Вечірній звіт готовий" };
/** Префікс сповіщень режиму акцій: крипто лишається як було. */
const deskTitle = (desk: Desk, title: string) => (desk === "crypto" ? title : `${DESK_LABEL[desk]} · ${title}`);
/** Посилання зі сповіщення відкриває застосунок у потрібному режимі. */
const deskUrl = (desk: Desk, path: string) => (desk === "crypto" ? path : `${path}&desk=${desk}`);

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
    const desks: PipelineState["desks"] = {};
    // Бот іде першим: ордери години ставляться якомога ближче до закриття свічки 1h.
    const steps: string[] = await this.botSteps(now);
    const active = await this.activeDesks();
    for (const desk of active) {
      const leader = await this.leader(desk);
      const list = await this.watchlist(desk);
      // Орієнтир акцій потрібен для настрою ринку, тож скан бере його завжди.
      const symbols = desk === "stocks" && !list.includes(leader) ? [leader, ...list] : list;
      desks[desk] = { symbols, leader };
      steps.push(
        ...Array.from({ length: Math.ceil(symbols.length / CHUNK_SIZE) }, (_, i) => `scan:${desk}:${i}`),
        `scan:${desk}:done`,
        `news:${desk}`,
        `signals:${desk}`,
        `pick:${desk}`,
      );
    }
    steps.push("forecasts", ...active.map((d) => `reports:${d}`), ...active.map((d) => `weekly:${d}`), "cleanup");
    await this.ctx.storage.put<PipelineState>(PIPELINE_KEY, { startedAt: now, desks, steps, log: [] });
    await this.ctx.storage.setAlarm(Date.now());
    return { queued: true, steps };
  }

  /** Один крок циклу на один запуск будильника. Збій кроку записується й не зупиняє наступні. */
  async alarm(): Promise<void> {
    const state = await this.pipelineState();
    if (!state) return;
    // Цикл, запланований до появи режимів: його кроки вже не зрозумілі, наступний Cron почне новий.
    if (!state.desks) return void (await this.ctx.storage.delete(PIPELINE_KEY));
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
    if (step.startsWith("bot:")) return this.runBotStep(step, now);
    const [name, deskArg, arg] = step.split(":");
    const desk = parseDesk(deskArg);
    const ds = state.desks[desk];
    switch (name) {
      case "scan":
        if (!ds) return;
        return arg === "done" ? this.finishScan(desk, ds, state.startedAt) : this.scanPart(desk, ds, Number(arg), state.startedAt);
      case "news":
        return this.runNews(now, desk);
      case "signals":
        if (!ds) return;
        return this.runSignals(state, desk, ds, now);
      case "review":
        if (!ds) return;
        return this.reviewCandidate(state, desk, ds, Number(arg), now);
      case "pick":
        if (!ds) return;
        return this.runPick(desk, ds, now);
      case "forecasts":
        return this.resolveForecasts(now);
      case "reports":
        for (const due of await this.dueReports(now, desk)) await this.runReport(desk, due.kind, due.date);
        return;
      case "weekly":
        await this.runWeekly(now, desk);
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
    for (const [desk, ds] of Object.entries(state.desks)) {
      if (!ds?.signals) continue;
      statements.push(
        db
          .prepare("INSERT INTO runs (kind, desk, started_at, status, duration_ms, candidates, detail, error) VALUES ('signals', ?, ?, 'ok', ?, ?, ?, NULL)")
          .bind(desk, new Date(state.startedAt).toISOString(), Date.now() - state.startedAt, ds.signals.reviewed, JSON.stringify(ds.signals)),
      );
    }
    await db.batch(statements);
  }

  /** Ручний запуск звіту з API. null, якщо рушій зайнятий; помилка, якщо звіт за цю дату вже є. */
  async reportNow(kind: ReportKind, desk: Desk = "crypto"): Promise<ReportSummary | { error: string } | null> {
    if (await this.busy()) return null;
    try {
      const now = Date.now();
      if (desk === "stocks" && !(await this.deskEnabled("stocks"))) return { error: "режим акцій вимкнено в налаштуваннях" };
      const date = localTime(now, await this.setting("timezone", "Europe/Kyiv")).date;
      if (await this.reportExists(desk, kind, date)) return { error: "звіт за цю дату вже є" };
      await this.runNews(now, desk).catch((e) => console.error("крок news:", e));
      await this.resolveForecasts(now).catch((e) => console.error("крок forecasts:", e));
      return await this.runReport(desk, kind, date);
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

  private marketCache = new Map<Desk, { source: string; market: MarketData }>();
  private candleStorage: SqlCandleStorage | null = null;

  /**
   * Джерело ринкових даних режиму. Крипто: за settings.market_source binance, bybit або auto
   * (Binance, а якщо він відмовляє за локацією, то Bybit до перезапуску рушія).
   * Акції: лише Bybit, лінійні контракти на акції та ETF США.
   * Свічки йдуть через кеш у сховищі рушія (символи акцій і монет не перетинаються): біржа докачує лише нові.
   */
  private async market(desk: Desk = "crypto"): Promise<MarketData> {
    const source = desk === "stocks" ? "bybit" : await this.setting("market_source", "auto");
    const cached = this.marketCache.get(desk);
    if (cached?.source === source) return cached.market;
    const binance = () => new BinanceFutures(this.http);
    // Повтори після відмови Bybit за частотою лише з запасом до ліміту 50 запитів на крок.
    const bybit = () => new BybitLinear(this.http, undefined, undefined, () => this.requests < 40);
    const inner = source === "binance" ? binance() : source === "bybit" ? bybit() : new FailoverMarket(binance(), bybit());
    this.candleStorage ??= new SqlCandleStorage(this.ctx.storage.sql);
    const market = new CachedMarket(inner, this.candleStorage);
    this.marketCache.set(desk, { source, market });
    return market;
  }

  private universeCache: { at: number; symbols: string[] } | null = null;

  /**
   * Контракти Bybit на акції та ETF США, що зараз торгуються. Кеш на 6 годин і в сховищі рушія:
   * два запити до біржі не частіше ніж раз на 6 годин.
   */
  async stockSymbols(): Promise<string[]> {
    this.universeCache ??= (await this.ctx.storage.get<{ at: number; symbols: string[] }>("stock-universe")) ?? null;
    if (this.universeCache && Date.now() - this.universeCache.at < 6 * HOUR) return this.universeCache.symbols;
    const bybit = new BybitLinear(this.http);
    const [stocks, etfs] = await Promise.all([bybit.instruments("stock"), bybit.instruments("ETF")]);
    const symbols = [...new Set([...stocks, ...etfs])].sort();
    if (!symbols.length) throw new Error("Bybit не повернув жодного контракту на акції");
    this.universeCache = { at: Date.now(), symbols };
    await this.ctx.storage.put("stock-universe", this.universeCache);
    return symbols;
  }

  /** Частина скану: кілька інструментів, результат чекає в сховищі рушія на крок scan:<desk>:done. */
  private async scanPart(desk: Desk, ds: DeskState, index: number, startedAt: number): Promise<void> {
    let symbols = ds.symbols.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
    let missing: string[] = [];
    if (desk === "stocks") {
      // Символ без контракту на Bybit не запитуємо: інакше біржа відповідає помилкою на кожну свічку.
      // Це помилка в налаштуваннях, а не збій скану: такий символ іде в попередження, а не в помилки.
      const universe = await this.stockSymbols().catch(() => null);
      if (universe) {
        const known = new Set(universe);
        missing = symbols.filter((s) => !known.has(s));
        symbols = symbols.filter((s) => known.has(s));
      }
    }
    const part: ChunkResult & { missing: string[] } = { ...(await scanChunk(await this.market(desk), symbols, startedAt)), missing };
    await this.ctx.storage.put(`scan-part:${desk}:${index}`, part);
  }

  /** Збирає частини скану: режим ринку, запис запуску й знімків у базу, денні ціни. */
  private async finishScan(desk: Desk, ds: DeskState, startedAt: number): Promise<void> {
    const db = this.env.DB;
    const keys = Array.from({ length: Math.ceil(ds.symbols.length / CHUNK_SIZE) }, (_, i) => `scan-part:${desk}:${i}`);
    const parts = await this.ctx.storage.get<ChunkResult & { missing?: string[] }>(keys);
    const snapshots: Snapshot[] = [];
    const errors: ChunkResult["errors"] = [];
    /** Символи зі списку, яких немає на біржі: попередження, скан через них не вважається невдалим. */
    const missing: string[] = [];
    for (const key of keys) {
      const part = parts.get(key);
      if (!part) {
        errors.push({ symbol: null, message: `частина скану ${key.split(":")[2]} не виконалась` });
        continue;
      }
      snapshots.push(...part.snapshots);
      missing.push(...(part.missing ?? []));
      // Збій фандингу повторюється в кожній частині: лишаємо один запис.
      for (const e of part.errors) if (e.symbol !== null || !errors.some((x) => x.message === e.message)) errors.push(e);
    }
    const market = marketFromSnapshots(snapshots, ds.leader);
    const source = (await this.market(desk)).name;
    const scanned = ds.symbols.length - missing.length;
    const failed = scanned <= 0 || snapshots.length < scanned;
    // symbols — скільки інструментів справді сканували; пропущені без контракту окремо в missing.
    const summary = { source, market, leader: ds.leader, symbols: scanned, snapshots: snapshots.length, errors, missing };
    const run = await db
      .prepare("INSERT INTO runs (kind, desk, started_at, status, duration_ms, detail, error) VALUES ('scan', ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(
        desk,
        new Date(startedAt).toISOString(),
        failed ? "error" : "ok",
        Date.now() - startedAt,
        JSON.stringify(summary),
        failed
          ? errors.map((e) => (e.symbol ? `${e.symbol}: ${e.message}` : e.message)).join("; ").slice(0, 2000) ||
              (missing.length ? `жодного символу зі списку немає на біржі: ${missing.join(", ")}` : "порожній список монет")
          : null,
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
    ds.scan = { runId, market };
    await this.recordDailyPrices(desk, snapshots.map((s) => s.symbol)).catch((e) => console.error("денні ціни:", e));
  }

  /**
   * Денні закриття для порівняння з утриманням BTC. Щоразу пишемо останню закриту денну свічку;
   * якщо таблиця порожня, заповнюємо 120 днів історії. Свічки беруться з кешу, біржу не питаємо.
   */
  private async recordDailyPrices(desk: Desk, symbols: string[]): Promise<void> {
    const db = this.env.DB;
    // Історію заповнюємо, коли для орієнтира режиму ще немає жодного рядка: так і акції отримують свої 120 днів.
    const leader = await this.leader(desk);
    const empty = (await db.prepare("SELECT 1 AS x FROM prices_daily WHERE symbol = ? LIMIT 1").bind(leader).first()) === null;
    const market = await this.market(desk);
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

  private async watchlist(desk: Desk = "crypto"): Promise<string[]> {
    const key = deskKey(desk, "watchlist");
    const list = await this.setting<unknown>(key, []);
    if (!Array.isArray(list)) throw new Error(`settings.${key} має бути масивом`);
    return list.filter((s): s is string => typeof s === "string" && /^[A-Z0-9]{2,20}$/.test(s));
  }

  /** Орієнтир ринку режиму: BTC для крипто, налаштування stocks_benchmark для акцій. */
  private async leader(desk: Desk): Promise<string> {
    if (desk === "crypto") return CRYPTO_LEADER;
    const s = await this.setting<unknown>("stocks_benchmark", STOCKS_LEADER_DEFAULT);
    return typeof s === "string" && /^[A-Z0-9]{2,20}USDT$/.test(s) ? s : STOCKS_LEADER_DEFAULT;
  }

  private async deskEnabled(desk: Desk): Promise<boolean> {
    return desk === "crypto" || (await this.setting("stocks_enabled", "on")) !== "off";
  }

  /** Режими, які працюють у циклі: крипто завжди, акції — якщо не вимкнені. */
  private async activeDesks(): Promise<Desk[]> {
    return (await this.deskEnabled("stocks")) ? ["crypto", "stocks"] : ["crypto"];
  }

  /** Свічки для графіка в застосунку: з кешу рушія, біржа докачує лише нові. */
  async candles(symbol: string, timeframe: "15m" | "1h" | "4h" | "1d", limit: number, desk: Desk = "crypto"): Promise<Candle[]> {
    if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new Error("невідомий символ");
    const n = Math.min(Math.max(Math.trunc(limit) || 96, 10), 300);
    return (await (await this.market(desk)).candles(symbol, timeframe, n)).slice(-n);
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

  private async logRun(kind: string, started: number, detail: unknown, error: string | null, desk: Desk | null = null): Promise<void> {
    await this.env.DB.prepare(
      "INSERT INTO runs (kind, desk, started_at, status, duration_ms, detail, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(kind, desk, new Date(started).toISOString(), error ? "error" : "ok", Date.now() - started, JSON.stringify(detail), error?.slice(0, 2000) ?? null)
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
  private async runNews(now: number, desk: Desk = "crypto"): Promise<void> {
    const started = Date.now();
    const errors: string[] = [];
    const feeds = (await this.setting<{ source: string; url: string }[]>(deskKey(desk, "news_feeds"), [])).filter(
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
            "INSERT OR IGNORE INTO news (desk, ts, source, url, title, hash) VALUES (?, ?, ?, ?, ?, ?)",
          );
          const results = await this.env.DB.batch(
            await Promise.all(
              items.map(async (i) =>
                insert.bind(desk, new Date(i.ts ?? now).toISOString(), feed.source.slice(0, 40), i.url, i.title, await newsHash(i.url)),
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
        "SELECT id, source, title FROM news WHERE desk = ? AND relevance IS NULL AND ts >= ? ORDER BY ts DESC LIMIT 40",
      )
        .bind(desk, new Date(now - 24 * HOUR).toISOString())
        .all<TriageInput>();
      if (pending.results.length) {
        const leader = await this.leader(desk);
        const list = await this.watchlist(desk);
        const symbols = desk === "stocks" && !list.includes(leader) ? [leader, ...list] : list;
        const categories = categoriesFor(desk);
        const res = await this.llm("news", {
          system: triageSystem(desk),
          user: triageUser(pending.results),
          schema: triageSchema(symbols, categories),
        });
        if (!res) skipped = "стелю витрат вичерпано";
        else {
          const rows = sanitizeTriage(res.data, pending.results, symbols, categories);
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
    await this.logRun("news", started, { feeds: feeds.length, added, triaged, skipped, errors }, errors.length ? errors.join("; ") : null, desk);
    if (errors.length && !added && !triaged) throw new Error(errors.join("; "));
  }

  // ── Прогнози ─────────────────────────────────────────────────────────────

  /** Закриває прогнози, чий термін настав: результат рахує код за свічками 1h. */
  private async resolveForecasts(now: number): Promise<void> {
    const due = await this.env.DB.prepare(
      "SELECT id, desk, rule, resolve_at FROM forecasts WHERE outcome IS NULL AND resolve_at <= ? ORDER BY resolve_at LIMIT 30",
    )
      .bind(new Date(now).toISOString())
      .all<{ id: number; desk: string; rule: string; resolve_at: string }>();
    if (!due.results.length) return;
    // Свічки беремо з джерела того режиму, до якого належить прогноз.
    const bySymbol = new Map<string, { desk: Desk; list: { id: number; rule: ForecastRule; resolveAt: number }[] }>();
    for (const row of due.results) {
      try {
        const rule = JSON.parse(row.rule) as ForecastRule;
        const desk = parseDesk(row.desk);
        const key = `${desk}:${rule.symbol}`;
        const group = bySymbol.get(key) ?? { desk, list: [] };
        group.list.push({ id: row.id, rule, resolveAt: Date.parse(row.resolve_at) });
        bySymbol.set(key, group);
      } catch {
        // Зіпсоване правило лишається відкритим і видимим у статистиці.
      }
    }
    const update = this.env.DB.prepare("UPDATE forecasts SET outcome = ?, resolved_at = ? WHERE id = ? AND outcome IS NULL");
    for (const { desk, list } of bySymbol.values()) {
      const symbol = list[0]!.rule.symbol;
      const market = await this.market(desk);
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

  private async reportExists(desk: Desk, kind: ReportKind | "weekly", date: string): Promise<boolean> {
    return (await this.env.DB.prepare("SELECT 1 AS x FROM reports WHERE desk = ? AND kind = ? AND date = ?").bind(desk, kind, date).first()) !== null;
  }

  /**
   * Звіти, час яких настав за місцевим часом і яких ще немає в базі.
   * Звіти по акціях — лише в торгові дні США: у вихідні ринок стоїть і писати немає про що.
   */
  private async dueReports(now: number, desk: Desk = "crypto"): Promise<{ kind: ReportKind; date: string }[]> {
    if (desk === "stocks" && !usTradingDay(now)) return [];
    const timezone = await this.setting("timezone", "Europe/Kyiv");
    const fallback = desk === "crypto" ? { morning: "07:30", evening: "20:30" } : { morning: "16:00", evening: "23:15" };
    const times = await this.setting<ReportTimes>(deskKey(desk, "report_times"), fallback);
    const out: { kind: ReportKind; date: string }[] = [];
    for (const due of dueReports(now, timezone, times)) {
      if (!(await this.reportExists(desk, due.kind, due.date))) out.push(due);
    }
    return out;
  }

  private async runReport(desk: Desk, kind: ReportKind, date: string): Promise<ReportSummary> {
    const started = Date.now();
    try {
      const summary = await this.buildReport(desk, kind, date, started);
      await this.logRun(`${kind}_report`, started, summary, null, desk);
      return summary;
    } catch (e) {
      await this.logRun(`${kind}_report`, started, null, String(e), desk);
      throw e;
    }
  }

  private async buildReport(desk: Desk, kind: ReportKind, date: string, now: number): Promise<ReportSummary> {
    const db = this.env.DB;
    const timezone = await this.setting("timezone", "Europe/Kyiv");
    const leader = await this.leader(desk);

    // 1. Знімки останнього скану: звіт не складається зі застарілих даних.
    const scanRun = await db
      .prepare("SELECT id, detail FROM runs WHERE kind = 'scan' AND desk = ? AND started_at >= ? ORDER BY id DESC LIMIT 1")
      .bind(desk, new Date(now - 1.5 * HOUR).toISOString())
      .first<{ id: number; detail: string | null }>();
    const rows = scanRun
      ? await db.prepare("SELECT features FROM snapshots WHERE run_id = ? ORDER BY id").bind(scanRun.id).all<{ features: string }>()
      : null;
    const snapshots = (rows?.results ?? []).map((r) => JSON.parse(r.features) as Snapshot);
    if (!scanRun || !snapshots.length) throw new Error("немає свіжих знімків ринку: останній скан не вдався");
    const market = (JSON.parse(scanRun.detail ?? "{}") as { market: MarketRegime }).market;

    // 2. Фон ринку крипто (домінація BTC, страх і жадібність). Збій джерела не зупиняє звіт; для акцій його немає.
    const { context, errors: warnings } =
      desk === "crypto" ? await marketContext(this.http, this.env.COINGECKO_API_KEY) : { context: null, errors: [] as string[] };

    // 3. Новини за 12 годин: до 8 найважливіших, лише поля сортувальника.
    const newsRows = await db
      .prepare(
        "SELECT id, ts, category, impact, sentiment, symbols, relevance FROM news WHERE desk = ? AND ts >= ? AND relevance >= 0.4 ORDER BY relevance DESC, ts DESC LIMIT 8",
      )
      .bind(desk, new Date(now - 12 * HOUR).toISOString())
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
      .prepare("SELECT id FROM reports WHERE desk = ? AND kind IN ('morning', 'evening') AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
      // Між звітами по акціях бувають вихідні: попередній шукаємо глибше.
      .bind(desk, new Date(now - (desk === "stocks" ? 96 : 36) * HOUR).toISOString())
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
      .prepare("SELECT symbol, side, setup, status FROM signals WHERE desk = ? AND status IN ('pending', 'active') ORDER BY id")
      .bind(desk)
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
      system: forDesk(reportSystem(kind, desk), desk, leader),
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
      .prepare("INSERT INTO reports (desk, kind, date, body, model, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .bind(desk, kind, date, JSON.stringify(body), res.model, res.costUsd, new Date(now).toISOString())
      .first<{ id: number }>();
    const id = inserted!.id;

    // Кожна ймовірність стає рядком у forecasts із правилом перевірки.
    const insertForecast = db.prepare(
      "INSERT INTO forecasts (desk, source, statement, probability, resolve_at, rule) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const forecasts = content.scenarios.flatMap((s) =>
      s.rule && s.statement && s.resolveAt
        ? [insertForecast.bind(desk, `report:${id}`, s.statement, s.probability, s.resolveAt, JSON.stringify(s.rule))]
        : [],
    );
    if (forecasts.length) await db.batch(forecasts);

    const push = await this.push({ title: deskTitle(desk, REPORT_TITLE[kind]), body: content.headline, url: deskUrl(desk, `/?report=${id}`), tag: `report-${id}` });
    return { id, kind, date, model: res.model, costUsd: res.costUsd, forecasts: forecasts.length, push, warnings };
  }

  // ── Сигнали ──────────────────────────────────────────────────────────────

  /**
   * Супровід відкритих сигналів, потім пошук нових сетапів на свіжій свічці 4h.
   * Кандидати, що пройшли фільтр, стають окремими кроками review: так виклики моделей
   * не збираються в один запуск і не впираються в його ліміти.
   */
  private async runSignals(state: PipelineState, desk: Desk, ds: DeskState, now: number): Promise<void> {
    const summary: SignalsSummary = { updated: 0, detection: false, detected: 0, filtered: {}, reviewed: 0, published: 0, rejected: 0, notes: [] };
    ds.signals = summary;
    summary.updated = await this.trackSignals(now, desk, ds);
    if (!ds.scan) {
      summary.notes.push("скан не вдався: нові сетапи не шукались");
      return;
    }
    ds.candidates = await this.findCandidates(now, desk, ds.scan, summary);
    state.steps.unshift(...ds.candidates.map((_, i) => `review:${desk}:${i}`));
  }

  /** Стоп, вихід за каналом або закриття за часом для кожного відкритого сигналу режиму. Повертає кількість змін. */
  private async trackSignals(now: number, desk: Desk, ds: DeskState): Promise<number> {
    const db = this.env.DB;
    const open = await db
      .prepare("SELECT id, created_at, symbol, side, setup, entry_low, entry_high, stop, tp1, tp2, rr, status, expires_at, hit FROM signals WHERE desk = ? AND status IN ('pending', 'active') ORDER BY id")
      .bind(desk)
      .all<SignalRow>();
    const maxHoldMs = (await this.setting("signal_max_hold_hours", 120)) * HOUR;
    const fees: Fees = { makerPct: await this.setting("fee_maker_pct", 0.02), takerPct: await this.setting("fee_taker_pct", 0.05) };
    let updated = 0;
    const market = await this.market(desk);
    for (const sig of open.results) {
      // Свічки з кешу: якщо монета в списку, скан їх щойно оновив, і біржу не питаємо.
      const [h1, h4] = await Promise.all([market.candles(sig.symbol, "1h", CANDLE_LIMIT), market.candles(sig.symbol, "4h", CANDLE_LIMIT)]);
      const res = replay({ side: sig.side, entry: sig.entry_low, stop: sig.stop, createdAt: Date.parse(sig.created_at) }, h1, h4, maxHoldMs);
      const known = await db.prepare("SELECT type FROM signal_events WHERE signal_id = ?").bind(sig.id).all<{ type: string }>();
      const have = new Set(known.results.map((e) => e.type));
      const fresh = res.events.filter((e) => !have.has(e.type));
      if (!fresh.length && res.status === sig.status && res.hit === sig.hit) continue;
      updated++;
      const insert = db.prepare("INSERT INTO signal_events (signal_id, ts, type, price) VALUES (?, ?, ?, ?)");
      await db.batch([
        ...fresh.map((e) => insert.bind(sig.id, new Date(e.ts).toISOString(), e.type, e.price)),
        db
          .prepare("UPDATE signals SET status = ?, result_r = ?, fee_r = ?, resolved_at = ?, hit = ? WHERE id = ?")
          .bind(
            res.status,
            res.resultR,
            res.resolvedAt === null ? null : feeR(res.entry, sig.stop, res.exits, fees),
            res.resolvedAt === null ? null : new Date(res.resolvedAt).toISOString(),
            res.hit,
            sig.id,
          ),
      ]);
      const name = `${coin(sig.symbol)} ${SIDE_NAME[sig.side]}`;
      const signed = (r: number | null) => (r === null ? "" : `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}R`);
      // Про вхід сповіщає сам сигнал: вхід за ринком у момент публікації.
      const text: Partial<Record<EventType, [title: string, body: string]>> = {
        stop: [`Стоп: ${name}`, `Ціна дійшла до стопа ${sig.stop}. Результат ${signed(res.resultR)}.`],
        exit: [`Вихід: ${name}`, `Свічка 4h закрилась за каналом ${EXIT_BARS} свічок: закрий позицію. Результат ${signed(res.resultR)}.`],
        timeout: [`Закрито за часом: ${name}`, `Позиція відкрита найдовший дозволений час. Результат ${signed(res.resultR)}.`],
      };
      // Якщо за один запуск сталося кілька подій, сповіщаємо лише про останню.
      const lastEvent = [...fresh].reverse().find((e) => text[e.type]);
      if (lastEvent) {
        const [title, body] = text[lastEvent.type]!;
        await this.signalPush(sig.id, { title: deskTitle(desk, title), body, url: deskUrl(desk, `/?signal=${sig.id}`), tag: `signal-${sig.id}` }, now, "position");
      }
    }
    await this.trackShadows(now, maxHoldMs, fees, desk, ds);
    return updated;
  }

  /**
   * Тіньовий супровід відхилених моделлю кандидатів: ті самі правила, але без подій і сповіщень.
   * shadow_r зберігається вже після комісій. Потрібен, щоб калібрувати оцінки й бачити, що відсіяв скептик.
   */
  private async trackShadows(now: number, maxHoldMs: number, fees: Fees, desk: Desk, ds: DeskState): Promise<void> {
    const db = this.env.DB;
    const rows = await db
      .prepare(
        `SELECT id, created_at, symbol, side, entry_low, entry_high, stop, tp1, tp2, expires_at FROM signals
         WHERE desk = ? AND status = 'rejected' AND (shadow_status IS NULL OR shadow_status IN ('pending', 'active')) AND created_at >= ?`,
      )
      .bind(desk, new Date(now - maxHoldMs - 24 * HOUR).toISOString())
      .all<SignalRow>();
    const update = db.prepare("UPDATE signals SET shadow_status = ?, shadow_r = ?, shadow_hit = ? WHERE id = ?");
    const statements: D1PreparedStatement[] = [];
    const market = await this.market(desk);
    const watched = new Set(ds.symbols);
    for (const sig of rows.results) {
      // Тінь ведемо лише для монет зі списку: їхні свічки вже в кеші, зайвих запитів до біржі немає.
      if (!watched.has(sig.symbol)) continue;
      const [h1, h4] = await Promise.all([market.candles(sig.symbol, "1h", CANDLE_LIMIT), market.candles(sig.symbol, "4h", CANDLE_LIMIT)]);
      const res = replay({ side: sig.side, entry: sig.entry_low, stop: sig.stop, createdAt: Date.parse(sig.created_at) }, h1, h4, maxHoldMs);
      const shadowR = res.resultR === null ? null : Number((res.resultR - feeR(res.entry, sig.stop, res.exits, fees)).toFixed(3));
      statements.push(update.bind(res.status, shadowR, res.hit, sig.id));
    }
    if (statements.length) await db.batch(statements);
  }

  /**
   * Детектори → фільтр. Повертає кандидатів для моделі; самі виклики аналітика і скептика
   * йдуть окремими кроками review, по одному кандидату на запуск.
   */
  private async findCandidates(now: number, desk: Desk, scan: { runId: number; market: MarketRegime }, summary: SignalsSummary): Promise<Candidate[]> {
    const db = this.env.DB;
    const rows = await db.prepare("SELECT features FROM snapshots WHERE run_id = ?").bind(scan.runId).all<{ features: string }>();
    const snapshots = rows.results.map((r) => JSON.parse(r.features) as Snapshot);
    // Сетап шукаємо лише на свічці 4h, що закрилась щойно: наступні скани до закриття нової свічки його не шукають.
    const fresh = snapshots.filter((s) => now - Date.parse(s.tf["4h"].closedAt) <= 20 * 60_000);
    // Акції: вхід за ринком має сенс лише в основну сесію, поза нею контракт малоліквідний і ціна стоїть.
    if (fresh.length && desk === "stocks" && !usSessionOpen(now)) {
      summary.notes.push("фондовий ринок США закритий: нові сетапи не шукались");
      return [];
    }
    summary.detection = fresh.length > 0;
    if (!fresh.length) return [];

    const [minStopPct, maxActive, blackout, macro, cooldown, perScan] = await Promise.all([
      this.setting("min_stop_pct", 1),
      this.setting("max_active_signals", 10),
      this.setting("macro_blackout_hours", 2),
      this.setting<unknown>("macro_events", []),
      this.setting("signal_cooldown_hours", 6),
      this.setting("max_candidates_per_scan", 5),
    ]);
    // Ліміт відкритих сигналів рахується окремо для кожного режиму.
    const [open, recent] = await Promise.all([
      db.prepare("SELECT symbol FROM signals WHERE desk = ? AND status IN ('pending', 'active')").bind(desk).all<{ symbol: string }>(),
      db
        .prepare("SELECT symbol, setup, side FROM signals WHERE desk = ? AND created_at >= ?")
        .bind(desk, new Date(now - cooldown * HOUR).toISOString())
        .all<Pick<Candidate, "symbol" | "setup" | "side">>(),
    ]);
    const openSymbols = new Set(open.results.map((r) => r.symbol));
    const recentKeys = new Set(recent.results.map(candidateKey));
    const toMacro = minutesToMacro(macro, now);
    const market = await this.market(desk);

    const passed: Candidate[] = [];
    for (const snap of fresh) {
      // Свічки з кешу: скан щойно їх оновив, біржу не питаємо.
      const h4 = await market.candles(snap.symbol, "4h", CANDLE_LIMIT);
      for (const candidate of detect(snap.symbol, h4)) {
        summary.detected++;
        const reason = reject(candidate, {
          minStopPct,
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
    // Один кандидат на монету, спершу найсильніші пробої; до моделі йде обмежена кількість за скан. Так само рахує бектест.
    return shortlist(passed, perScan);
  }

  /** Аналітик → скептик → публікація для одного кандидата. Окремий крок циклу. */
  private async reviewCandidate(state: PipelineState, desk: Desk, ds: DeskState, index: number, now: number): Promise<void> {
    const candidate = ds.candidates?.[index];
    const summary = ds.signals;
    const scan = ds.scan;
    if (!candidate || !summary || !scan) return;
    const db = this.env.DB;
    const [maxActive, macro, threshold, maxHold] = await Promise.all([
      this.setting("max_active_signals", 10),
      this.setting<unknown>("macro_events", []),
      this.setting("skeptic_threshold", 0.45),
      this.setting("signal_max_hold_hours", 120),
    ]);
    // Попередні кроки могли вже опублікувати сигнали: ліміт перевіряється заново.
    const open = await db.prepare("SELECT symbol FROM signals WHERE desk = ? AND status IN ('pending', 'active')").bind(desk).all<{ symbol: string }>();
    if (open.results.length >= maxActive || open.results.some((r) => r.symbol === candidate.symbol)) {
      const reason: Rejection = open.results.length >= maxActive ? "max_active" : "duplicate";
      summary.filtered[reason] = (summary.filtered[reason] ?? 0) + 1;
      return;
    }
    try {
      const snaps = await db
        .prepare("SELECT id, symbol, features FROM snapshots WHERE run_id = ? AND symbol IN (?, ?)")
        .bind(scan.runId, candidate.symbol, ds.leader)
        .all<{ id: number; symbol: string; features: string }>();
      const own = snaps.results.find((r) => r.symbol === candidate.symbol);
      if (!own) throw new Error("немає знімка інструмента");
      const btcRow = snaps.results.find((r) => r.symbol === ds.leader);
      const playbook = await this.playbook();
      const newsRows = await db
        .prepare("SELECT ts, category, impact, sentiment, symbols, relevance FROM news WHERE desk = ? AND ts >= ? AND relevance >= 0.4 ORDER BY relevance DESC, ts DESC LIMIT 30")
        .bind(desk, new Date(now - 12 * HOUR).toISOString())
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
          rule: playbook.rules[candidate.setup] ?? PLAYBOOK_DEFAULT[candidate.setup],
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
      const first = await this.llm("analyst", { user, system: forDesk(ANALYST_SYSTEM, desk, ds.leader), schema: ANALYST_SCHEMA });
      if (!first) return stopReviews();
      summary.reviewed++;
      const analyst = sanitizeAnalyst(first.data);
      // Скептик працює окремим викликом і не бачить відповіді аналітика.
      let skeptic: SkepticView | null = null;
      if (analyst.verdict === "take") {
        const second = await this.llm("skeptic", { user, system: forDesk(SKEPTIC_SYSTEM, desk, ds.leader), schema: SKEPTIC_SCHEMA });
        if (!second) return stopReviews();
        skeptic = sanitizeSkeptic(second.data);
      }
      const decision = decide(analyst, skeptic, threshold);
      const reasoning: Reasoning = { v: 1, facts: candidate.facts, analyst, skeptic, rejectedBy: decision.publish ? null : decision.by };
      const createdAt = new Date(now).toISOString();
      const row = await db
        .prepare(
          `INSERT INTO signals (desk, created_at, symbol, side, setup, entry_low, entry_high, stop, tp1, tp2, rr, p_analyst, p_skeptic,
             status, expires_at, resolved_at, reasoning, snapshot_id, playbook_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(
          desk, createdAt, candidate.symbol, candidate.side, candidate.setup, candidate.entry, candidate.entry, candidate.stop,
          null, null, null, analyst.probability, skeptic?.probability ?? null,
          decision.publish ? "active" : "rejected", new Date(now + maxHold * HOUR).toISOString(), decision.publish ? null : createdAt,
          JSON.stringify(reasoning), own.id, playbook.version,
        )
        .first<{ id: number }>();
      if (!decision.publish) {
        summary.rejected++;
        return;
      }
      summary.published++;
      await this.signalPush(row!.id, await this.signalMessage(row!.id, candidate, desk), now);
    } catch (e) {
      summary.notes.push(`${candidate.symbol} ${candidate.setup}: ${String(e)}`);
    }
  }

  /** Текст сповіщення про новий сигнал. Розмір позиції рахує код від ризику на угоду. */
  private async signalMessage(id: number, c: Candidate, desk: Desk = "crypto"): Promise<PushMessage> {
    const [deposit, riskPct] = await Promise.all([this.setting<number | null>("deposit_usd", null), this.setting("risk_per_trade_pct", 0.5)]);
    const size = deposit ? positionSize(deposit, riskPct, c.entry, c.stop) : null;
    return {
      title: deskTitle(desk, `Сигнал: ${coin(c.symbol)} ${SIDE_NAME[c.side]}`),
      body:
        `${SETUP_NAME[c.setup]} · вхід за ринком біля ${c.entry} · стоп ${c.stop} (${stopDistancePct(c.entry, c.stop).toFixed(1)}%) · ` +
        `вихід: закриття 4h за каналом ${EXIT_BARS} свічок` +
        (size ? ` · розмір $${Math.round(size.notionalUsd)}` : ""),
      url: deskUrl(desk, `/?signal=${id}`),
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
      .bind(new Date().toISOString(), JSON.stringify(PLAYBOOK_DEFAULT))
      .first<{ version: number }>();
    return { version: created!.version, rules: PLAYBOOK_DEFAULT };
  }

  /**
   * Сповіщення про сигнал.
   * - kind "signal" (новий сигнал): не в тихі години і не більше ліміту на місцеву добу. Надіслане лягає
   *   в signal_events подією push, за нею і рахується ліміт.
   * - kind "position" (стоп, вихід за каналом, закриття за часом): завжди, бо це команда закрити відкриту позицію,
   *   а іншого способу дізнатися про вихід немає. Пишеться подією push_position і ліміт не витрачає.
   */
  private async signalPush(signalId: number, message: PushMessage, now: number, kind: "signal" | "position" = "signal"): Promise<void> {
    if (kind === "position") {
      await this.push(message);
      await this.env.DB.prepare("INSERT INTO signal_events (signal_id, ts, type, price) VALUES (?, ?, 'push_position', NULL)")
        .bind(signalId, new Date(now).toISOString())
        .run();
      return;
    }
    const [timezone, quiet, limit] = await Promise.all([
      this.setting("timezone", "Europe/Kyiv"),
      this.setting<{ from?: string; to?: string } | null>("quiet_hours", null),
      this.setting("max_signal_pushes_per_day", 5),
    ]);
    const local = localTime(now, timezone);
    if (inQuietHours(local.minutes, quiet)) return;
    const dayStart = new Date(now - local.minutes * 60_000).toISOString();
    const sent = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM signal_events WHERE type = 'push' AND ts >= ?").bind(dayStart).first<{ n: number }>();
    if ((sent?.n ?? 0) >= limit) return;
    await this.push(message);
    await this.env.DB.prepare("INSERT INTO signal_events (signal_id, ts, type, price) VALUES (?, ?, 'push', NULL)")
      .bind(signalId, new Date(now).toISOString())
      .run();
  }

  // ── Ідея скану ───────────────────────────────────────────────────────────

  /**
   * Щопів години одна ідея: код рахує бал технічного аналізу для кожної монети й напрямку, ціни входу,
   * стоп і ціль; агент «Ідея скану» вибирає один із кількох найкращих варіантів або жоден.
   * Без моделі (стеля витрат, збій) ідея лишається технічною. Спершу код закриває попередні ідеї за свічками.
   */
  private async runPick(desk: Desk, ds: DeskState, now: number): Promise<void> {
    await this.resolvePicks(desk, ds, now);
    if (!ds.scan || (await this.setting("pick_enabled", "on")) === "off") return;
    // Акції: ідея з входом за ринком має сенс лише в основну сесію США.
    if (desk === "stocks" && !usSessionOpen(now)) return;
    const scan = ds.scan;
    const db = this.env.DB;
    const [minStopPct, horizonHours, macro, style, minRsi1h] = await Promise.all([
      this.setting("min_stop_pct", 1),
      this.setting("pick_horizon_hours", 24),
      this.setting<unknown>("macro_events", []),
      this.setting<PickStyle>("pick_style", "swing"),
      this.setting("pick_min_rsi_1h", PICK_MIN_RSI_1H),
    ]);
    const rows = await db.prepare("SELECT symbol, features FROM snapshots WHERE run_id = ?").bind(scan.runId).all<{ symbol: string; features: string }>();
    const snapshots = new Map(rows.results.map((r) => [r.symbol, JSON.parse(r.features) as Snapshot]));
    // Інструмент з відкритою ідеєю (ще чекає входу або в позиції) не береться знову, поки та не закриється.
    const busy = await db.prepare("SELECT DISTINCT symbol FROM picks WHERE desk = ? AND status = 'open'").bind(desk).all<{ symbol: string }>();
    const exclude = new Set(busy.results.map((r) => r.symbol));
    const all = [...snapshots.values()];
    const marketNow = style === "short" ? shortMarket(all, ds.leader) : null;
    const options = rankPicks(all, scan.market, { minStopPct, exclude, leader: ds.leader, style, minRsi1h });
    if (!options.length) return;

    const newsRows = await db
      .prepare("SELECT ts, category, impact, sentiment, symbols, relevance FROM news WHERE desk = ? AND ts >= ? AND relevance >= 0.4 ORDER BY relevance DESC, ts DESC LIMIT 30")
      .bind(desk, new Date(now - 12 * HOUR).toISOString())
      .all<{ ts: string; category: string; impact: string; sentiment: string; symbols: string; relevance: number }>();
    const news: NewsField[] = newsRows.results.map((n) => ({
      category: n.category,
      impact: n.impact,
      sentiment: n.sentiment,
      symbols: JSON.parse(n.symbols || "[]") as string[],
      relevance: n.relevance,
      age_hours: Math.round(((now - Date.parse(n.ts)) / HOUR) * 10) / 10,
    }));

    let ai: PickAi | null = null;
    let model: string | null = null;
    let note: string | null = null;
    try {
      const input = pickInput({
        options,
        snapshots,
        btc: snapshots.get(ds.leader) ?? null,
        market: scan.market,
        news,
        horizonHours,
        minutesToMacro: minutesToMacro(macro, now),
        style,
        marketNow,
        minRsi1h,
      });
      const res = await this.llm("pick", { system: forDesk(PICK_SYSTEM, desk, ds.leader), user: JSON.stringify(input), schema: PICK_SCHEMA });
      if (!res) note = "стелю витрат вичерпано: лише технічний аналіз";
      else {
        ai = sanitizePick(res.data, options);
        model = res.model;
      }
    } catch (e) {
      note = `модель не відповіла: ${e instanceof LlmError ? e.message : String(e)}`.slice(0, 300);
    }
    const choice = choosePick(options, ai)!;
    const { option, levels } = choice;
    const body: PickBody = { v: 1, factors: option.factors, roomAtr: option.roomAtr, options, ai, note, market: scan.market, style, marketNow, minRsi1h };
    await db
      .prepare(
        `INSERT INTO picks (desk, created_at, run_id, symbol, side, entry_kind, price, entry, stop, target, score, verdict, probability, model, horizon_hours, is_repeat, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        desk, new Date(now).toISOString(), scan.runId, option.symbol, option.side, choice.entryKind, option.price,
        levels.entry, levels.stop, levels.target, option.score, choice.verdict, ai && ai.choice >= 0 ? ai.probability : null,
        model, horizonHours, 0, JSON.stringify(body),
      )
      .run();
  }

  /** Закриває відкриті ідеї: ціль, стоп, без входу або за часом. Свічки 1h з кешу. */
  private async resolvePicks(desk: Desk, ds: DeskState, now: number): Promise<void> {
    const db = this.env.DB;
    const open = await db
      .prepare("SELECT id, created_at, symbol, side, entry_kind, entry, stop, target, horizon_hours FROM picks WHERE desk = ? AND status = 'open' ORDER BY id LIMIT 150")
      .bind(desk)
      .all<{ id: number; created_at: string; symbol: string; side: "long" | "short"; entry_kind: "market" | "pullback"; entry: number; stop: number; target: number; horizon_hours: number }>();
    if (!open.results.length) return;
    const market = await this.market(desk);
    const watched = new Set(ds.symbols);
    const update = db.prepare("UPDATE picks SET status = ?, result_r = ?, filled_at = ?, resolved_at = ? WHERE id = ?");
    const statements: D1PreparedStatement[] = [];
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    const bySymbol = new Map<string, typeof open.results>();
    for (const row of open.results) bySymbol.set(row.symbol, [...(bySymbol.get(row.symbol) ?? []), row]);
    for (const [symbol, list] of bySymbol) {
      // Монету прибрали зі списку: свічок у кеші немає, тож прострочені ідеї закриваються без результату.
      if (!watched.has(symbol)) {
        for (const p of list) {
          if (Date.parse(p.created_at) + p.horizon_hours * HOUR <= now) statements.push(update.bind("expired", null, null, new Date(now).toISOString(), p.id));
        }
        continue;
      }
      const h1 = await market.candles(symbol, "1h", CANDLE_LIMIT);
      for (const p of list) {
        const res = resolvePick(
          { side: p.side, entryKind: p.entry_kind, entry: p.entry, stop: p.stop, target: p.target, createdAt: Date.parse(p.created_at), horizonMs: p.horizon_hours * HOUR },
          h1,
          now,
        );
        if (res.status !== "open" || res.filledAt !== null) statements.push(update.bind(res.status, res.resultR, iso(res.filledAt), iso(res.resolvedAt), p.id));
      }
    }
    if (statements.length) await db.batch(statements);
  }

  // ── Боти ─────────────────────────────────────────────────────────────────

  private botMarketCache: MarketData | null = null;

  /**
   * Свічки Bybit для ботів. Окремий простір у кеші рушія: скан крипто може брати свічки з Binance,
   * а ті самі символи двох бірж змішувати не можна.
   */
  private botMarket(): MarketData {
    this.botMarketCache ??= new CachedMarket(
      new BybitLinear(this.http, undefined, undefined, () => this.requests < 40),
      new SqlCandleStorage(this.ctx.storage.sql, "bybit:"),
    );
    return this.botMarketCache;
  }

  private async botCfg(id: TubeBotId): Promise<TubeConfig> {
    return tubeConfig(Object.fromEntries(await this.settingsMap()), id);
  }

  /** Скільки монет потрібно ботам «труби» (для свічок): найбільший список серед увімкнених. 0 — усі вимкнені. */
  private async botUniverseSize(): Promise<number> {
    const values = Object.fromEntries(await this.settingsMap());
    return Math.max(0, ...TUBE_BOT_IDS.filter((id) => values[botEnabledKey(id)] !== "off").map((id) => tubeConfig(values, id).topN));
  }

  /** Скільки монет має бути у спільному списку: боти «труби» і Funding Carry (йому свічки не потрібні). */
  private async botUniverseNeed(): Promise<number> {
    const values = Object.fromEntries(await this.settingsMap());
    const carry = values[botEnabledKey("carry")] !== "off" ? carryConfig(values).topN : 0;
    return Math.max(await this.botUniverseSize(), carry);
  }

  /**
   * Кроки ботів: раз на годину (перший цикл нової години UTC). Список монет і свічки спільні для всіх ботів,
   * далі кожен бот має свій крок run. Вимкнений бот лише знімає ордери й доводить відкриті позиції до закриття.
   */
  private async botSteps(now: number): Promise<string[]> {
    const hour = Math.floor(now / HOUR);
    const due: string[] = [];
    for (const id of BOT_IDS) {
      const last = await this.ctx.storage.get<number>(`bot-last:${id}`);
      if (last === undefined || Math.floor(last / HOUR) !== hour) due.push(id);
    }
    if (!due.length) return [];
    const size = await this.botUniverseSize();
    const need = await this.botUniverseNeed();
    const data = need ? ["bot:universe", ...Array.from({ length: Math.ceil(size / BOT_CHUNK) }, (_, i) => `bot:data:${i}`)] : [];
    return [...data, ...due.map((id) => `bot:${id}:run`)];
  }

  private async runBotStep(step: string, now: number): Promise<void> {
    const [, a, b] = step.split(":");
    if (a === "universe") return this.botUniverse(now);
    if (a === "data") return this.botData(Number(b), now);
    if (a === "c2010" && b === "run") return this.channelRun(now);
    if (a === "carry" && b === "run") return this.carryRun(now);
    if (isTubeBot(a) && b === "run") return this.botRun(a, now);
  }

  /**
   * Список монет ботів: топ за капіталізацією з CoinGecko, що мають контракт на Bybit. Оновлюється раз на добу;
   * якщо джерело недоступне, боти працюють зі старим списком або зі стартовим і пробують знову за годину.
   */
  private async botUniverse(now: number): Promise<void> {
    const size = await this.botUniverseNeed();
    const cached = await this.ctx.storage.get<BotUniverse>(UNIVERSE_KEY);
    if (cached?.source === "coingecko" && now - cached.at < 24 * HOUR && cached.symbols.length >= size) return;
    try {
      const [caps, instruments] = await Promise.all([marketCaps(this.http, this.env.COINGECKO_API_KEY), new BybitLinear(this.http).linearUsdt()]);
      const symbols = topUniverse(caps, instruments, size);
      if (symbols.length < Math.min(size, 5)) throw new Error(`знайдено лише ${symbols.length} монет з контрактом на Bybit`);
      await this.ctx.storage.put<BotUniverse>(UNIVERSE_KEY, { at: now, symbols, source: "coingecko" });
    } catch (e) {
      const symbols = cached?.symbols.length ? cached.symbols : TUBE_FALLBACK.slice(0, size);
      await this.ctx.storage.put<BotUniverse>(UNIVERSE_KEY, { at: cached?.at ?? 0, symbols, source: cached?.source ?? "fallback", error: String(e).slice(0, 300) });
    }
  }

  /** Частина списку: свічки 1h і 4h з Bybit (через кеш) і ознаки монет; результат чекає на кроки run ботів. */
  private async botData(index: number, now: number): Promise<void> {
    const size = await this.botUniverseSize();
    const universe = await this.ctx.storage.get<BotUniverse>(UNIVERSE_KEY);
    const symbols = (universe?.symbols ?? TUBE_FALLBACK).slice(0, size).slice(index * BOT_CHUNK, (index + 1) * BOT_CHUNK);
    const market = this.botMarket();
    const part: BotPart = { features: [], errors: [] };
    // Не більше трьох монет одночасно, як у скані: спільні IP Cloudflare легко впираються в ліміт частоти Bybit.
    for (let i = 0; i < symbols.length; i += 3) {
      await Promise.all(
        symbols.slice(i, i + 3).map(async (symbol) => {
          try {
            const [h1, h4] = await Promise.all([market.candles(symbol, "1h", TUBE_H1_LIMIT), market.candles(symbol, "4h", TUBE_H4_LIMIT)]);
            const f = tubeFeatures(symbol, h1, h4.length ? timeframeFeatures(h4) : null);
            // Свіжа свічка 1h: інакше торги контрактом зупинено.
            if (f && f.closedAt >= now - 2 * HOUR) part.features.push(f);
            else part.errors.push(`${symbol}: немає свіжих свічок 1h`);
          } catch (e) {
            part.errors.push(`${symbol}: ${String(e)}`.slice(0, 200));
          }
        }),
      );
    }
    await this.ctx.storage.put(`bot-part:${index}`, part);
  }

  /**
   * Година бота: спершу код рахує, що сталося з ордерами минулої години й відкритими позиціями (свічки 15m),
   * знімає невиконані ордери, потім ставить нові для найрухливіших монет. Ордери паперові: на біржу нічого не йде.
   */
  private async botRun(id: TubeBotId, now: number): Promise<void> {
    const started = Date.now();
    const db = this.env.DB;
    const values = Object.fromEntries(await this.settingsMap());
    const cfg = tubeConfig(values, id);
    const mode = botInfo(id).mode;
    const enabled = values[botEnabledKey(id)] !== "off";
    const word = mode === "breakout" ? "стоп-ордери" : "лімітки";
    const fees = botFees(values);
    await this.ctx.storage.put(`bot-last:${id}`, now);

    // 1. Супровід: ордери минулої години й відкриті позиції.
    const active = await db
      .prepare("SELECT id, created_at, symbol, side, entry, stop, target, expires_at, max_hold_hours, status, filled_at FROM bot_orders WHERE bot = ? AND status IN ('pending', 'open') ORDER BY id")
      .bind(id)
      .all<BotActiveRow>();
    const market = this.botMarket();
    const update = db.prepare("UPDATE bot_orders SET status = ?, filled_at = ?, resolved_at = ?, exit_price = ?, result_r = ?, fee_r = ? WHERE id = ?");
    const statements: D1PreparedStatement[] = [];
    const resolved: Record<"filled" | "target" | "stop" | "timeout" | "cancelled", number> = { filled: 0, target: 0, stop: 0, timeout: 0, cancelled: 0 };
    const open: { symbol: string; side: "long" | "short" }[] = [];
    const errors: string[] = [];
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    const bySymbol = new Map<string, BotActiveRow[]>();
    for (const row of active.results) bySymbol.set(row.symbol, [...(bySymbol.get(row.symbol) ?? []), row]);
    for (const [symbol, rows] of bySymbol) {
      let m15: Candle[];
      try {
        m15 = await market.candles(symbol, "15m", 500);
      } catch (e) {
        // Без свічок стан не змінюємо: наступна година дорахує. Позиція лишається відкритою й займає місце.
        errors.push(`${symbol} 15m: ${String(e)}`.slice(0, 200));
        for (const r of rows) if (r.status === "open") open.push({ symbol, side: r.side });
        continue;
      }
      for (const r of rows) {
        let res = resolveTube(
          { side: r.side, entry: r.entry, stop: r.stop, target: r.target, placedAt: Date.parse(r.created_at), expiresAt: Date.parse(r.expires_at), maxHoldMs: r.max_hold_hours * HOUR, mode },
          m15,
          now,
        );
        if (r.status === "open" && res.filledAt === null) {
          // Свічок від входу в кеші вже немає (рушій довго не працював): хід позиції не відтворити.
          // До терміну вона лишається відкритою, після — закривається за часом за останньою ціною.
          const filledAt = Date.parse(r.filled_at ?? r.created_at);
          const last = m15[m15.length - 1];
          if (!last || now < filledAt + r.max_hold_hours * HOUR) {
            open.push({ symbol, side: r.side });
            continue;
          }
          const risk = Math.abs(r.entry - r.stop);
          const resultR = risk ? Number((((last.close - r.entry) / risk) * (r.side === "long" ? 1 : -1)).toFixed(3)) : 0;
          res = { status: "timeout", filledAt, resolvedAt: last.closeTime, exitPrice: last.close, resultR };
          errors.push(`${symbol}: свічок від входу вже немає, позицію закрито за часом за останньою ціною`);
        }
        // Нова година замінює ордери: невиконаний знімається зараз, навіть якщо його година ще не минула.
        const status: TubeStatus = res.status === "pending" ? "cancelled" : res.status;
        const resolvedAt = res.status === "pending" ? now : res.resolvedAt;
        if (status === "open") open.push({ symbol, side: r.side });
        if (status === "open" && r.status === "open") continue;
        if (r.status === "pending" && res.filledAt !== null) resolved.filled++;
        if (status !== "open") resolved[status]++;
        statements.push(update.bind(status, iso(res.filledAt), iso(resolvedAt), res.exitPrice, res.resultR, tubeFeeR(r, status, res.exitPrice, fees, mode), r.id));
      }
    }

    // 2. Нові ордери години. Ознаки спільні для всіх ботів; кожен бере лише свій розмір списку.
    let plan: CyclePlan | null = null;
    let note: string | null = null;
    const universe = await this.ctx.storage.get<BotUniverse>(UNIVERSE_KEY);
    const mine = new Set((universe?.symbols ?? TUBE_FALLBACK).slice(0, cfg.topN));
    const parts = await this.ctx.storage.get<BotPart>(Array.from({ length: Math.ceil(30 / BOT_CHUNK) }, (_, i) => `bot-part:${i}`));
    // Лише свіжі ознаки: частина з циклу, що не дійшов до кінця, могла пролежати годину.
    const features = [...parts.values()].flatMap((p) => p.features).filter((f) => f.closedAt >= now - 2 * HOUR && mine.has(f.symbol));
    errors.push(...[...parts.values()].flatMap((p) => p.errors));
    if (!enabled) note = `бот вимкнено: нові ${word} не ставляться, відкриті позиції ведуться до закриття`;
    else if (features.length < Math.max(cfg.pickN, Math.ceil(cfg.topN / 2))) note = `ознаки лише для ${features.length} монет: ${word} цієї години не ставляться`;
    else {
      plan = planCycle(features, open, cfg, { mode });
      if (plan.idle === "neutral") note = `ринок без напрямку: ${word} цієї години не ставляться`;
      const insert = db.prepare(
        `INSERT INTO bot_orders (bot, desk, created_at, symbol, side, bias, near, rank, price, atr, entry, stop, target, expires_at, max_hold_hours, body)
         VALUES (?, 'crypto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const byCoin = new Map(features.map((f) => [f.symbol, f]));
      for (const o of plan.orders) {
        const body: TubeOrderBody = {
          v: 1,
          features: byCoin.get(o.symbol)!,
          offsetAtr: o.offsetAtr,
          market: plan.market,
          cfg: {
            entryAtr: cfg.entryAtr, biasRatio: cfg.biasRatio, biasSide: cfg.biasSide, stopAtr: cfg.stopAtr, targetR: cfg.targetR, minStopPct: cfg.minStopPct,
            trendOnly: cfg.trendOnly, skipNeutral: cfg.skipNeutral,
          },
        };
        statements.push(
          insert.bind(
            id, iso(now), o.symbol, o.side, o.bias, o.near === null ? null : o.near ? 1 : 0, o.rank, o.price, o.atr, o.entry, o.stop, o.target,
            iso(now + ORDER_TTL_MS), cfg.maxHoldHours, JSON.stringify(body),
          ),
        );
      }
    }
    if (statements.length) await db.batch(statements);

    const detail: TubeCycleDetail = {
      bot: id,
      bias: plan?.bias ?? null,
      market: plan?.market ?? null,
      universe: { source: universe?.source ?? "fallback", at: universe?.at ? new Date(universe.at).toISOString() : null, size: features.length, error: universe?.error ?? null },
      ranked: (plan?.ranked ?? []).map((f) => ({ symbol: f.symbol, price: f.price, atrPct: f.atrPct, volRatio: f.volRatio, score: f.score, trend4h: f.trend4h, change24hPct: f.change24hPct, ema20: f.ema20 })),
      chosen: plan?.chosen ?? [],
      placed: plan?.orders.length ?? 0,
      skipped: plan?.skipped ?? [],
      resolved,
      open: open.length,
      note,
      errors: errors.slice(0, 20),
    };
    await this.logRun("bot", started, detail, plan || !enabled ? null : (note ?? `бот не поставив ордерів`), "crypto");
  }

  /**
   * Доба Funding Carry: раз на добу, у перший цикл після 00:00 UTC. Спершу нараховується фандинг за відкритими
   * позиціями (історія ставок Bybit), потім за середньою ставкою за lookbackDays вирішується, що закрити й що відкрити.
   * Паперова торгівля: на біржу нічого не йде. Запитів: список спотових пар (раз на добу), марк-ціни (один), історія
   * фандингу по одному на монету списку й відкриту позицію поза ним — до ~35 при списку 20 і 10 позиціях.
   */
  private async carryRun(now: number): Promise<void> {
    const id = "carry" as const;
    await this.ctx.storage.put(`bot-last:${id}`, now);
    const day = Math.floor(now / CARRY_DAY) * CARRY_DAY;
    const lastDay = await this.ctx.storage.get<number>(`cry-day:${id}`);
    if (lastDay !== undefined && lastDay >= day) return;
    const started = Date.now();
    const db = this.env.DB;
    const values = Object.fromEntries(await this.settingsMap());
    const cfg = carryConfig(values);
    const enabled = values[botEnabledKey(id)] !== "off";
    const legCost = carryLegCost({ spotTakerPct: SPOT_TAKER_PCT, perpTakerPct: botFees(values).takerPct, slippagePct: 0 });
    const iso = (t: number) => new Date(t).toISOString();
    const errors: string[] = [];
    const detail: CarryCycleDetail = {
      bot: id, universe: { source: "fallback", size: 0, withSpot: 0, error: null }, ranked: [], entered: [], exited: [], fundingPct: 0, feePct: 0,
      bias: null, chosen: [], placed: 0, open: 0, note: null, errors,
    };
    const open = await db
      .prepare("SELECT id, symbol, share, funding, payments, last_funding_at, fee, opened_at FROM carry_positions WHERE status = 'open' ORDER BY id")
      .all<{ id: number; symbol: string; share: number; funding: number; payments: number; last_funding_at: string | null; fee: number; opened_at: string }>();
    if (!enabled && !open.results.length) {
      await this.ctx.storage.put(`cry-day:${id}`, day);
      return;
    }
    const bybit = new BybitLinear(this.http);
    const universe = await this.ctx.storage.get<BotUniverse>(UNIVERSE_KEY);
    const listed = (universe?.symbols ?? TUBE_FALLBACK).slice(0, cfg.topN);
    detail.universe = { source: universe?.source ?? "fallback", size: listed.length, withSpot: 0, error: universe?.error ?? null };

    // Спотові пари Bybit: раз на добу, у сховищі рушія. Без них нових входів немає, а супровід працює.
    let spot = await this.ctx.storage.get<{ at: number; bases: string[] }>("carry-spot");
    if (!spot || now - spot.at > 20 * HOUR) {
      try {
        spot = { at: now, bases: [...(await bybit.spotUsdt()).keys()] };
        await this.ctx.storage.put("carry-spot", spot);
      } catch (e) {
        errors.push(`спот: ${String(e)}`.slice(0, 200));
      }
    }
    const spotSet = new Set(spot?.bases ?? []);
    const withSpot = listed.filter((s) => spotSet.has(spotBase(s)));
    detail.universe.withSpot = withSpot.length;

    let marks = new Map<string, { markPrice: number }>();
    try {
      marks = await bybit.funding();
    } catch (e) {
      errors.push(`ціни: ${String(e)}`.slice(0, 200));
    }

    // Історія ставок: для вікна рішення і для нарахувань з останнього врахованого.
    const look = cfg.lookbackDays * CARRY_DAY;
    const symbols = [...new Set([...withSpot, ...open.results.map((p) => p.symbol)])];
    const history = new Map<string, FundingEvent[] | null>();
    for (let i = 0; i < symbols.length; i += 3) {
      await Promise.all(
        symbols.slice(i, i + 3).map(async (symbol) => {
          const pos = open.results.find((p) => p.symbol === symbol);
          const since = Math.min(now - look, pos ? (pos.last_funding_at ? Date.parse(pos.last_funding_at) + 1 : Date.parse(pos.opened_at)) : Infinity);
          try {
            const ev = await bybit.fundingHistory(symbol, since, now, pos ? 3 : 1);
            history.set(symbol, ev.map((e) => ({ at: e.at, paid: e.rate })));
          } catch (e) {
            // Помилка запиту — не привід закривати позицію: монета просто пропускає цю добу.
            history.set(symbol, null);
            errors.push(`${symbol}: ${String(e)}`.slice(0, 200));
          }
        }),
      );
    }
    const aprOf = new Map<string, number | null>();
    for (const [symbol, ev] of history) if (ev) aprOf.set(symbol, fundingApr(ev, now - look, now));
    detail.ranked = symbols
      .filter((s) => history.get(s))
      .map((s) => ({ symbol: s, apr: aprOf.get(s) ?? null, spot: spotSet.has(spotBase(s)), open: open.results.some((p) => p.symbol === s) }))
      .sort((a, b) => (b.apr ?? -Infinity) - (a.apr ?? -Infinity));

    // 1. Нарахування за відкритими позиціями.
    const statements: D1PreparedStatement[] = [];
    const state = new Map(open.results.map((p) => [p.symbol, { ...p }]));
    for (const p of state.values()) {
      const ev = history.get(p.symbol);
      if (!ev) continue;
      const from = p.last_funding_at ? Date.parse(p.last_funding_at) : Date.parse(p.opened_at);
      const fresh = ev.filter((e) => e.at > from && e.at <= now);
      if (!fresh.length) continue;
      const paid = fresh.reduce((sum, e) => sum + e.paid, 0);
      p.funding += paid;
      p.payments += fresh.length;
      p.last_funding_at = iso(Math.max(...fresh.map((e) => e.at)));
      detail.fundingPct += paid * p.share * 100;
    }

    // 2. Рішення. Монета з помилкою запиту в плані не бере участі: її позиція лишається.
    const known = [...state.keys()].filter((s) => history.get(s));
    const plan = planCarry(known, aprOf, enabled ? withSpot.filter((s) => history.get(s)) : [], { ...cfg, maxPositions: cfg.maxPositions - (state.size - known.length) });
    const close = db.prepare("UPDATE carry_positions SET status = 'closed', closed_at = ?, exit_apr = ?, exit_price = ?, funding = ?, payments = ?, last_funding_at = ?, fee = ?, reason = ? WHERE id = ?");
    const keep = db.prepare("UPDATE carry_positions SET funding = ?, payments = ?, last_funding_at = ? WHERE id = ?");
    for (const p of state.values()) {
      if (plan.exit.includes(p.symbol)) {
        const apr = aprOf.get(p.symbol) ?? null;
        p.fee += legCost;
        detail.feePct += legCost * p.share * 100;
        const reason = apr === null ? "no_data" : "below_exit";
        detail.exited.push({ symbol: p.symbol, apr: apr === null ? null : Number(apr.toFixed(2)), reason, netPct: Number(carryNetPct(p).toFixed(4)) });
        statements.push(close.bind(iso(now), apr, marks.get(p.symbol)?.markPrice ?? null, p.funding, p.payments, p.last_funding_at, p.fee, reason, p.id));
      } else {
        statements.push(keep.bind(p.funding, p.payments, p.last_funding_at, p.id));
      }
    }
    const insert = db.prepare("INSERT INTO carry_positions (opened_at, symbol, share, entry_apr, entry_price, fee, last_funding_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const share = 1 / cfg.maxPositions;
    for (const symbol of plan.enter) {
      const apr = aprOf.get(symbol)!;
      detail.entered.push({ symbol, apr: Number(apr.toFixed(2)) });
      detail.feePct += legCost * share * 100;
      // Нарахування до входу позиції не належать.
      statements.push(insert.bind(iso(now), symbol, share, apr, marks.get(symbol)?.markPrice ?? null, legCost, iso(now)));
    }
    const openAfter = [...state.keys()].filter((s) => !plan.exit.includes(s)).concat(plan.enter);
    detail.chosen = openAfter;
    detail.placed = plan.enter.length;
    detail.open = openAfter.length;
    detail.fundingPct = Number(detail.fundingPct.toFixed(4));
    detail.feePct = Number(detail.feePct.toFixed(4));
    if (!enabled) detail.note = "бот вимкнений: нових позицій немає, відкриті ведуться до виходу";
    else if (!spotSet.size) detail.note = "немає списку спотових пар Bybit: нових позицій немає";
    statements.push(
      db
        .prepare(
          "INSERT INTO carry_days (day, funding_pct, fee_pct, positions) VALUES (?, ?, ?, ?) ON CONFLICT (day) DO UPDATE SET funding_pct = funding_pct + excluded.funding_pct, fee_pct = fee_pct + excluded.fee_pct, positions = excluded.positions",
        )
        .bind(iso(day).slice(0, 10), detail.fundingPct, detail.feePct, openAfter.length),
    );
    await db.batch(statements);
    await this.ctx.storage.put(`cry-day:${id}`, day);
    await this.logRun("bot", started, detail, null, "crypto");
  }

  /**
   * Година Channel 20/10. Спершу супровід: вхід за першою ціною після постановки (свічки 15m), стоп за свічками 15m,
   * перерахунок стопа після кожного денного закриття. Потім, у першу годину нової доби UTC, — сигнал на свічці, що закрилась.
   * Паперова торгівля: на біржу нічого не йде. Фандинг за історичними ставками Bybit рахується на виході.
   */
  private async channelRun(now: number): Promise<void> {
    const id = "c2010" as const;
    const started = Date.now();
    const db = this.env.DB;
    const values = Object.fromEntries(await this.settingsMap());
    const cfg = channelConfig(values);
    const enabled = values[botEnabledKey(id)] !== "off";
    const fees = botFees(values);
    await this.ctx.storage.put(`bot-last:${id}`, now);
    const errors: string[] = [];
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    const detail: ChannelCycleDetail = {
      bot: id, symbol: cfg.symbol, price: null, levels: null, signal: null, position: null, resolved: { filled: 0, stop: 0, cancelled: 0 }, trailed: [],
      bias: null, chosen: [cfg.symbol], placed: 0, open: 0, note: null, errors,
    };
    const market = this.botMarket();
    let daily: Candle[];
    let m15: Candle[];
    try {
      [daily, m15] = await Promise.all([market.candles(cfg.symbol, "1d", CHANNEL_D1_LIMIT), market.candles(cfg.symbol, "15m", 500)]);
    } catch (e) {
      // Без свічок стан не змінюємо: наступна година дорахує.
      detail.note = `немає свічок ${cfg.symbol}: ${String(e)}`.slice(0, 300);
      await this.logRun("bot", started, detail, detail.note, "crypto");
      return;
    }
    detail.price = m15[m15.length - 1]?.close ?? null;
    detail.levels = nextLevels(daily, cfg);
    const t = daily[daily.length - 1];
    // Без денних свічок сигналу немає; межа «після закриття» тоді — зараз, щоб не тягнути всю історію виходів.
    const tClose = t ? t.closeTime : now;

    // 1. Супровід. Разом з активними беремо вихід після закриття доби t: позиція тоді ще була відкрита.
    const rows = await db
      .prepare(
        "SELECT id, created_at, side, entry, stop, trail_stop, expires_at, status, filled_at, resolved_at, body FROM bot_orders WHERE bot = ? AND (status IN ('pending', 'open') OR (status = 'stop' AND resolved_at > ?)) ORDER BY id",
      )
      .bind(id, iso(tClose))
      .all<{ id: number; created_at: string; side: "long" | "short"; entry: number; stop: number; trail_stop: number | null; expires_at: string; status: string; filled_at: string | null; resolved_at: string | null; body: string }>();
    const update = db.prepare("UPDATE bot_orders SET status = ?, entry = ?, filled_at = ?, resolved_at = ?, exit_price = ?, result_r = ?, fee_r = ?, trail_stop = ?, body = ? WHERE id = ?");
    const statements: D1PreparedStatement[] = [];
    let openAtClose = rows.results.some((r) => r.status === "stop");
    const priceAt = (at: number) => m15.find((c) => c.openTime === at)?.open ?? daily.find((c) => c.openTime <= at && at <= c.closeTime)?.open ?? null;
    for (const r of rows.results) {
      if (r.status !== "pending" && r.status !== "open") continue;
      const body = JSON.parse(r.body) as ChannelOrderBody;
      let status: "pending" | "open" | "cancelled" | "stop" = r.status;
      let track = body.track;
      let filledAt = r.filled_at ? Date.parse(r.filled_at) : null;
      let resolvedAt: number | null = null;
      let exitPrice: number | null = null;
      let resultR: number | null = null;
      let feeRValue: number | null = null;
      if (status === "pending") {
        const f = fillChannel({ side: r.side, stop: r.stop, placedAt: Date.parse(r.created_at), expiresAt: Date.parse(r.expires_at) }, m15, now);
        if (f.status === "cancelled") {
          body.skip = f.reason;
          status = "cancelled";
          resolvedAt = f.at;
          detail.resolved.cancelled++;
        } else if (f.status === "open") {
          status = "open";
          filledAt = f.filledAt;
          track = openTrack(r.side, f.entry, r.stop, f.filledAt, body.signal.day);
          detail.resolved.filled++;
        }
      }
      if (status === "open" && track && filledAt !== null) {
        const adv = advanceChannel(track, daily, m15, now, body.cfg.exitDays);
        let funding: ChannelFunding | null = null;
        if (adv.exit) {
          try {
            const events = await new BybitLinear(this.http).fundingHistory(cfg.symbol, filledAt, adv.exit.to);
            funding = channelFunding(adv.track, events, filledAt, adv.exit, now, (at) => priceAt(at) ?? adv.track.entry);
          } catch (e) {
            // Без ставок вихід не записуємо: наступна година перевірить ту саму свічку знову.
            errors.push(`фандинг: ${String(e)}`.slice(0, 200));
          }
        }
        if (adv.exit && funding) {
          status = "stop";
          resolvedAt = adv.exit.to;
          exitPrice = adv.exit.price;
          resultR = channelR(adv.track, adv.exit.price);
          // Фандинг у R іде разом із комісіями: чистий результат = result_r − fee_r.
          feeRValue = Number((channelFeeR(adv.track, adv.exit.price, fees) - funding.r).toFixed(4));
          body.exit = adv.exit;
          body.funding = funding;
          detail.resolved.stop++;
          if (adv.exit.to > tClose) openAtClose = true;
        }
        if (!adv.exit || funding) {
          track = adv.track;
          body.trailed.push(...adv.trailed.map((x) => ({ day: new Date(x.day).toISOString().slice(0, 10), stop: x.stop })));
          detail.trailed.push(...adv.trailed.map((x) => ({ day: new Date(x.day).toISOString().slice(0, 10), stop: x.stop })));
        }
        body.track = track;
      }
      if (status === "pending" || status === "open") {
        openAtClose = openAtClose || status === "open" || status === "pending";
        const lastPrice = detail.price;
        detail.position = {
          id: r.id,
          side: r.side,
          status,
          entry: track?.entry ?? r.entry,
          stop: track?.stop ?? r.stop,
          initialStop: r.stop,
          filledAt: iso(filledAt),
          r: status === "open" && track && lastPrice !== null ? channelR(track, lastPrice) : null,
        };
        detail.open++;
      }
      if (status === r.status && status === "pending") continue;
      statements.push(update.bind(status, track?.entry ?? r.entry, iso(filledAt), iso(resolvedAt), exitPrice, resultR, feeRValue, track?.stop ?? r.trail_stop, JSON.stringify(body), r.id));
    }

    // 2. Сигнал свіжої денної свічки — раз на добу.
    const lastDay = await this.ctx.storage.get<number>(`chn-day:${id}`);
    if (t && (lastDay === undefined || t.openTime > lastDay)) {
      await this.ctx.storage.put(`chn-day:${id}`, t.openTime);
      const s = channelSignal(daily, cfg.entryDays);
      if (!s) detail.note = `для сигналу потрібно ${cfg.entryDays + 1} послідовних денних свічок`;
      else {
        let action: ChannelAction = "none";
        let note: string | null = null;
        if (s.side) {
          const late = now - (tClose + 1) > cfg.entryWindowHours * HOUR;
          if (!enabled) action = "disabled";
          else if (openAtClose) {
            action = "ignored";
            note = "на закритті доби була відкрита позиція";
          } else if (late) {
            action = "expired";
            note = `перший цикл після закриття доби запізнився більше ніж на ${cfg.entryWindowHours} год; заднім числом бот не входить`;
          } else {
            const stop = channelStop(daily, s.side, cfg.exitDays);
            const atrs = atr(daily, 14);
            const a = atrs.length ? atrs[atrs.length - 1]! : null;
            if (stop === null) {
              action = "expired";
              note = `для стопа потрібно ${cfg.exitDays} послідовних денних свічок`;
            } else {
              const body: ChannelOrderBody = {
                v: 1, kind: "channel", signal: s, cfg: { entryDays: cfg.entryDays, exitDays: cfg.exitDays },
                atrPct: a === null ? null : Number(((a / s.close) * 100).toFixed(3)), track: null, trailed: [], exit: null, funding: null, skip: null,
              };
              statements.push(
                db
                  .prepare(
                    `INSERT INTO bot_orders (bot, desk, created_at, symbol, side, bias, near, rank, price, atr, entry, stop, target, expires_at, max_hold_hours, trail_stop, body)
                     VALUES (?, 'crypto', ?, ?, ?, 'neutral', NULL, 1, ?, ?, ?, ?, 0, ?, 0, ?, ?)`,
                  )
                  .bind(id, iso(now), cfg.symbol, s.side, s.close, a ?? 0, s.close, stop, iso(now + HOUR), stop, JSON.stringify(body)),
              );
              action = "placed";
              detail.placed = 1;
              detail.open++;
            }
          }
        }
        detail.signal = { side: s.side, close: s.close, upper: s.upper, lower: s.lower, day: new Date(s.day).toISOString().slice(0, 10), action, note };
      }
    }
    if (statements.length) await db.batch(statements);
    if (!enabled && !detail.note) detail.note = "бот вимкнено: нових входів немає, відкрита позиція ведеться до стопа";
    await this.logRun("bot", started, detail, null, "crypto");
  }

  // ── Тижневий розбір ──────────────────────────────────────────────────────

  /**
   * У неділю рахує статистику тижня й просить агента «Тижневий розбір» пояснити її.
   * Якщо стеля витрат не дозволяє або виклик не вдався, звіт виходить зі статистикою без розбору моделі.
   */
  private async runWeekly(now: number, desk: Desk = "crypto", force = false): Promise<{ status: "saved" | "exists" | "not_due"; id?: number }> {
    const db = this.env.DB;
    const timezone = await this.setting("timezone", "Europe/Kyiv");
    const due = force ? { date: localTime(now, timezone).date } : dueWeekly(now, timezone, await this.setting("weekly_review_time", "12:00"));
    if (!due) return { status: "not_due" };
    if (await this.reportExists(desk, "weekly", due.date)) return { status: "exists" };

    const started = Date.now();
    const leader = await this.leader(desk);
    const [week, allTime] = await Promise.all([
      loadStats(db, { from: new Date(now - 7 * 24 * HOUR).toISOString(), now, desk, leader }),
      loadStats(db, { from: null, now, desk, leader }),
    ]);
    const stats = { week, allTime };

    const playbook = await this.playbook();
    const notes = await db
      .prepare(
        "SELECT j.ts, j.action, j.note FROM journal j JOIN signals s ON s.id = j.signal_id WHERE s.desk = ? AND j.ts >= ? AND j.note IS NOT NULL ORDER BY j.id DESC LIMIT 20",
      )
      .bind(desk, new Date(now - 7 * 24 * HOUR).toISOString())
      .all<{ ts: string; action: string | null; note: string }>();
    const settings = Object.fromEntries(
      await Promise.all(
        ["min_stop_pct", "skeptic_threshold", "max_active_signals", "signal_max_hold_hours", "fee_maker_pct", "fee_taker_pct"].map(async (k) => [k, await this.setting<unknown>(k, null)] as const),
      ),
    );
    const input = weeklyInput({ week, allTime, playbook: { version: playbook.version, rules: playbook.rules as Record<string, string> }, settings, notes: notes.results.map((n) => ({ ...n, note: n.note.slice(0, 300) })) });
    let review: WeeklyReview | null = null;
    let note: string | null = null;
    let llm: { model: string; cost: number } | null = null;
    try {
      const res = await this.llm("weekly_review", { system: forDesk(WEEKLY_SYSTEM, desk, leader), user: JSON.stringify(input), schema: WEEKLY_SCHEMA });
      if (!res) note = "стеля витрат вичерпана: розбір моделі пропущено";
      else {
        llm = { model: res.model, cost: res.costUsd };
        review = sanitizeWeekly(res.data);
      }
    } catch (e) {
      note = `розбір моделі не вдався: ${e instanceof Error ? e.message : String(e)}`;
    }
    return { status: "saved", id: await this.saveWeekly(desk, due.date, stats, review, note, started, llm) };
  }

  /** Тижневий розбір поза розкладом: за сьогоднішньою місцевою датою. */
  async weeklyNow(desk: Desk = "crypto"): Promise<{ status: string; id?: number; error?: string } | null> {
    if (await this.busy()) return null;
    try {
      return await this.runWeekly(Date.now(), desk, true);
    } catch (e) {
      return { status: "error", error: String(e) };
    }
  }

  private async saveWeekly(
    desk: Desk,
    date: string,
    stats: { week: Awaited<ReturnType<typeof loadStats>>; allTime: Awaited<ReturnType<typeof loadStats>> },
    review: WeeklyReview | null,
    note: string | null,
    started: number,
    llm: { model: string; cost: number } | null = null,
  ): Promise<number | undefined> {
    if (await this.reportExists(desk, "weekly", date)) return undefined;
    const body = weeklyBody(stats.week, stats.allTime, review, note);
    const row = await this.env.DB.prepare("INSERT INTO reports (desk, kind, date, body, model, cost_usd, created_at) VALUES (?, 'weekly', ?, ?, ?, ?, ?) RETURNING id")
      .bind(desk, date, JSON.stringify(body), llm?.model ?? null, llm?.cost ?? null, new Date().toISOString())
      .first<{ id: number }>();
    await this.logRun("weekly_review", started, { id: row!.id, date, review: review !== null, note }, null, desk);
    await this.push({ title: deskTitle(desk, "Тижневий розбір готовий"), body: body.content.headline, url: deskUrl(desk, `/?report=${row!.id}`), tag: `report-${row!.id}` });
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
    const [snapshots, news, picks, runs, botOrders] = await db.batch<never>([
      db
        .prepare(
          `DELETE FROM snapshots WHERE id IN (
             SELECT s.id FROM snapshots s JOIN runs r ON r.id = s.run_id
             WHERE r.started_at < ? AND s.id NOT IN (SELECT snapshot_id FROM signals WHERE snapshot_id IS NOT NULL)
             LIMIT 20000)`,
        )
        .bind(cutoff),
      db.prepare("DELETE FROM news WHERE id IN (SELECT id FROM news WHERE ts < ? LIMIT 20000)").bind(cutoff),
      // Ідеї лишаються назавжди (історія й облік); видаляються лише старі повтори, які в облік не йдуть.
      db.prepare("DELETE FROM picks WHERE id IN (SELECT id FROM picks WHERE is_repeat = 1 AND created_at < ? AND status != 'open' LIMIT 20000)").bind(runsCutoff),
      db
        .prepare(
          `DELETE FROM runs WHERE id IN (
             SELECT id FROM runs WHERE started_at < ? AND kind IN ('scan', 'news', 'signals', 'probe', 'pipeline', 'bot')
               AND id NOT IN (SELECT run_id FROM snapshots) LIMIT 20000)`,
        )
        .bind(runsCutoff),
      // Угоди ботів лишаються назавжди; зняті без виконання лімітки потрібні лише для частки виконаних за останній час.
      db.prepare("DELETE FROM bot_orders WHERE id IN (SELECT id FROM bot_orders WHERE status = 'cancelled' AND created_at < ? LIMIT 20000)").bind(cutoff),
    ]);
    await this.logRun(
      "cleanup",
      started,
      { retentionDays: days, snapshots: snapshots!.meta.changes, news: news!.meta.changes, picks: picks!.meta.changes, runs: runs!.meta.changes, botOrders: botOrders!.meta.changes },
      null,
    );
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
