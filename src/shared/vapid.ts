/**
 * Пара ключів VAPID для Web Push, згенерована на Web Crypto.
 * Застосунок генерує її в браузері, тож приватний ключ не проходить через сервер:
 * його копіюють прямо в секрет Cloudflare VAPID_PRIVATE_KEY.
 */

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export interface VapidKeys {
  /** Публічний ключ у форматі для applicationServerKey (65 байтів, base64url). */
  publicKey: string;
  /** Приватний ключ JWK одним рядком JSON, як його чекає рушій. */
  privateJwk: string;
}

export async function generateVapid(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return {
    publicKey: b64url(raw),
    privateJwk: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }),
  };
}
