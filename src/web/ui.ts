export const c = { bg: "#0E1116", card: "#171B22", line: "#262C36", ink: "#E8EBF0", dim: "#9AA3B2", blue: "#5B9DFF", orange: "#FF9F4A" };
export const card = { background: c.card, border: `1px solid ${c.line}`, borderRadius: 14, padding: 16, display: "flex", flexDirection: "column", gap: 8 } as const;
export const h2 = { margin: 0, fontSize: 16, fontWeight: 600 } as const;
export const p = { margin: 0, fontSize: 14, lineHeight: 1.45 } as const;
export const dim = { ...p, fontSize: 13, color: c.dim } as const;
const button = { minHeight: 48, borderRadius: 12, font: "600 15px Inter, system-ui, sans-serif", padding: "0 16px" } as const;
export const primary = { ...button, border: 0, background: c.blue, color: c.bg } as const;
export const secondary = { ...button, border: `1px solid ${c.line}`, background: "transparent", color: c.ink } as const;

export const KIND: Record<string, string> = { morning: "Ранковий", evening: "Вечірній", weekly: "Тижневий" };

/** Service worker позначає відповідь із кешу заголовком x-cached-at; застосунок показує, що дані офлайн. */
export const OFFLINE_EVENT = "offline-data";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const cachedAt = res.headers.get("x-cached-at");
  window.dispatchEvent(new CustomEvent(OFFLINE_EVENT, { detail: cachedAt }));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
export const day = (iso: string) => new Date(iso).toLocaleDateString("uk-UA", { day: "numeric", month: "long" });

export const coin = (s: string) => s.replace(/USDT$/, "");
export const signed = (v: number, digits = 2) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
