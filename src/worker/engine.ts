import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { BinanceFutures } from "./market/binance";
import type { MarketData } from "./market/types";
import type { MarketRegime } from "./regime";
import { scan } from "./scan";

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

/**
 * Рушій. Усі серверні запити назовні (біржа, Claude API, новини)
 * виходять тільки звідси: об'єкт закріплено в юрисдикції eu.
 */
export class Engine extends DurableObject<Env> {
  private running = false;

  /** Викликається з Cron Trigger раз на 30 хв. */
  async tick(): Promise<{ ran: string[] }> {
    if (this.running) return { ran: [] };
    this.running = true;
    try {
      // Етап «Дані і рушій»: скан рахує знімки ознак, модель ще не викликається.
      await this.runScan();
      return { ran: ["scan"] };
    } finally {
      this.running = false;
    }
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
}
