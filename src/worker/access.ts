/**
 * Перевірка токена Cloudflare Access (RS256) на Web Crypto.
 * Ключі команди бере рушій: усі серверні запити назовні йдуть лише з нього.
 */

export interface AccessJwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

export type AccessResult = { ok: true; email: string | null } | { ok: false; reason: string; unknownKey?: boolean };

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

function json(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64url(part))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Домен команди Access: лише *.cloudflareaccess.com, щоб змінна не могла направити запит деінде. */
export const isTeamDomain = (d: string) => /^[a-z0-9-]{1,63}\.cloudflareaccess\.com$/.test(d);

export async function verifyAccessJwt(
  token: string,
  opts: { keys: AccessJwk[]; aud: string; teamDomain: string; now: number },
): Promise<AccessResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "некоректний токен" };
  const [h, p, sig] = parts as [string, string, string];
  const header = json(h);
  const payload = json(p);
  if (!header || !payload) return { ok: false, reason: "некоректний токен" };
  if (header.alg !== "RS256") return { ok: false, reason: "непідтримуваний алгоритм" };
  const jwk = opts.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "невідомий ключ", unknownKey: true };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "підпис не збігається" };

  const now = opts.now / 1000;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(opts.aud)) return { ok: false, reason: "токен для іншого застосунку" };
  if (payload.iss !== `https://${opts.teamDomain}`) return { ok: false, reason: "токен іншої команди" };
  if (typeof payload.exp !== "number" || payload.exp < now - 60) return { ok: false, reason: "токен прострочено" };
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return { ok: false, reason: "токен ще не дійсний" };
  return { ok: true, email: typeof payload.email === "string" ? payload.email : null };
}

/** Кеш ключів у межах ізолята Worker: щоб не питати рушій на кожен запит. */
let cache: { keys: AccessJwk[]; at: number } | null = null;
const CACHE_MS = 10 * 60_000;

export async function checkAccess(
  token: string | undefined,
  opts: { aud: string; teamDomain: string; loadKeys: () => Promise<AccessJwk[]>; now?: number },
): Promise<AccessResult> {
  if (!token) return { ok: false, reason: "немає токена Access" };
  // Сміття відкидаємо до запиту ключів, щоб не навантажувати рушій.
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return { ok: false, reason: "некоректний токен" };
  const now = opts.now ?? Date.now();
  if (!cache || now - cache.at > CACHE_MS) cache = { keys: await opts.loadKeys(), at: now };
  let res = await verifyAccessJwt(token, { keys: cache.keys, aud: opts.aud, teamDomain: opts.teamDomain, now });
  if (!res.ok && res.unknownKey) {
    // Ключі ротуються: один раз оновлюємо й перевіряємо знову.
    cache = { keys: await opts.loadKeys(), at: now };
    res = await verifyAccessJwt(token, { keys: cache.keys, aud: opts.aud, teamDomain: opts.teamDomain, now });
  }
  return res;
}

/** Лише для тестів. */
export const resetAccessCache = () => {
  cache = null;
};
