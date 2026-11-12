import { Hono } from "hono";
import type { ReportBody } from "./engine";
import { engineStub, type Env } from "./env";
import { parseSubscription } from "./push";

export { Engine } from "./engine";

const app = new Hono<{ Bindings: Env }>();

// Вхід: перед застосунком стоїть Cloudflare Access.
// TODO(етап «Каркас»): перевіряти підпис JWT за ключами команди, а не лише наявність заголовка.
app.use("/api/*", async (c, next) => {
  if (c.env.DEV === "1" || c.req.path === "/api/health") return next();
  if (!c.req.header("Cf-Access-Jwt-Assertion")) return c.json({ error: "unauthorized" }, 401);
  return next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

/** Пульс системи для екрана «Сьогодні»: останній скан, останній звіт, витрати за місяць. */
app.get("/api/status", async (c) => {
  const db = c.env.DB;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [last, report, spent, budget] = await Promise.all([
    db
      .prepare("SELECT kind, started_at, status, duration_ms, detail, error FROM runs WHERE kind IN ('scan', 'probe') ORDER BY id DESC LIMIT 1")
      .first<{ kind: string; started_at: string; status: string; duration_ms: number; detail: string | null; error: string | null }>(),
    db.prepare("SELECT id, kind, date, body, created_at FROM reports ORDER BY created_at DESC LIMIT 1").first<ReportRow>(),
    db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM llm_calls WHERE ts >= ?").bind(monthStart).first<{ usd: number }>(),
    db.prepare("SELECT value FROM settings WHERE key = 'llm_budget_usd'").first<{ value: string }>(),
  ]);
  return c.json({
    lastRun: last ? { ...last, detail: last.detail ? JSON.parse(last.detail) : null } : null,
    lastReport: report ? reportCard(report) : null,
    spend: { monthUsd: spent?.usd ?? 0, budgetUsd: budget ? Number(JSON.parse(budget.value)) : null },
  });
});

interface ReportRow {
  id: number;
  kind: string;
  date: string;
  body: string;
  created_at: string;
}

function reportCard(r: ReportRow) {
  const body = JSON.parse(r.body) as ReportBody;
  return { id: r.id, kind: r.kind, date: r.date, created_at: r.created_at, headline: body.content.headline, theses: body.content.theses };
}

/** Стрічка звітів, від нових. */
app.get("/api/reports", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, kind, date, body, created_at FROM reports ORDER BY created_at DESC LIMIT 30").all<ReportRow>();
  return c.json({ reports: rows.results.map(reportCard) });
});

/** Звіт повністю: тіло, прогнози з результатами, новини, які врахував автор. */
app.get("/api/reports/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const row = await db
    .prepare("SELECT id, kind, date, body, model, cost_usd, created_at FROM reports WHERE id = ?")
    .bind(id)
    .first<ReportRow & { model: string | null; cost_usd: number | null }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const body = JSON.parse(row.body) as ReportBody;
  const forecasts = await db
    .prepare("SELECT id, statement, probability, resolve_at, outcome, resolved_at FROM forecasts WHERE source = ? ORDER BY id")
    .bind(`report:${id}`)
    .all();
  const ids = body.newsIds.filter((n) => Number.isInteger(n)).slice(0, 20);
  const news = ids.length
    ? await db
        .prepare(`SELECT id, ts, source, url, title, impact, sentiment, category FROM news WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY relevance DESC`)
        .bind(...ids)
        .all()
    : { results: [] };
  return c.json({ ...row, body, forecasts: forecasts.results, news: news.results });
});

/** Ручний запуск звіту. 409, якщо рушій зайнятий або звіт за сьогодні вже є. */
app.post("/api/reports/run", async (c) => {
  const { kind } = await c.req.json<{ kind?: string }>().catch(() => ({ kind: undefined }));
  if (kind !== "morning" && kind !== "evening") return c.json({ error: "kind must be morning or evening" }, 400);
  const res = await engineStub(c.env).reportNow(kind);
  if (res === null) return c.json({ error: "engine busy" }, 409);
  return "error" in res ? c.json(res, 409) : c.json(res);
});

const SIGNAL_COLUMNS =
  "id, created_at, symbol, side, setup, entry_low, entry_high, stop, tp1, tp2, rr, p_analyst, p_skeptic, status, expires_at, result_r, resolved_at";

