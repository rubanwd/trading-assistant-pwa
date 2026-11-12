import { useEffect, useState } from "react";
import { api, card, dim, h2, primary, secondary } from "./ui";

type State = "loading" | "unsupported" | "needs-install" | "no-key" | "off" | "on" | "denied";

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** Увімкнення сповіщень. Дозвіл запитується лише після дотику користувача. */
export function Push() {
  const [state, setState] = useState<State>("loading");
  const [key, setKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        // На iPhone Web Push працює лише в застосунку, доданому на початковий екран.
        return setState(isIos() && !isStandalone() ? "needs-install" : "unsupported");
      }
      const { key } = await api<{ key: string | null }>("/api/push/key").catch(() => ({ key: null }));
      if (!key) return setState("no-key");
      setKey(key);
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.ready;
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
    })();
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    run(async () => {
      if ((await Notification.requestPermission()) !== "granted") return setState("denied");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key!) });
      await api("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
      setState("on");
    });

  const disable = () =>
    run(async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setState("off");
    });

  const test = () =>
    run(async () => {
      const res = await api<{ webPush: { sent: number }; telegram: string; errors: string[] }>("/api/push/test", { method: "POST" });
      setNote(res.errors.length ? res.errors.join("; ") : `Надіслано: push ${res.webPush.sent}, Telegram ${res.telegram === "sent" ? "так" : "ні"}`);
    });

  if (state === "loading") return null;
  const text: Record<Exclude<State, "loading">, string> = {
    unsupported: "Цей браузер не підтримує Web Push.",
    "needs-install": "Щоб отримувати сповіщення на iPhone, додай застосунок на початковий екран: «Поділитися» → «На початковий екран», потім відкрий його звідти.",
    "no-key": "Сповіщення не налаштовано: на сервері немає ключа VAPID.",
    denied: "Сповіщення заборонено в налаштуваннях браузера.",
    off: "Сповіщення вимкнено. Увімкни, щоб дізнаватися про готовий звіт.",
    on: "Сповіщення ввімкнено на цьому пристрої.",
  };
  return (
    <section style={card}>
      <h2 style={h2}>Сповіщення</h2>
      <p style={dim}>{text[state]}</p>
      {state === "off" && <button type="button" style={primary} disabled={busy} onClick={enable}>Увімкнути сповіщення</button>}
      {state === "on" && (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={{ ...secondary, flex: 1 }} disabled={busy} onClick={test}>Перевірити</button>
          <button type="button" style={{ ...secondary, flex: 1 }} disabled={busy} onClick={disable}>Вимкнути</button>
        </div>
      )}
      {note && <p style={dim}>{note}</p>}
    </section>
  );
}
