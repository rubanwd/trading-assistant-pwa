import { Hono } from "hono";
import type { ChannelCycleDetail, ReportBody, TubeCycleDetail } from "./engine";
import { checkAccess } from "./access";
import { engineStub, type Env } from "./env";
import { parseSubscription } from "./push";
import { SETTINGS, validatePlaybook, validateSettings } from "../shared/settings";
import { AGENTS, AI_KEYS, aiFromSettings, DEFAULT_AI, validateAi, type AgentConfig, type AiConfig, type ModelInfo } from "../shared/ai";
import { PIPELINE_AGENT } from "./llm";
import { PLAYBOOK_DEFAULT } from "./signals/review";
import { calibration, hit, loadStats } from "./stats";
import { netR, outcome, summarize, type PickRecord } from "./pickStats";
import type { Fees } from "../shared/risk";
import { CRYPTO_LEADER, parseDesk, STOCKS_LEADER_DEFAULT, type Desk } from "../shared/desk";
import { botEnabledKey, botKeys, BOTS, CARRY_KEYS, carryConfig, TREND_KEYS, trendConfig, CHANNEL_KEYS, channelConfig, isBotId, tubeConfig, type BotId } from "../shared/bots";
import { carryNetPct } from "./bots/carry";
import { netR as tubeNetR, outcomeOf, tubeGroup, tubeSummarize, type TubeRecord } from "./bots/tubeStats";

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

/** Режим із запиту: ?desk=crypto | stocks; без нього — крипто. */
const deskOf = (c: { req: { query: (k: string) => string | undefined } }): Desk => parseDesk(c.req.query("desk"));

/** Значення налаштувань одним запитом. */
async function settingValues(db: D1Database, keys: string[]): Promise<Record<string, unknown>> {
  const rows = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  return Object.fromEntries(rows.results.map((r) => [r.key, JSON.parse(r.value) as unknown]));
}

/** Орієнтир ринку режиму: BTC або ETF індексу для акцій. */
async function leaderOf(db: D1Database, desk: Desk): Promise<string> {
  if (desk === "crypto") return CRYPTO_LEADER;
  const v = (await settingValues(db, ["stocks_benchmark"])).stocks_benchmark;
  return typeof v === "string" ? v : STOCKS_LEADER_DEFAULT;
}

