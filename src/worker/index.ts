import { Hono } from "hono";
import { engineStub, type Env } from "./env";

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

/** Пульс системи для екрана «Сьогодні». */
app.get("/api/status", async (c) => {
  const last = await c.env.DB.prepare(
    "SELECT kind, started_at, status, duration_ms, detail, error FROM runs ORDER BY id DESC LIMIT 1",
  ).first<{ kind: string; started_at: string; status: string; duration_ms: number; detail: string | null; error: string | null }>();
  return c.json({
    lastRun: last ? { ...last, detail: last.detail ? JSON.parse(last.detail) : null } : null,
  });
});

/** Ручна перевірка доступності джерел з рушія в ЄС. */
app.post("/api/probe", async (c) => c.json(await engineStub(c.env).probe()));

app.notFound((c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  // Cron лише будить рушій; сам назовні не ходить.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(engineStub(env).tick());
  },
} satisfies ExportedHandler<Env>;
