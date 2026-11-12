import { beforeEach, describe, expect, it } from "vitest";
import { checkAccess, isTeamDomain, resetAccessCache, verifyAccessJwt, type AccessJwk } from "../src/worker/access";

const NOW = 1_800_000_000_000;
const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const b64 = (data: string | ArrayBuffer) => Buffer.from(typeof data === "string" ? data : new Uint8Array(data)).toString("base64url");

async function keyPair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { pair, jwk: { kid, kty: "RSA", alg: "RS256", n: pub.n!, e: pub.e! } as AccessJwk };
}

async function sign(privateKey: CryptoKey, kid: string, payload: Record<string, unknown>, alg = "RS256") {
  const head = b64(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  aud: [AUD], iss: `https://${TEAM}`, exp: NOW / 1000 + 600, iat: NOW / 1000, email: "me@example.com", ...over,
});

describe("токен Cloudflare Access", () => {
  beforeEach(resetAccessCache);

  it("приймає правильний токен", async () => {
    const { pair, jwk } = await keyPair("k1");
    const token = await sign(pair.privateKey, "k1", claims());
    expect(await verifyAccessJwt(token, { keys: [jwk], aud: AUD, teamDomain: TEAM, now: NOW })).toEqual({ ok: true, email: "me@example.com" });
  });

  it("відхиляє чужий підпис, інший застосунок, іншу команду, прострочений токен", async () => {
    const { pair, jwk } = await keyPair("k1");
    const other = await keyPair("k1");
    const opts = { keys: [jwk], aud: AUD, teamDomain: TEAM, now: NOW };
    const reason = async (token: string) => {
      const r = await verifyAccessJwt(token, opts);
      return r.ok ? "ok" : r.reason;
    };
    expect(await reason(await sign(other.pair.privateKey, "k1", claims()))).toBe("підпис не збігається");
    expect(await reason(await sign(pair.privateKey, "k1", claims({ aud: ["other"] })))).toBe("токен для іншого застосунку");
    expect(await reason(await sign(pair.privateKey, "k1", claims({ iss: "https://evil.cloudflareaccess.com" })))).toBe("токен іншої команди");
    expect(await reason(await sign(pair.privateKey, "k1", claims({ exp: NOW / 1000 - 120 })))).toBe("токен прострочено");
    expect(await reason(await sign(pair.privateKey, "k1", claims(), "none"))).toBe("непідтримуваний алгоритм");
    expect(await reason("abc.def")).toBe("некоректний токен");
    // Підмінене тіло з чужим email при правильному підписі старого тіла.
    const good = await sign(pair.privateKey, "k1", claims());
    const [h, , s] = good.split(".");
    expect(await reason(`${h}.${b64(JSON.stringify(claims({ email: "attacker@example.com" })))}.${s}`)).toBe("підпис не збігається");
  });

  it("оновлює ключі один раз, якщо kid невідомий (ротація)", async () => {
    const old = await keyPair("old");
    const fresh = await keyPair("new");
    let loads = 0;
    const loadKeys = async () => (loads++ === 0 ? [old.jwk] : [old.jwk, fresh.jwk]);
    const token = await sign(fresh.pair.privateKey, "new", claims());
    expect((await checkAccess(token, { aud: AUD, teamDomain: TEAM, loadKeys, now: NOW })).ok).toBe(true);
    expect(loads).toBe(2);
    // Кеш: наступний запит ключі не завантажує.
    expect((await checkAccess(token, { aud: AUD, teamDomain: TEAM, loadKeys, now: NOW + 1000 })).ok).toBe(true);
    expect(loads).toBe(2);
  });

  it("без токена відмовляє, домен команди перевіряється", async () => {
    expect(await checkAccess(undefined, { aud: AUD, teamDomain: TEAM, loadKeys: async () => [] })).toEqual({ ok: false, reason: "немає токена Access" });
    expect(isTeamDomain(TEAM)).toBe(true);
    expect(isTeamDomain("evil.com")).toBe(false);
    expect(isTeamDomain("a.cloudflareaccess.com.evil.com")).toBe(false);
  });
});
