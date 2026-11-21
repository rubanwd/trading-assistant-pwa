import { createContext, useContext } from "react";
import { parseDesk, type Desk } from "../shared/desk";

/**
 * Палітра. up/down: напрямок ціни й результату (завжди разом зі стрілкою ▲▼ або знаком, не лише кольором);
 * blue: акцент і нейтральні дані; orange: попередження й помилки; violet: оцінки моделі.
 */
export const c = {
  bg: "#0B0E13",
  card: "#151A22",
  card2: "#1B212B",
  line: "#262D39",
  ink: "#E8EBF0",
  dim: "#8E98A8",
  faint: "#5C6676",
  blue: "#5B9DFF",
  orange: "#FF9F4A",
  up: "#2EBD85",
  down: "#F6465D",
  violet: "#A88BFF",
  yellow: "#F0B90B",
};
export const card = {
  background: `linear-gradient(180deg, ${c.card2} 0%, ${c.card} 100%)`,
  border: `1px solid ${c.line}`,
  borderRadius: 16,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minWidth: 0,
} as const;
export const h2 = { margin: 0, fontSize: 16, fontWeight: 600 } as const;
/** Малий заголовок секції всередині картки. */
export const label = { margin: 0, fontSize: 11, fontWeight: 600, letterSpacing: 0.6, textTransform: "uppercase", color: c.faint } as const;
export const num = { fontVariantNumeric: "tabular-nums" } as const;
export const p = { margin: 0, fontSize: 14, lineHeight: 1.45 } as const;
export const dim = { ...p, fontSize: 13, color: c.dim } as const;
const button = { minHeight: 48, borderRadius: 12, font: "600 15px Inter, system-ui, sans-serif", padding: "0 16px" } as const;
export const primary = { ...button, border: 0, background: c.blue, color: c.bg } as const;
export const secondary = { ...button, border: `1px solid ${c.line}`, background: "transparent", color: c.ink } as const;

export const KIND: Record<string, string> = { morning: "Ранковий", evening: "Вечірній", weekly: "Тижневий" };

/** Service worker позначає відповідь із кешу заголовком x-cached-at; застосунок показує, що дані офлайн. */
export const OFFLINE_EVENT = "offline-data";

// ── Режим: крипто або акції ─────────────────────────────────────────────────

const DESK_STORAGE = "desk";

function storedDesk(): Desk {
  // Посилання зі сповіщення (?desk=stocks) має перевагу над збереженим вибором.
  const fromUrl = new URLSearchParams(location.search).get("desk");
  try {
    if (fromUrl) {
      localStorage.setItem(DESK_STORAGE, parseDesk(fromUrl));
      return parseDesk(fromUrl);
    }
    return parseDesk(localStorage.getItem(DESK_STORAGE));
  } catch {
    return parseDesk(fromUrl);
  }
}

let currentDesk: Desk = storedDesk();
export const getDesk = () => currentDesk;
export function setDesk(desk: Desk) {
  currentDesk = desk;
  try {
    localStorage.setItem(DESK_STORAGE, desk);
  } catch {
    /* приватний режим браузера: вибір живе до перезавантаження */
  }
}

export const DeskContext = createContext<Desk>("crypto");
export const useDesk = () => useContext(DeskContext);

/** Слова, що залежать від режиму. */
export const unit = (desk: Desk) =>
  desk === "crypto"
    ? { many: "Монети", gen: "монет", one: "монета", acc: "монету", kind: "ф'ючерс" }
    : { many: "Акції", gen: "акцій", one: "акція", acc: "акцію", kind: "контракт Bybit" };

/** Додає режим до запитів API: сервер фільтрує за ним сигнали, звіти, ідеї й статистику; іншим запитам він не заважає. */
function withDesk(path: string): string {
  if (!path.startsWith("/api/")) return path;
  const url = new URL(path, location.origin);
  if (!url.searchParams.has("desk")) url.searchParams.set("desk", currentDesk);
  return url.pathname + url.search;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withDesk(path), init);
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
/** Колір напрямку: зростання, падіння або нейтральний. */
export const tone = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? c.dim : v > 0 ? c.up : c.down);
export const arrow = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "•" : v > 0 ? "▲" : "▼");