/** Пульс системи для екрана «Сьогодні»: останній скан, останній звіт, витрати за місяць. */
app.get("/api/status", async (c) => {
  const db = c.env.DB;
  const desk = deskOf(c);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [last, report, spent, budget, cycle, ctx, search, opts] = await Promise.all([
    db
      .prepare("SELECT kind, started_at, status, duration_ms, detail, error FROM runs WHERE (kind = 'scan' AND desk = ?) OR kind = 'probe' ORDER BY id DESC LIMIT 1")
      .bind(desk)
      .first<{ kind: string; started_at: string; status: string; duration_ms: number; detail: string | null; error: string | null }>(),
    db.prepare("SELECT id, kind, date, body, created_at FROM reports WHERE desk = ? ORDER BY created_at DESC LIMIT 1").bind(desk).first<ReportRow>(),
    db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM llm_calls WHERE ts >= ?").bind(monthStart).first<{ usd: number }>(),
    db.prepare("SELECT value FROM settings WHERE key = 'llm_budget_usd'").first<{ value: string }>(),
    db.prepare("SELECT started_at, detail FROM runs WHERE kind = 'pipeline' ORDER BY id DESC LIMIT 1").first<{ started_at: string; detail: string }>(),
    // Фон ринку крипто (страх і жадібність, домінація BTC) з останнього звіту: рушій бере його лише для звітів.
    desk === "crypto"
      ? db
          .prepare("SELECT json_extract(body, '$.context') AS context, created_at AS at FROM reports WHERE desk = 'crypto' AND kind IN ('morning', 'evening') ORDER BY created_at DESC LIMIT 1")
          .first<{ context: string | null; at: string }>()
      : Promise.resolve(null),
    // Останній пошук сетапів: шукаємо лише на свіжій свічці 4h, тож беремо останній запуск, де пошук справді був.
    db
      .prepare("SELECT started_at, detail FROM runs WHERE kind = 'signals' AND desk = ? AND json_extract(detail, '$.detection') = 1 ORDER BY id DESC LIMIT 1")
      .bind(desk)
      .first<{ started_at: string; detail: string }>(),
    settingValues(db, ["stocks_enabled", "stocks_benchmark"]),
  ]);
  const leader = desk === "crypto" ? CRYPTO_LEADER : typeof opts.stocks_benchmark === "string" ? opts.stocks_benchmark : STOCKS_LEADER_DEFAULT;
  // Запас до ліміту безкоштовного плану: найбільша кількість зовнішніх запитів за один крок циклу.
  const steps = cycle ? ((JSON.parse(cycle.detail) as { steps?: { requests: number; error?: string }[] }).steps ?? []) : [];
  const price = await db
    .prepare(
      "SELECT json_extract(s.features, '$.price') AS price, r.started_at AS at FROM snapshots s JOIN runs r ON r.id = s.run_id WHERE s.symbol = ? ORDER BY s.id DESC LIMIT 1",
    )
    .bind(leader)
    .first<{ price: number; at: string }>();
  return c.json({
    desk,
    enabled: desk === "crypto" || opts.stocks_enabled !== "off",
    leader: { symbol: leader, price: price?.price ?? null, at: price?.at ?? null },
    lastRun: last ? { ...last, detail: last.detail ? JSON.parse(last.detail) : null } : null,
    lastReport: report ? reportCard(report) : null,
    context: ctx?.context ? { ...(JSON.parse(ctx.context) as object), at: ctx.at } : null,
    spend: { monthUsd: spent?.usd ?? 0, budgetUsd: budget ? Number(JSON.parse(budget.value)) : null },
    cycle: cycle
      ? { at: cycle.started_at, steps: steps.length, maxRequests: Math.max(0, ...steps.map((x) => x.requests)), failed: steps.filter((x) => x.error).length }
      : null,
    search: search ? searchCard(search.started_at, search.detail) : null,
  });
});

/** Підсумок пошуку сетапів для пульсу: де зупинились кандидати й що сказав рушій про помилки. */
function searchCard(at: string, detail: string) {
  const d = JSON.parse(detail) as { detected?: number; filtered?: Record<string, number>; reviewed?: number; published?: number; rejected?: number; notes?: string[] };
  return {
    at,
    detected: d.detected ?? 0,
    filtered: d.filtered ?? {},
    reviewed: d.reviewed ?? 0,
    published: d.published ?? 0,
    rejected: d.rejected ?? 0,
    notes: (d.notes ?? []).slice(0, 5),
  };
}

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
  const rows = await c.env.DB.prepare("SELECT id, kind, date, body, created_at FROM reports WHERE desk = ? ORDER BY created_at DESC LIMIT 30")
    .bind(deskOf(c))
    .all<ReportRow>();
  return c.json({ reports: rows.results.map(reportCard) });
});

/** Звіт повністю: тіло, прогнози з результатами, новини, які врахував автор. */
app.get("/api/reports/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const row = await db
    .prepare("SELECT id, desk, kind, date, body, model, cost_usd, created_at FROM reports WHERE id = ?")
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
  const desk = deskOf(c);
  if (kind === "weekly") {
    const res = await engineStub(c.env).weeklyNow(desk);
    return res === null ? c.json({ error: "engine busy" }, 409) : c.json(res);
  }
  if (kind !== "morning" && kind !== "evening") return c.json({ error: "kind must be morning, evening or weekly" }, 400);
  const res = await engineStub(c.env).reportNow(kind, desk);
  if (res === null) return c.json({ error: "engine busy" }, 409);
  return "error" in res ? c.json(res, 409) : c.json(res);
});