/** Сигнали: open (чекають входу або активні), closed (із результатом), rejected (відхилені моделлю). */
app.get("/api/signals", async (c) => {
  const where: Record<string, string> = {
    open: "status IN ('pending', 'active')",
    closed: "status IN ('tp1', 'tp2', 'stopped', 'expired')",
    rejected: "status = 'rejected'",
  };
  const scope = c.req.query("scope") ?? "open";
  if (!where[scope]) return c.json({ error: "scope must be open, closed or rejected" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT ${SIGNAL_COLUMNS}, (SELECT action FROM journal WHERE signal_id = signals.id ORDER BY id DESC LIMIT 1) AS action
     FROM signals WHERE ${where[scope]} ORDER BY created_at DESC LIMIT 50`,
  ).all();
  return c.json({ signals: rows.results });
});

/** Сигнал повністю: аргументи аналітика і скептика, події, журнал, дані для калькулятора позиції. */
app.get("/api/signals/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const row = await db.prepare(`SELECT ${SIGNAL_COLUMNS}, reasoning, playbook_version FROM signals WHERE id = ?`).bind(id).first<Record<string, unknown> & { reasoning: string | null }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const [events, journal, settings] = await Promise.all([
    db.prepare("SELECT ts, type, price FROM signal_events WHERE signal_id = ? AND type != 'push' ORDER BY id").bind(id).all(),
    db.prepare("SELECT id, ts, action, note, entry, exit, size FROM journal WHERE signal_id = ? ORDER BY id DESC").bind(id).all(),
    db.prepare("SELECT key, value FROM settings WHERE key IN ('deposit_usd', 'risk_per_trade_pct')").all<{ key: string; value: string }>(),
  ]);
  const setting = (key: string) => {
    const v = settings.results.find((r) => r.key === key)?.value;
    return v === undefined ? null : (JSON.parse(v) as number | null);
  };
  return c.json({
    ...row,
    reasoning: row.reasoning ? JSON.parse(row.reasoning) : null,
    events: events.results,
    journal: journal.results,
    risk: { depositUsd: setting("deposit_usd"), riskPct: setting("risk_per_trade_pct") ?? 1 },
  });
});

/** Журнал: «взяв» або «пропустив», за бажанням нотатка і фактичні ціни. */
app.post("/api/signals/:id{[0-9]+}/journal", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  if (body.action !== "taken" && body.action !== "skipped") return c.json({ error: "action must be taken or skipped" }, 400);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  if (!(await c.env.DB.prepare("SELECT 1 AS x FROM signals WHERE id = ?").bind(id).first())) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("INSERT INTO journal (ts, signal_id, action, note, entry, exit, size) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(new Date().toISOString(), id, body.action, typeof body.note === "string" ? body.note.slice(0, 1000) : null, num(body.entry), num(body.exit), num(body.size))
    .run();
  return c.json({ ok: true });
});

/** Публічний ключ VAPID для підписки в браузері. */
app.get("/api/push/key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY ?? null }));

app.post("/api/push/subscribe", async (c) => {
  const sub = parseSubscription(await c.req.json().catch(() => null));
  if (!sub) return c.json({ error: "invalid subscription" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO push_subscriptions (endpoint, keys, device, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET keys = excluded.keys",
  )
    .bind(sub.endpoint, JSON.stringify(sub.keys), (c.req.header("User-Agent") ?? "").slice(0, 200), new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

app.post("/api/push/unsubscribe", async (c) => {
  const { endpoint } = await c.req.json<{ endpoint?: string }>().catch(() => ({ endpoint: undefined }));
  if (typeof endpoint !== "string") return c.json({ error: "endpoint required" }, 400);
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
  return c.json({ ok: true });
});

/** Пробне сповіщення: надсилає рушій. */
app.post("/api/push/test", async (c) => c.json(await engineStub(c.env).pushTest()));

/** Ручна перевірка доступності джерел з рушія в ЄС. */
app.post("/api/probe", async (c) => c.json(await engineStub(c.env).probe()));

/** Ручний запуск скану. 409, якщо скан уже триває. */
app.post("/api/scan", async (c) => {
  const summary = await engineStub(c.env).scanNow();
  return summary ? c.json(summary) : c.json({ error: "scan already running" }, 409);
});

/** Знімки ознак останнього скану. */
app.get("/api/snapshots/latest", async (c) => {
  const run = await c.env.DB.prepare(
    "SELECT id, started_at, status, detail FROM runs WHERE kind = 'scan' ORDER BY id DESC LIMIT 1",
  ).first<{ id: number; started_at: string; status: string; detail: string | null }>();
  if (!run) return c.json({ run: null, snapshots: [] });
  const rows = await c.env.DB.prepare("SELECT features FROM snapshots WHERE run_id = ? ORDER BY id")
    .bind(run.id)
    .all<{ features: string }>();
  return c.json({
    run: { ...run, detail: run.detail ? JSON.parse(run.detail) : null },
    snapshots: rows.results.map((r) => JSON.parse(r.features)),
  });
});

app.notFound((c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  // Cron лише будить рушій; сам назовні не ходить.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(engineStub(env).tick());
  },
} satisfies ExportedHandler<Env>;
