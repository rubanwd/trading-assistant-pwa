import { useEffect, useState } from "react";
import { generateVapid, type VapidKeys } from "../shared/vapid";
import { api, c, card, dim, h2, primary, secondary } from "./ui";

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

/** Одне значення з кнопкою «Скопіювати»: на телефоні виділяти довгий рядок незручно. */
function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 14 }}>{label}</span>
      <code style={{ fontSize: 12, wordBreak: "break-all", background: c.bg, border: `1px solid ${c.line}`, borderRadius: 8, padding: 8, userSelect: "all" }}>{value}</code>
      <button
        type="button"
        style={{ ...secondary, minHeight: 40 }}
        onClick={() =>
          navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? "Скопійовано" : "Скопіювати"}
      </button>
    </div>
  );
}

/**
 * Генерує пару ключів VAPID прямо на пристрої: приватний ключ не йде на сервер застосунку,
 * його треба вставити в секрет Cloudflare VAPID_PRIVATE_KEY.
 */
function VapidGenerator() {
  const [keys, setKeys] = useState<VapidKeys | null>(null);
  if (!keys) {
    return (
      <button type="button" style={secondary} onClick={() => generateVapid().then(setKeys)}>
        Згенерувати ключі VAPID
      </button>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p style={dim}>
        Скопіюй обидва значення в Cloudflare: Workers &amp; Pages → trading-assistant-pwa → Settings → Variables and Secrets. Ключі ніде не зберігаються: якщо закриєш
        екран, згенеруй нову пару.
      </p>
      <Copyable label="Змінна VAPID_PUBLIC_KEY (тип Text)" value={keys.publicKey} />
      <Copyable label="Секрет VAPID_PRIVATE_KEY (тип Secret)" value={keys.privateJwk} />
      <p style={dim}>Ще потрібна змінна VAPID_SUBJECT зі значенням mailto:твоя@пошта. Після збереження оновлень Cloudflare відкрий застосунок знову.</p>
    </div>
  );
}

/** Увімкнення сповіщень. Дозвіл запитується лише після дотику користувача. */
export function Push() {
  const [state, setState] = useState<State>("loading");
  const [key, setKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const { key } = await api<{ key: string | null }>("/api/push/key").catch(() => ({ key: null }));
      if (!key) return setState("no-key");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        // На iPhone Web Push працює лише в застосунку, доданому на початковий екран.
        return setState(isIos() && !isStandalone() ? "needs-install" : "unsupported");
      }
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
    "no-key": "Сповіщення не налаштовано: на сервері немає ключів VAPID. Їх можна згенерувати тут, на цьому пристрої.",
    denied: "Сповіщення заборонено в налаштуваннях браузера.",
    off: "Сповіщення вимкнено. Увімкни, щоб дізнаватися про готовий звіт.",
    on: "Сповіщення ввімкнено на цьому пристрої.",
  };
  return (
    <section style={card}>
      <h2 style={h2}>Сповіщення</h2>
      <p style={dim}>{text[state]}</p>
      {state === "no-key" && <VapidGenerator />}
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
