import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export type ProbeResult = {
  colo: string | null;
  binance: { status: number | null; ok: boolean; error?: string };
  claude: { status: number | null; ok: boolean; error?: string; skipped?: boolean };
};

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Рушій. Працює в юрисдикції `eu`, тож усі запити назовні йдуть із ЄС.
 * Обробник `scheduled` лише викликає `tick()`.
 */
export class Engine extends DurableObject<Env> {
  private running = false;

  /** Викликається раз на 30 хв. Вирішує, які завдання настали, і виконує їх. */
  async tick(): Promise<{ ran: string[] }> {
    if (this.running) return { ran: [] };
    this.running = true;
    const ran: string[] = [];
    try {
      await this.run("scan", async () => {
        // Етап «Дані і рушій»: свічки, індикатори, знімки, детектори.
        return { candidates: 0 };
      });
      ran.push("scan");
      // Етап «Звіти»: перевірка часу звітів за поясом користувача.
    } finally {
      this.running = false;
    }
    return { ran };
  }

  /** Перевірка доступності Binance Futures і Claude API з місця, де працює рушій. */
  async probe(): Promise<ProbeResult> {
    let result: ProbeResult = {
      colo: null,
      binance: { status: null, ok: false },
      claude: { status: null, ok: false },
    };
    await this.run("probe", async () => {
      result = {
        colo: await this.colo(),
        binance: await this.check("https://fapi.binance.com/fapi/v1/time"),
        claude: this.env.ANTHROPIC_API_KEY
          ? await this.check("https://api.anthropic.com/v1/models?limit=1", {
              "x-api-key": this.env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
            })
          : { status: null, ok: false, skipped: true },
      };
      const failed = !result.binance.ok || (!result.claude.ok && !result.claude.skipped);
      if (failed) throw new Error(JSON.stringify(result));
      return { candidates: 0 };
    }).catch(() => undefined);
    return result;
  }

  private async check(url: string, headers: Record<string, string> = {}) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      await res.body?.cancel();
      return { status: res.status, ok: res.ok };
    } catch (e) {
      return { status: null, ok: false, error: String(e) };
    }
  }

  private async colo(): Promise<string | null> {
    try {
      const res = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
        signal: AbortSignal.timeout(5_000),
      });
      const text = await res.text();
      return /^colo=(.+)$/m.exec(text)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  /** Обгортка: кожен запуск лишає рядок у `runs`. */
  private async run(kind: string, job: () => Promise<{ candidates: number }>) {
    const started = Date.now();
    const row = await this.env.DB.prepare(
      "INSERT INTO runs (kind, started_at, status) VALUES (?, ?, 'running') RETURNING id",
    )
      .bind(kind, nowIso())
      .first<{ id: number }>();
    const id = row!.id;
    try {
      const { candidates } = await job();
      await this.env.DB.prepare(
        "UPDATE runs SET status='ok', finished_at=?, duration_ms=?, candidates=? WHERE id=?",
      )
        .bind(nowIso(), Date.now() - started, candidates, id)
        .run();
    } catch (e) {
      await this.env.DB.prepare(
        "UPDATE runs SET status='error', finished_at=?, duration_ms=?, error=? WHERE id=?",
      )
        .bind(nowIso(), Date.now() - started, String(e).slice(0, 2000), id)
        .run();
      throw e;
    }
  }
}