const SIGNAL_COLUMNS =
  "id, desk, created_at, symbol, side, setup, entry_low, entry_high, stop, tp1, tp2, rr, p_analyst, p_skeptic, status, expires_at, result_r, fee_r, resolved_at, shadow_status, shadow_r, hit, shadow_hit";

/** Сигнали: open (позиція відкрита), closed (із результатом), rejected (відхилені моделлю). */
app.get("/api/signals", async (c) => {
  const where: Record<string, string> = {
    open: "status IN ('pending', 'active')",
    closed: "status IN ('exited', 'stopped', 'tp1', 'tp2', 'expired')",
    rejected: "status = 'rejected'",
  };
  const scope = c.req.query("scope") ?? "open";
  if (!where[scope]) return c.json({ error: "scope must be open, closed or rejected" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT ${SIGNAL_COLUMNS}, (SELECT action FROM journal WHERE signal_id = signals.id ORDER BY id DESC LIMIT 1) AS action
     FROM signals WHERE desk = ? AND ${where[scope]} ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(deskOf(c))
    .all();
  return c.json({ signals: rows.results });
});

/** Сигнал повністю: аргументи аналітика і скептика, події, журнал, дані для калькулятора позиції. */
app.get("/api/signals/:id{[0-9]+}", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const row = await db.prepare(`SELECT ${SIGNAL_COLUMNS}, reasoning, playbook_version FROM signals WHERE id = ?`).bind(id).first<Record<string, unknown> & { reasoning: string | null }>();
  if (!row) return c.json({ error: "not found" }, 404);
  const [events, journal, settings] = await Promise.all([
    db.prepare("SELECT ts, type, price FROM signal_events WHERE signal_id = ? AND type NOT IN ('push', 'push_position') ORDER BY id").bind(id).all(),
    db.prepare("SELECT id, ts, action, note, entry, exit, size FROM journal WHERE signal_id = ? ORDER BY id DESC").bind(id).all(),
    db.prepare("SELECT key, value FROM settings WHERE key IN ('deposit_usd', 'risk_per_trade_pct')").all<{ key: string; value: string }>(),
  ]);
  const setting = (key: string) => {
    const v = settings.results.find((r) => r.key === key)?.value;
    return v === undefined ? null : (JSON.parse(v) as number | null);
  };
  // «Кожне число пояснює себе»: як часто збувались сигнали з такою самою оцінкою.
  const history = await db
    .prepare("SELECT p_analyst, p_skeptic, status, hit, shadow_hit FROM signals WHERE id != ? AND desk = ? AND (p_analyst IS NOT NULL OR p_skeptic IS NOT NULL)")
    .bind(id, row.desk)
    .all<{ p_analyst: number | null; p_skeptic: number | null; status: string; hit: number | null; shadow_hit: number | null }>();
  const similar = (key: "p_analyst" | "p_skeptic") => {
    const p = row[key] as number | null;
    if (p === null) return null;
    const from = Math.min(Math.floor(p * 10), 9) / 10;
    const pts = history.results.flatMap((h) => {
      const o = hit(h);
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
    risk: { depositUsd: setting("deposit_usd"), riskPct: setting("risk_per_trade_pct") ?? 0.5 },
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
  const desk = deskOf(c);
  return c.json(
    await loadStats(c.env.DB, { from: days === null ? null : new Date(now - days * 86_400_000).toISOString(), now, desk, leader: await leaderOf(c.env.DB, desk) }),
  );
});

/** Свічки для графіка сигналу: бере рушій (зі скану в пам'яті або з біржі). */
app.get("/api/candles/:symbol{[A-Z0-9]{2,20}USDT}", async (c) => {
  const tf = c.req.query("tf") ?? "1h";
  if (tf !== "15m" && tf !== "1h" && tf !== "4h" && tf !== "1d") return c.json({ error: "tf must be 15m, 1h, 4h or 1d" }, 400);
  try {
    const candles = await engineStub(c.env).candles(c.req.param("symbol"), tf, Number(c.req.query("limit") ?? 96), deskOf(c));
    return c.json({ candles });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

/** Налаштування: значення, схема для форми й поточна біржа. */
app.get("/api/settings", async (c) => {
  const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const values = Object.fromEntries(rows.results.map((r) => [r.key, JSON.parse(r.value)]));
  // Контракти Bybit на акції: щоб у формі було видно, які символи справді є. Збій не заважає формі.
  const stockSymbols = await engineStub(c.env)
    .stockSymbols()
    .catch((e) => (console.error("контракти на акції:", e), null));
  return c.json({
    values,
    schema: SETTINGS.map(({ check: _check, ...spec }) => spec),
    stockSymbols,
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
    active: active ? { version: active.version, created_at: active.created_at, rules: JSON.parse(active.content) } : { version: null, created_at: null, rules: PLAYBOOK_DEFAULT },
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

interface PickRow {
  id: number;
  created_at: string;
  symbol: string;
  side: "long" | "short";
  entry_kind: "market" | "pullback";
  price: number;
  entry: number;
  stop: number;
  target: number;
  score: number;
  verdict: "pick" | "pass" | "none";
  probability: number | null;
  model: string | null;
  horizon_hours: number;
  is_repeat: number;
  body: string;
  status: "open" | "target" | "stop" | "expired" | "unfilled";
  result_r: number | null;
  filled_at: string | null;
  resolved_at: string | null;
}

/** Ідеї без повторів за період, кожна з кількістю повторів поспіль. */
const PICK_LIST = `
  SELECT p.id, p.created_at, p.symbol, p.side, p.entry_kind, p.entry, p.stop, p.target, p.score, p.verdict, p.probability,
         p.status, p.result_r, p.resolved_at,
         (SELECT COUNT(*) FROM picks r WHERE r.is_repeat = 1 AND r.id > p.id
            AND r.id < COALESCE((SELECT MIN(n.id) FROM picks n WHERE n.is_repeat = 0 AND n.id > p.id), 9e18)) AS repeats
  FROM picks p WHERE p.desk = ? AND p.is_repeat = 0 AND p.created_at >= ? ORDER BY p.id DESC LIMIT ?`;

async function pickFees(db: D1Database): Promise<Fees> {
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('fee_maker_pct', 'fee_taker_pct')").all<{ key: string; value: string }>();
  const get = (key: string, fallback: number) => {
    const v = Number(JSON.parse(rows.results.find((r) => r.key === key)?.value ?? "null"));
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return { makerPct: get("fee_maker_pct", 0.02), takerPct: get("fee_taker_pct", 0.05) };
}

/** Ідея скану для екрана «Сьогодні»: остання ідея повністю, попередні коротко й підсумок за 30 днів. */
app.get("/api/pick", async (c) => {
  const db = c.env.DB;
  const desk = deskOf(c);
  const since = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
  const [latest, list, fees] = await Promise.all([
    db.prepare("SELECT * FROM picks WHERE desk = ? ORDER BY id DESC LIMIT 1").bind(desk).first<PickRow>(),
    db.prepare(PICK_LIST).bind(desk, since, 1000).all<PickRecord>(),
    pickFees(db),
  ]);
  const summary = summarize(list.results, fees);
  return c.json({
    latest: latest ? { ...latest, body: JSON.parse(latest.body) } : null,
    recent: list.results.slice(0, 12),
    stats: { ai: summary.byVerdict.pick, all: summary.all },
  });
});

/**
 * Історія й облік ідей скану: кожна ідея з результатом (після комісій) і підсумки.
 * period=all | 7 | 30 | 90 (днів), verdict=all | pick | pass | none. Повтори в окремі ідеї не йдуть.
 */
app.get("/api/picks", async (c) => {
  const period = c.req.query("period") ?? "all";
  const days = period === "all" ? null : Number(period);
  if (days !== null && ![7, 30, 90].includes(days)) return c.json({ error: "period must be all, 7, 30 or 90" }, 400);
  const db = c.env.DB;
  const since = days === null ? "" : new Date(Date.now() - days * 86_400_000).toISOString();
  const verdict = c.req.query("verdict") ?? "all";
  if (!["all", "pick", "pass", "none"].includes(verdict)) return c.json({ error: "verdict must be all, pick, pass or none" }, 400);
  const [list, fees] = await Promise.all([db.prepare(PICK_LIST).bind(deskOf(c), since, 2000).all<PickRecord>(), pickFees(db)]);
  const rows = verdict === "all" ? list.results : list.results.filter((r) => r.verdict === verdict);
  return c.json({
    from: since || null,
    fees,
    summary: summarize(rows, fees),
    picks: rows.map((r) => ({ ...r, outcome: outcome(r), net_r: netR(r, fees) })),
  });
});

/** Одна ідея з поясненням ШІ й ознаками балу. */
app.get("/api/picks/:id{[0-9]+}", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM picks WHERE id = ?").bind(Number(c.req.param("id"))).first<PickRow>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ ...row, body: JSON.parse(row.body) });
});

// ── Боти ───────────────────────────────────────────────────────────────────

/** Ордери бота за період, від нових. Зняті без виконання ордери зберігаються лише retention_days. */
const BOT_ORDERS = `
  SELECT id, created_at, symbol, side, bias, near, rank, price, entry, stop, target, trail_stop, status, filled_at, resolved_at, exit_price, result_r, fee_r
  FROM bot_orders WHERE bot = ? AND created_at >= ? ORDER BY id DESC LIMIT ?`;

/** Останні години бота з журналу запусків. */
async function botCycles(db: D1Database, id: BotId, limit: number): Promise<{ at: string; status: string; error: string | null; detail: TubeCycleDetail & Partial<ChannelCycleDetail> }[]> {
  const rows = await db
    .prepare("SELECT started_at, status, error, detail FROM runs WHERE kind = 'bot' AND json_extract(detail, '$.bot') = ? ORDER BY id DESC LIMIT ?")
    .bind(id, limit)
    .all<{ started_at: string; status: string; error: string | null; detail: string }>();
  return rows.results.map((r) => ({ at: r.started_at, status: r.status, error: r.error, detail: JSON.parse(r.detail) as TubeCycleDetail & Partial<ChannelCycleDetail> }));
}

interface CarryRow {
  id: number;
  opened_at: string;
  symbol: string;
  share: number;
  entry_apr: number;
  entry_price: number | null;
  status: "open" | "closed";
  closed_at: string | null;
  exit_apr: number | null;
  exit_price: number | null;
  funding: number;
  payments: number;
  last_funding_at: string | null;
  fee: number;
  reason: string | null;
}

/** Підсумок Funding Carry за дні з carry_days, % капіталу бота. since — YYYY-MM-DD або "" для всього часу. */
async function carryPeriod(db: D1Database, since: string): Promise<{ days: number; fundingPct: number; feePct: number; netPct: number; aprPct: number | null; busyDays: number }> {
  const r = await db
    .prepare("SELECT COUNT(*) AS days, COALESCE(SUM(funding_pct), 0) AS funding, COALESCE(SUM(fee_pct), 0) AS fee, COALESCE(SUM(positions > 0), 0) AS busy, MIN(day) AS first FROM carry_days WHERE day >= ?")
    .bind(since)
    .first<{ days: number; funding: number; fee: number; busy: number; first: string | null }>();
  const days = r?.days ?? 0;
  const net = (r?.funding ?? 0) - (r?.fee ?? 0);
  const r4 = (v: number) => Number(v.toFixed(4));
  return { days, fundingPct: r4(r?.funding ?? 0), feePct: r4(r?.fee ?? 0), netPct: r4(net), aprPct: days >= 7 ? Number(((net / days) * 365).toFixed(2)) : null, busyDays: r?.busy ?? 0 };
}

/** Сторінка Funding Carry: налаштування, остання доба, відкриті й закриті позиції, підсумки за період. */
async function carryPage(db: D1Database, days: number | null) {
  const since = days === null ? "" : new Date(Date.now() - days * 86_400_000).toISOString();
  const keys = [...Object.values(CARRY_KEYS), botEnabledKey("carry"), "fee_taker_pct"];
  const [values, cycles, period, rows] = await Promise.all([
    settingValues(db, keys),
    botCycles(db, "carry", 30),
    carryPeriod(db, since.slice(0, 10)),
    db.prepare("SELECT * FROM carry_positions WHERE status = 'open' OR closed_at >= ? ORDER BY id DESC LIMIT 500").bind(since).all<CarryRow>(),
  ]);
  const withNet = rows.results.map((r) => ({ ...r, net_pct: Number(carryNetPct(r).toFixed(4)) }));
  const closed = withNet.filter((r) => r.status === "closed");
  return {
    bot: BOTS.find((b) => b.id === "carry"),
    enabled: values[botEnabledKey("carry")] !== "off",
    config: carryConfig(values),
    takerPct: typeof values.fee_taker_pct === "number" ? values.fee_taker_pct : 0.05,
    from: since || null,
    last: cycles[0] ?? null,
    cycles: cycles.map((x) => ({ at: x.at, status: x.status, error: x.error, detail: x.detail })),
    period,
    open: withNet.filter((r) => r.status === "open"),
    closed,
    closedSummary: {
      count: closed.length,
      wins: closed.filter((r) => r.net_pct > 0).length,
      netPct: Number(closed.reduce((sum, r) => sum + r.net_pct, 0).toFixed(4)),
    },
  };
}

interface TrendRow {
  id: number;
  symbol: string;
  side: "long" | "short";
  opened_at: string;
  closed_at: string | null;
  status: "open" | "closed";
  entry_price: number;
  entry_weight: number;
  units: number;
  last_price: number;
  exit_price: number | null;
  pnl: number;
  fee: number;
  funding: number;
  resizes: number;
  reason: string | null;
}

/** Підсумок Trend Basket за дні з trend_days, % капіталу бота. */
async function trendPeriod(db: D1Database, since: string) {
  const r = await db
    .prepare(
      "SELECT COUNT(*) AS days, COALESCE(SUM(pnl_pct), 0) AS pnl, COALESCE(SUM(fee_pct), 0) AS fee, COALESCE(SUM(funding_pct), 0) AS funding, COALESCE(AVG(exposure), 0) AS exposure FROM trend_days WHERE day >= ?",
    )
    .bind(since)
    .first<{ days: number; pnl: number; fee: number; funding: number; exposure: number }>();
  const days = r?.days ?? 0;
  const net = (r?.pnl ?? 0) - (r?.fee ?? 0) + (r?.funding ?? 0);
  const r4 = (v: number) => Number(v.toFixed(4));
  return { days, pnlPct: r4(r?.pnl ?? 0), feePct: r4(r?.fee ?? 0), fundingPct: r4(r?.funding ?? 0), netPct: r4(net), aprPct: days >= 7 ? Number(((net / days) * 365).toFixed(2)) : null, exposure: r4(r?.exposure ?? 0) };
}

/** Денна крива Trend Basket: накопичений результат, % капіталу. */
async function trendCurve(db: D1Database, since: string) {
  const rows = await db.prepare("SELECT day, pnl_pct + funding_pct - fee_pct AS net, exposure FROM trend_days WHERE day >= ? ORDER BY day").bind(since).all<{ day: string; net: number; exposure: number }>();
  let sum = 0;
  return rows.results.map((r) => ({ day: r.day, net: Number((sum += r.net).toFixed(4)), exposure: r.exposure }));
}

/** Сторінка Trend Basket: налаштування, остання доба, позиції, епізоди, підсумки й крива за період. */
async function trendPage(db: D1Database, days: number | null) {
  const since = days === null ? "" : new Date(Date.now() - days * 86_400_000).toISOString();
  const keys = [...Object.values(TREND_KEYS), botEnabledKey("trend"), "fee_taker_pct"];
  const [values, cycles, period, curve, rows] = await Promise.all([
    settingValues(db, keys),
    botCycles(db, "trend", 30),
    trendPeriod(db, since.slice(0, 10)),
    trendCurve(db, since.slice(0, 10)),
    db.prepare("SELECT * FROM trend_holdings WHERE status = 'open' OR closed_at >= ? ORDER BY id DESC LIMIT 500").bind(since).all<TrendRow>(),
  ]);
  const withNet = rows.results.map((r) => ({ ...r, weight: r.units * r.last_price, net_pct: Number(((r.pnl - r.fee + r.funding) * 100).toFixed(4)) }));
  const closed = withNet.filter((r) => r.status === "closed");
  return {
    bot: BOTS.find((b) => b.id === "trend"),
    enabled: values[botEnabledKey("trend")] !== "off",
    config: trendConfig(values),
    takerPct: typeof values.fee_taker_pct === "number" ? values.fee_taker_pct : 0.05,
    from: since || null,
    last: cycles[0] ?? null,
    cycles: cycles.map((x) => ({ at: x.at, status: x.status, error: x.error, detail: x.detail })),
    period,
    curve,
    open: withNet.filter((r) => r.status === "open"),
    closed,
    closedSummary: { count: closed.length, wins: closed.filter((r) => r.net_pct > 0).length, netPct: Number(closed.reduce((sum, r) => sum + r.net_pct, 0).toFixed(4)) },
  };
}

/** Список ботів: назва, стан і підсумок за 30 днів. */
app.get("/api/bots", async (c) => {
  const db = c.env.DB;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const opts = await settingValues(db, BOTS.map((b) => botEnabledKey(b.id)));
  const bots = await Promise.all(
    BOTS.map(async (b) => {
      if (b.id === "trend") {
        const [period, open, cycles] = await Promise.all([
          trendPeriod(db, since.slice(0, 10)),
          db.prepare("SELECT symbol, units * last_price AS weight FROM trend_holdings WHERE status = 'open' ORDER BY id").all<{ symbol: string; weight: number }>(),
          botCycles(db, b.id, 1),
        ]);
        const last = cycles[0] ?? null;
        return {
          ...b,
          enabled: opts[botEnabledKey(b.id)] !== "off",
          trend: { ...period, open: open.results.map((r) => r.symbol), weight: Number(open.results.reduce((sum, r) => sum + Math.abs(r.weight), 0).toFixed(4)) },
          lastCycle: last ? { at: last.at, bias: null, chosen: last.detail.chosen, placed: last.detail.placed, open: last.detail.open, note: last.detail.note } : null,
        };
      }
      if (b.id === "carry") {
        const [period, open, cycles] = await Promise.all([
          carryPeriod(db, since.slice(0, 10)),
          db.prepare("SELECT symbol FROM carry_positions WHERE status = 'open' ORDER BY id").all<{ symbol: string }>(),
          botCycles(db, b.id, 1),
        ]);
        const last = cycles[0] ?? null;
        return {
          ...b,
          enabled: opts[botEnabledKey(b.id)] !== "off",
          carry: { ...period, open: open.results.map((r) => r.symbol) },
          lastCycle: last ? { at: last.at, bias: null, chosen: last.detail.chosen, placed: last.detail.placed, open: last.detail.open, note: last.detail.note } : null,
        };
      }
      const [rows, cycles] = await Promise.all([db.prepare(BOT_ORDERS).bind(b.id, since, 20000).all<TubeRecord>(), botCycles(db, b.id, 1)]);
      const last = cycles[0] ?? null;
      return {
        ...b,
        enabled: opts[botEnabledKey(b.id)] !== "off",
        stats30: tubeGroup(rows.results),
        lastCycle: last ? { at: last.at, bias: last.detail.bias, chosen: last.detail.chosen, placed: last.detail.placed, open: last.detail.open, note: last.detail.note } : null,
      };
    }),
  );
  return c.json({ bots });
});

/**
 * Сторінка бота: налаштування, остання година (рейтинг монет, напрямок ринку), робочі ордери й позиції,
 * підсумки й угоди за період. period=all | 7 | 30 | 90 (днів).
 */
app.get("/api/bots/:id", async (c) => {
  const id = c.req.param("id");
  if (!isBotId(id)) return c.json({ error: "not found" }, 404);
  const period = c.req.query("period") ?? "all";
  const days = period === "all" ? null : Number(period);
  if (days !== null && ![7, 30, 90].includes(days)) return c.json({ error: "period must be all, 7, 30 or 90" }, 400);
  const db = c.env.DB;
  if (id === "carry") return c.json(await carryPage(db, days));
  if (id === "trend") return c.json(await trendPage(db, days));
  const since = days === null ? "" : new Date(Date.now() - days * 86_400_000).toISOString();
  const channel = id === "c2010";
  const keys = [...Object.values(channel ? CHANNEL_KEYS : botKeys(id)), botEnabledKey(id), "risk_per_trade_pct", "deposit_usd", "fee_maker_pct", "fee_taker_pct"];
  const [rows, cycles, values, active] = await Promise.all([
    db.prepare(BOT_ORDERS).bind(id, since, 50000).all<TubeRecord>(),
    // Channel 20/10 торгує раз на кілька днів: журнал довший, щоб у ньому були денні сигнали.
    botCycles(db, id, channel ? 72 : 24),
    settingValues(db, keys),
    db.prepare("SELECT * FROM bot_orders WHERE bot = ? AND status IN ('pending', 'open') ORDER BY rank, symbol, side").bind(id).all<TubeRecord & { body: string }>(),
  ]);
  const trades = rows.results.filter((r) => r.filled_at !== null);
  return c.json({
    bot: BOTS.find((b) => b.id === id),
    enabled: values[botEnabledKey(id)] !== "off",
    config: channel ? channelConfig(values) : tubeConfig(values, id),
    riskPct: typeof values.risk_per_trade_pct === "number" ? values.risk_per_trade_pct : 0.5,
    depositUsd: typeof values.deposit_usd === "number" ? values.deposit_usd : null,
    from: since || null,
    last: cycles[0] ?? null,
    cycles: cycles.map((x) => ({
      at: x.at, status: x.status, error: x.error, bias: x.detail.bias, chosen: x.detail.chosen, placed: x.detail.placed, resolved: x.detail.resolved, open: x.detail.open, note: x.detail.note,
      ...(channel ? { signal: x.detail.signal ?? null, trailed: x.detail.trailed ?? [], errors: x.detail.errors ?? [] } : {}),
    })),
    active: active.results.map((r) => ({ ...r, body: JSON.parse(r.body) })),
    summary: tubeSummarize(rows.results),
    trades: trades.map((r) => ({ ...r, outcome: outcomeOf(r), net_r: tubeNetR(r) })),
  });
});

/** Один ордер бота з ознаками монети в момент постановки. */
app.get("/api/bots/:id/orders/:order{[0-9]+}", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM bot_orders WHERE bot = ? AND id = ?")
    .bind(c.req.param("id"), Number(c.req.param("order")))
    .first<TubeRecord & { body: string }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ ...row, body: JSON.parse(row.body), outcome: outcomeOf(row), net_r: tubeNetR(row) });
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
  const res = await engineStub(c.env).scanNow();
  return res.queued ? c.json(res) : c.json({ error: "scan already running" }, 409);
});

/** Знімки ознак останнього скану. */
app.get("/api/snapshots/latest", async (c) => {
  const run = await c.env.DB.prepare(
    "SELECT id, started_at, status, detail FROM runs WHERE kind = 'scan' AND desk = ? ORDER BY id DESC LIMIT 1",
  )
    .bind(deskOf(c))
    .first<{ id: number; started_at: string; status: string; detail: string | null }>();
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
