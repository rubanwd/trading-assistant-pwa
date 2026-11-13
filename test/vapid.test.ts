import { describe, expect, it } from "vitest";
import { generateVapid } from "../src/shared/vapid";
import { sendPush } from "../src/worker/push";

describe("ключі VAPID із застосунку", () => {
  it("публічний ключ має формат applicationServerKey, приватний лише потрібні поля JWK", async () => {
    const keys = await generateVapid();
    const raw = Buffer.from(keys.publicKey, "base64url");
    expect(raw).toHaveLength(65);
    expect(raw[0]).toBe(4);
    expect(keys.publicKey).toMatch(/^[\w-]+$/);
    expect(Object.keys(JSON.parse(keys.privateJwk)).sort()).toEqual(["crv", "d", "kty", "x", "y"]);
    // Публічний ключ збігається з x і y приватного.
    const jwk = JSON.parse(keys.privateJwk) as { x: string; y: string };
    expect(Buffer.from(jwk.x, "base64url")).toEqual(raw.subarray(1, 33));
    expect(Buffer.from(jwk.y, "base64url")).toEqual(raw.subarray(33));
  });

  it("рушій підписує ними справжній запит Web Push", async () => {
    const keys = await generateVapid();
    const client = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const p256dh = Buffer.from((await crypto.subtle.exportKey("raw", client.publicKey)) as ArrayBuffer).toString("base64url");
    const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    let authorization = "";
    const out = await sendPush(
      async (_url, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        return new Response("", { status: 201 });
      },
      { vapidPrivateKey: keys.privateJwk, vapidSubject: "mailto:me@example.com" },
      [{ endpoint: "https://push.example.com/abc", keys: { p256dh, auth } }],
      { title: "t", body: "b", url: "/" },
    );
    expect(out.webPush).toEqual({ sent: 1, failed: 0, expired: [] });
    expect(authorization).toContain(keys.publicKey);
  });
});
