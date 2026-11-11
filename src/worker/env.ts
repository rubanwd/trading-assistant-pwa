import type { Engine } from "./engine";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ENGINE: DurableObjectNamespace<Engine>;
  ANTHROPIC_API_KEY?: string;
  DEV?: string;
}

/**
 * Єдиний екземпляр рушія. Юрисдикція eu: виконується лише в ЄС.
 * Локальний workerd юрисдикцій не підтримує, тому з DEV=1 беремо звичайний простір імен.
 */
export function engineStub(env: Env) {
  const ns = env.DEV === "1" ? env.ENGINE : env.ENGINE.jurisdiction("eu");
  return ns.get(ns.idFromName("main"));
}
