import { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { engine, type Env } from "./env";

export { Engine } from "./engine";

const app = new Hono<{ Bindings: Env }>();

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** Перевірка токена Cloudflare Access на кожному запиті до API. */
app.use("/api/*", async (c, next) => {
  const { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud } = c.env;
  if (!team || !aud) return next(); // локальна розробка
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.json({ error: "unauthorized" }, 401);
  try {
    jwks ??= createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    await jwtVerify(token, jwks, { issuer: `https://${team}`, audience: aud });
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

/** Пульс системи для екрана «Сьогодні». */
app.get("/api/status", async (c) => {
  const lastScan = await c.env.DB.prepare(
    "SELECT started_at, status, duration_ms, candidates, error FROM runs WHERE kind='scan' ORDER BY id DESC LIMIT 1",
  ).first();
  const active = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM signals WHERE status IN ('pending','active')",
  ).first<{ n: number }>();
  const spend = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(cost_usd),0) AS usd FROM llm_calls WHERE ts >= strftime('%Y-%m-01T00:00:00Z','now')",
  ).first<{ usd: number }>();
  return c.json({
    lastScan,
    activeSignals: active?.n ?? 0,
    llmSpendUsd: spend?.usd ?? 0,
  });
});

/** Тест доступності Binance і Claude API з рушія в ЄС. */
app.post("/api/probe", async (c) => c.json(await engine(c.env).probe()));

app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

export default {
  fetch: app.fetch,
  /** Розклад лише будить рушій: назовні звідси нічого не йде. */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(engine(env).tick());
  },
} satisfies ExportedHandler<Env>;
