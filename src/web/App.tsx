import { useEffect, useState, type ReactNode } from "react";
import { Reports } from "./Reports";
import { AiSettings } from "./Ai";
import { PickHistory } from "./PickHistory";
import { Settings } from "./Settings";
import { Signals } from "./Signals";
import { Stats } from "./Stats";
import { Today } from "./Today";
import { c, OFFLINE_EVENT, p, time } from "./ui";

type Tab = "today" | "signals" | "reports" | "stats" | "settings" | "ai" | "picks";
const NAV: Exclude<Tab, "settings" | "ai" | "picks">[] = ["today", "signals", "reports", "stats"];
const TABS: Record<Tab, string> = { today: "Сьогодні", signals: "Сигнали", reports: "Звіти", stats: "Статистика", settings: "Налаштування", ai: "Моделі ШІ", picks: "Історія ідей" };

/** Іконки нижньої панелі: прості лінії, колір бере від тексту кнопки. */
const ICON: Record<Exclude<Tab, "settings" | "ai" | "picks">, ReactNode> = {
  today: <path d="M3 12h3l3-8 4 16 3-8h5" />,
  signals: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.5" />
    </>
  ),
  reports: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  stats: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
};

function HeaderButton({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="press"
      style={{ width: 40, height: 40, borderRadius: 12, border: `1px solid ${c.line}`, background: c.card, color: c.ink, display: "grid", placeItems: "center", padding: 0 }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

/** Банер «дані з кешу»: service worker віддав збережену відповідь, бо мережі немає. */
function OfflineBanner() {
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setCachedAt((e as CustomEvent<string | null>).detail);
    window.addEventListener(OFFLINE_EVENT, on);
    return () => window.removeEventListener(OFFLINE_EVENT, on);
  }, []);
  if (!cachedAt) return null;
  return (
    <p role="status" style={{ ...p, fontSize: 13, color: c.bg, background: c.orange, borderRadius: 10, padding: "8px 12px" }}>
      Немає зв'язку: показую збережені дані на {time(cachedAt)}.
    </p>
  );
}

export function App() {
  // Сповіщення відкриває застосунок з ?report=<id> або ?signal=<id>.
  const query = new URLSearchParams(location.search);
  const initialReport = Number(query.get("report")) || null;
  const initialSignal = Number(query.get("signal")) || null;
  const [tab, setTab] = useState<Tab>(initialSignal ? "signals" : initialReport ? "reports" : "today");
  const [reportId, setReportId] = useState<number | null>(initialReport);
  const [signalId, setSignalId] = useState<number | null>(initialSignal);

  const open = (kind: "report" | "signal", id: number | null) => {
    (kind === "report" ? setReportId : setSignalId)(id);
    setTab(kind === "report" ? "reports" : "signals");
    history.replaceState(null, "", id ? `/?${kind}=${id}` : "/");
    window.scrollTo(0, 0);
  };
  const go = (t: Tab) => {
    setTab(t);
    window.scrollTo(0, 0);
  };

  return (
    <div style={{ minHeight: "100dvh", background: c.bg, color: c.ink, fontFamily: "Inter, system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      <main
        style={{
          flex: 1,
          padding: "max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 16px max(16px, env(safe-area-inset-left))",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          width: "100%",
          minWidth: 0,
          maxWidth: 640,
          margin: "0 auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            {tab === "today" && (
              <span style={{ fontSize: 13, color: c.dim, fontWeight: 500 }}>
                {new Date().toLocaleDateString("uk-UA", { weekday: "long", day: "numeric", month: "long" })}
              </span>
            )}
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: -0.3 }}>{TABS[tab]}</h1>
          </div>
          {tab === "today" && (
            <div style={{ display: "flex", gap: 8 }}>
              <HeaderButton onClick={() => go("ai")} label="Моделі ШІ">
                <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
                <rect x="7" y="7" width="10" height="10" rx="2" />
                <path d="M10 10h4v4h-4z" />
              </HeaderButton>
              <HeaderButton onClick={() => go("settings")} label="Налаштування">
                <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
                <circle cx="16" cy="7" r="2" />
                <circle cx="10" cy="17" r="2" />
              </HeaderButton>
            </div>
          )}
        </div>
        <OfflineBanner />
        {tab === "today" && <Today onOpenReport={(id) => open("report", id)} onOpenSignal={(id) => open("signal", id)} onOpenPicks={() => go("picks")} />}
        {tab === "signals" && <Signals openId={signalId} onOpen={(id) => open("signal", id)} />}
        {tab === "reports" && <Reports openId={reportId} onOpen={(id) => open("report", id)} />}
        {tab === "stats" && <Stats onOpenPicks={() => go("picks")} />}
        {tab === "picks" && <PickHistory onBack={() => go("today")} />}
        {tab === "settings" && <Settings onBack={() => setTab("today")} onOpenAi={() => go("ai")} />}
        {tab === "ai" && <AiSettings onBack={() => setTab("today")} />}
      </main>
      <nav
        style={{
          position: "sticky",
          bottom: 0,
          display: "flex",
          background: "rgba(16, 20, 27, 0.86)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          borderTop: `1px solid ${c.line}`,
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: 10,
        }}
      >
        {NAV.map((t) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? "page" : undefined}
            onClick={() => {
              setTab(t);
              history.replaceState(null, "", "/");
              if (t === "signals") setSignalId(null);
              if (t === "reports") setReportId(null);
            }}
            style={{
              flex: 1,
              minHeight: 58,
              border: 0,
              background: "transparent",
              color: tab === t ? c.blue : c.dim,
              font: "600 11px Inter, system-ui, sans-serif",
              padding: "6px 0 4px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
              position: "relative",
            }}
          >
            {tab === t && <span aria-hidden style={{ position: "absolute", top: 0, width: 28, height: 3, borderRadius: 2, background: c.blue }} />}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {ICON[t]}
            </svg>
            {TABS[t]}
          </button>
        ))}
      </nav>
    </div>
  );
}
