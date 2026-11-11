import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

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
      // Етап «Каркас»: скан поки що лише перевіряє доступність джерел.
      await this.probe("scan");
      return { ran: ["scan"] };
    } finally {
      this.running = false;
    }
  }

  /** Перевірка: чи відповідають Binance і Claude API з дата-центру рушія. */
  async probe(kind: "probe" | "scan" = "probe"): Promise<ProbeResult> {
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
        kind,
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
