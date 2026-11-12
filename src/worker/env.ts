import type { Engine } from "./engine";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ENGINE: DurableObjectNamespace<Engine>;
  /** Ключ OpenRouter: усі виклики моделей. Лише через `wrangler secret put`. */
  OPENROUTER_API_KEY?: string;
  /** Cloudflare Access: домен команди (team.cloudflareaccess.com) і тег AUD застосунку. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Web Push: публічний ключ VAPID (змінна) і приватний у форматі JWK (секрет). */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** Контакт для сервісів push: mailto:… або https://… */
  VAPID_SUBJECT?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Ключ плану Demo CoinGecko; без нього працює загальний ліміт. */
  COINGECKO_API_KEY?: string;
  /** Адреса застосунку для посилань у Telegram, наприклад https://assistant.example.com */
  APP_ORIGIN?: string;
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
