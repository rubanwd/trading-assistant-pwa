import { buildPushHTTPRequest } from "@pushforge/builder";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PushMessage {
  title: string;
  body: string;
  /** Шлях у застосунку, який відкриє дотик до сповіщення. */
  url: string;
  tag?: string;
}

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushConfig {
  /** Приватний ключ VAPID у форматі JWK (рядок JSON). */
  vapidPrivateKey?: string;
  /** Контакт для сервісів push: mailto: або https:. */
  vapidSubject?: string;
  telegramToken?: string;
  telegramChatId?: string;
}

export interface PushOutcome {
  webPush: { sent: number; failed: number; expired: string[] };
  telegram: "sent" | "failed" | "off";
  errors: string[];
}

/** Перевірка підписки з браузера перед записом у базу. */
export function parseSubscription(raw: unknown): StoredSubscription | null {
  const s = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!s || typeof s.endpoint !== "string" || typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") {
    return null;
  }
  try {
    if (new URL(s.endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (s.endpoint.length > 1000 || s.keys.p256dh.length > 200 || s.keys.auth.length > 100) return null;
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

/**
 * Надсилає сповіщення у Web Push і дублює в Telegram. Викликається лише з рушія.
 * Підписки, які сервіс push оголосив недійсними (404, 410), повертаються в expired.
 */
export async function sendPush(
  fetcher: FetchLike,
  config: PushConfig,
  subscriptions: StoredSubscription[],
  message: PushMessage,
  appOrigin?: string,
): Promise<PushOutcome> {
  const out: PushOutcome = { webPush: { sent: 0, failed: 0, expired: [] }, telegram: "off", errors: [] };

  if (subscriptions.length && config.vapidPrivateKey && config.vapidSubject) {
    let privateJWK: JsonWebKey | null = null;
    try {
      privateJWK = JSON.parse(config.vapidPrivateKey) as JsonWebKey;
    } catch {
      out.errors.push("VAPID_PRIVATE_KEY не є JSON у форматі JWK");
    }
    if (privateJWK) {
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            const req = await buildPushHTTPRequest({
              privateJWK: privateJWK as never,
              subscription,
              message: { payload: message as never, adminContact: config.vapidSubject!, options: { ttl: 6 * 3600 } },
            });
            const res = await fetcher(req.endpoint, {
              method: "POST",
              headers: req.headers as HeadersInit,
              body: req.body,
              signal: AbortSignal.timeout(10_000),
            });
            await res.body?.cancel();
            if (res.ok) out.webPush.sent++;
            else if (res.status === 404 || res.status === 410) out.webPush.expired.push(subscription.endpoint);
            else {
              out.webPush.failed++;
              out.errors.push(`web push: HTTP ${res.status}`);
            }
          } catch (e) {
            out.webPush.failed++;
            out.errors.push(`web push: ${String(e)}`);
          }
        }),
      );
    }
  }

  if (config.telegramToken && config.telegramChatId) {
    try {
      const link = appOrigin ? `\n${appOrigin}${message.url}` : "";
      const res = await fetcher(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text: `${message.title}\n${message.body}${link}`,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel();
      out.telegram = res.ok ? "sent" : "failed";
      if (!res.ok) out.errors.push(`telegram: HTTP ${res.status}`);
    } catch {
      // Текст помилки fetch може містити адресу з токеном, тому в журнал він не йде.
      out.telegram = "failed";
      out.errors.push("telegram: запит не вдався");
    }
  }
  return out;
}
