import type { Engine } from "./engine";

export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  ENGINE: DurableObjectNamespace<Engine>;
  TIMEZONE: string;
  /** Напр. `myteam.cloudflareaccess.com`. Порожньо = перевірку Access вимкнено (лише локально). */
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Секрет: `wrangler secret put ANTHROPIC_API_KEY`. */
  ANTHROPIC_API_KEY?: string;
};

/** Єдиний екземпляр рушія, закріплений у ЄС. */
export const engine = (env: Env) => {
  const eu = env.ENGINE.jurisdiction("eu");
  return eu.get(eu.idFromName("main"));
};
