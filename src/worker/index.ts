import { Hono } from "hono";
import type { ReportBody } from "./engine";
import { checkAccess } from "./access";
import { engineStub, type Env } from "./env";
import { parseSubscription } from "./push";
import { SETTINGS, validatePlaybook, validateSettings } from "../shared/settings";
import { AGENTS, AI_KEYS, aiFromSettings, DEFAULT_AI, validateAi, type AgentConfig, type AiConfig, type ModelInfo } from "../shared/ai";
import { PIPELINE_AGENT } from "./llm";
import { PLAYBOOK_V1 } from "./signals/review";
import { calibration, hit, loadStats } from "./stats";

export { Engine } from "./engine";

const app = new Hono<{ Bindings: Env }>();

// Вхід: перед застосунком стоїть Cloudflare Access, а API ще й перевіряє підпис його токена.
// Без налаштованих ACCESS_TEAM_DOMAIN і ACCESS_AUD API закрите.
app.use("/api/*", async (c, next) => {
  if (c.env.DEV === "1" || c.req.path === "/api/health") return next();
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN ?? "";
  const aud = c.env.ACCESS_AUD ?? "";
  if (!teamDomain || !aud) return c.json({ error: "Cloudflare Access не налаштовано: задай ACCESS_TEAM_DOMAIN і ACCESS_AUD" }, 401);
  const token = c.req.header("Cf-Access-Jwt-Assertion") ?? /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(c.req.header("Cookie") ?? "")?.[1];
  try {
    const res = await checkAccess(token, { aud, teamDomain, loadKeys: () => engineStub(c.env).accessKeys(teamDomain) });
    if (!res.ok) return c.json({ error: `unauthorized: ${res.reason}` }, 401);
  } catch (e) {
    console.error("перевірка Access:", e);
    return c.json({ error: "не вдалося перевірити вхід" }, 503);
  }
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
  const btc = await db
    .prepare(
      "SELECT json_extract(s.features, '$.price') AS price, r.started_at AS at FROM snapshots s JOIN runs r ON r.id = s.run_id WHERE s.symbol = 'BTCUSDT' ORDER BY s.id DESC LIMIT 1",
    )
    .first<{ price: number; at: string }>();
  return c.json({
    btc,
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
  const ids = (body.newsIds ?? []).filter((n) => Number.isInteger(n)).slice(0, 20);
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
  if (kind === "weekly") {
    const res = await engineStub(c.env).weeklyNow();
    return res === null ? c.json({ error: "engine busy" }, 409) : c.json(res);
  }
  if (kind !== "morning" && kind !== "evening") return c.json({ error: "kind must be morning, evening or weekly" }, 400);
  const res = await engineStub(c.env).reportNow(kind);
  if (res === null) return c.json({ error: "engine busy" }, 409);
  return "error" in res ? c.json(res, 409) : c.json(res);
});

const SIGNAL_COLUMNS =
  "id, created_at, symbol, side, setup, entry_low, entry_high, stop, tp1, tp2, rr, p_analyst, p_skeptic, status, expires_at, result_r, fee_r, resolved_at, shadow_status, shadow_r";

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
    `SELECT ${SIGNAL_COLUMNS}, (SELECT action FROM journal WHERE signal_id = signals.id ORDER BY id DESC LIMIT 1) AS action,
       EXISTS (SELECT 1 FROM signal_events WHERE signal_id = signals.id AND type = 'tp1') AS tp1_hit
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
  // «Кожне число пояснює себе»: як часто збувались сигнали з такою самою оцінкою.
  const history = await db
    .prepare("SELECT p_analyst, p_skeptic, status, shadow_status FROM signals WHERE id != ? AND (p_analyst IS NOT NULL OR p_skeptic IS NOT NULL)")
    .bind(id)
    .all<{ p_analyst: number | null; p_skeptic: number | null; status: string; shadow_status: string | null }>();
  const similar = (key: "p_analyst" | "p_skeptic") => {
    const p = row[key] as number | null;
    if (p === null) return null;
    const from = Math.min(Math.floor(p * 10), 9) / 10;
    const pts = history.results.flatMap((h) => {
      const o = hit(h.status === "rejected" ? h.shadow_status : h.status);
      const q = h[key];
      return o === null || q === null || q < from || q >= from + 0.1 ? [] : [{ p: q, hit: o }];
    });
    const c = calibration(pts);
    return { from, to: from + 0.1, n: c.n, hits: pts.filter((x) => x.hit).length };
  };
  return c.json({
    ...row,
    similar: { analyst: similar("p_analyst"), skeptic: similar("p_skeptic") },
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

/** Статистика: period=all | 30 | 7 (днів). */
app.get("/api/stats", async (c) => {
  const period = c.req.query("period") ?? "all";
  const days = period === "all" ? null : Number(period);
  if (days !== null && ![7, 30, 90].includes(days)) return c.json({ error: "period must be all, 7, 30 or 90" }, 400);
  const now = Date.now();
  return c.json(await loadStats(c.env.DB, { from: days === null ? null : new Date(now - days * 86_400_000).toISOString(), now }));
});

/** Свічки для графіка сигналу: бере рушій (зі скану в пам'яті або з біржі). */
app.get("/api/candles/:symbol{[A-Z0-9]{2,20}USDT}", async (c) => {
  const tf = c.req.query("tf") ?? "1h";
  if (tf !== "15m" && tf !== "1h" && tf !== "4h") return c.json({ error: "tf must be 15m, 1h or 4h" }, 400);
  try {
    const candles = await engineStub(c.env).candles(c.req.param("symbol"), tf, Number(c.req.query("limit") ?? 96));
    return c.json({ candles });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

/** Налаштування: значення, схема для форми й поточна біржа. */
app.get("/api/settings", async (c) => {
  const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const values = Object.fromEntries(rows.results.map((r) => [r.key, JSON.parse(r.value)]));
  return c.json({
    values,
    schema: SETTINGS.map(({ check: _check, ...spec }) => spec),
  });
});

/** Зміна налаштувань: усе або нічого; помилки по кожному ключу. */
app.put("/api/settings", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "очікується об'єкт ключ: значення" }, 400);
  const { values, errors } = validateSettings(body);
  if (Object.keys(errors).length) return c.json({ error: "некоректні значення", errors }, 400);
  const upsert = c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const entries = Object.entries(values);
  if (entries.length) await c.env.DB.batch(entries.map(([k, v]) => upsert.bind(k, JSON.stringify(v))));
  return c.json({ ok: true, saved: entries.map(([k]) => k) });
});

/** Правила сетапів: активна версія, історія і коли можна ввімкнути наступну. */
app.get("/api/playbook", async (c) => {
  const db = c.env.DB;
  const [versions, minDays] = await Promise.all([
    db.prepare("SELECT version, created_at, active, content FROM playbook_versions ORDER BY version DESC LIMIT 20").all<{ version: number; created_at: string; active: number; content: string }>(),
    db.prepare("SELECT value FROM settings WHERE key = 'playbook_min_days'").first<{ value: string }>(),
  ]);
  const active = versions.results.find((v) => v.active === 1) ?? null;
  const days = minDays ? Number(JSON.parse(minDays.value)) : 14;
  return c.json({
    active: active ? { version: active.version, created_at: active.created_at, rules: JSON.parse(active.content) } : { version: null, created_at: null, rules: PLAYBOOK_V1 },
    versions: versions.results.map(({ content: _content, ...v }) => v),
    nextAllowedAt: active ? new Date(Date.parse(active.created_at) + days * 86_400_000).toISOString() : null,
  });
});

/** Нова версія правил: вмикає людина, не частіше ніж раз на playbook_min_days. */
app.post("/api/playbook", async (c) => {
  const db = c.env.DB;
  const parsed = validatePlaybook((await c.req.json<{ rules?: unknown }>().catch(() => ({}) as { rules?: unknown })).rules);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const [active, minDays] = await Promise.all([
    db.prepare("SELECT version, created_at FROM playbook_versions WHERE active = 1 ORDER BY version DESC LIMIT 1").first<{ version: number; created_at: string }>(),
    db.prepare("SELECT value FROM settings WHERE key = 'playbook_min_days'").first<{ value: string }>(),
  ]);
  const days = minDays ? Number(JSON.parse(minDays.value)) : 14;
  if (active && Date.now() - Date.parse(active.created_at) < days * 86_400_000) {
    return c.json({ error: `нову версію правил можна ввімкнути не раніше ${new Date(Date.parse(active.created_at) + days * 86_400_000).toISOString().slice(0, 10)}` }, 409);
  }
  const [, inserted] = await db.batch<{ version: number }>([
    db.prepare("UPDATE playbook_versions SET active = 0 WHERE active = 1"),
    db.prepare("INSERT INTO playbook_versions (created_at, content, active) VALUES (?, ?, 1) RETURNING version").bind(new Date().toISOString(), JSON.stringify(parsed.rules)),
  ]);
  return c.json({ ok: true, version: inserted!.results[0]!.version });
});

async function loadAi(db: D1Database): Promise<AiConfig> {
  const rows = await db
    .prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?)")
    .bind(AI_KEYS.agents, AI_KEYS.budgetUsd, AI_KEYS.budgetFallbackModel, AI_KEYS.dataCollection)
    .all<{ key: string; value: string }>();
  return aiFromSettings(Object.fromEntries(rows.results.map((r) => [r.key, JSON.parse(r.value)])));
}

/** Моделі для перевірки форми: каталог OpenRouter через рушій; без мережі null (перевіряється лише формат). */
async function knownModels(env: Env): Promise<{ models: ModelInfo[]; error: string | null }> {
  try {
    return { models: await engineStub(env).models(), error: null };
  } catch (e) {
    return { models: [], error: String(e) };
  }
}

/** Сторінка «Моделі ШІ»: налаштування агентів, каталог моделей, стан ключа і витрати за агентами. */
app.get("/api/ai", async (c) => {
  const db = c.env.DB;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [config, catalog, spend, key] = await Promise.all([
    loadAi(db),
    knownModels(c.env),
    db
      .prepare("SELECT pipeline, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM llm_calls WHERE ts >= ? GROUP BY pipeline")
      .bind(monthStart)
      .all<{ pipeline: string; usd: number; calls: number }>(),
    engineStub(c.env)
      .keyInfo()
      .then((info) => ({ configured: info !== null, info, error: null as string | null }))
      .catch((e) => ({ configured: true, info: null, error: String(e) })),
  ]);
  const byAgent: Record<string, { usd: number; calls: number }> = {};
  for (const row of spend.results) {
    const agent = row.pipeline === "test" ? "test" : (PIPELINE_AGENT as Record<string, string>)[row.pipeline] ?? row.pipeline;
    const cur = (byAgent[agent] ??= { usd: 0, calls: 0 });
    cur.usd += row.usd;
    cur.calls += row.calls;
  }
  return c.json({
    config,
    agents: AGENTS,
    models: catalog.models,
    modelsError: catalog.error,
    key,
    spend: { monthUsd: spend.results.reduce((s, r) => s + r.usd, 0), byAgent },
  });
});

/** Збереження налаштувань моделей. Моделі звіряються з каталогом OpenRouter. */
app.put("/api/ai", async (c) => {
  const body = await c.req.json().catch(() => null);
  const { models } = await knownModels(c.env);
  const res = validateAi(body, models.length ? new Set(models.map((m) => m.id)) : null);
  if (!res.ok) return c.json({ error: "некоректні значення", errors: res.errors }, 400);
  const upsert = c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  await c.env.DB.batch([
    upsert.bind(AI_KEYS.agents, JSON.stringify(res.config.agents)),
    upsert.bind(AI_KEYS.budgetUsd, JSON.stringify(res.config.budgetUsd)),
    upsert.bind(AI_KEYS.budgetFallbackModel, JSON.stringify(res.config.budgetFallbackModel)),
    upsert.bind(AI_KEYS.dataCollection, JSON.stringify(res.config.dataCollection)),
  ]);
  return c.json({ ok: true });
});

/** Пробний виклик агента. Можна передати незбережені налаштування з форми. Витрата пишеться в llm_calls. */
app.post("/api/ai/test", async (c) => {
  const body = await c.req.json<{ agent?: string; config?: unknown }>().catch(() => ({}) as { agent?: string; config?: unknown });
  const agent = AGENTS.find((a) => a.id === body.agent);
  if (!agent) return c.json({ error: "невідомий агент" }, 400);
  let override: AgentConfig | undefined;
  if (body.config) {
    const { models } = await knownModels(c.env);
    const res = validateAi({ ...DEFAULT_AI, agents: { ...DEFAULT_AI.agents, [agent.id]: body.config } }, models.length ? new Set(models.map((m) => m.id)) : null);
    if (!res.ok) return c.json({ ok: false, error: Object.values(res.errors).join("; ") }, 400);
    override = res.config.agents[agent.id];
  }
  return c.json(await engineStub(c.env).testAgent(agent.id, override));
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
