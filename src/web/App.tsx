import { useCallback, useEffect, useState } from "react";
import { fmtPrice, useLivePrice } from "./live";
import { Push } from "./Push";
import { Reports, type ReportCard } from "./Reports";
import { Settings } from "./Settings";
import { OpenSignals, Signals } from "./Signals";
import { Stats } from "./Stats";
import { api, c, card, dim, h2, KIND, OFFLINE_EVENT, p, primary, secondary, time } from "./ui";

interface Target { name: string; ok: boolean; status: number | null; ms: number; note?: string }
interface ScanDetail {
  source: string;
  market: { mood: "risk_on" | "risk_off" | "mixed"; btcTrend: "up" | "down" | "range" | null; breadth: number | null };
  symbols: number;
  snapshots: number;
}
interface Status {
  lastRun: { kind: string; started_at: string; status: string; detail: Target[] | ScanDetail | null; error: string | null } | null;
  lastReport: ReportCard | null;
  spend: { monthUsd: number; budgetUsd: number | null };
  btc: { price: number; at: string } | null;
}

const MOOD = { risk_on: "ризик-он", risk_off: "ризик-оф", mixed: "змішаний" } as const;
const TREND = { up: "вгору", down: "вниз", range: "боковик" } as const;
type Tab = "today" | "signals" | "reports" | "stats" | "settings";
const NAV: Exclude<Tab, "settings">[] = ["today", "signals", "reports", "stats"];
const TABS: Record<Tab, string> = { today: "Сьогодні", signals: "Сигнали", reports: "Звіти", stats: "Статистика", settings: "Налаштування" };

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

function Today({ onOpenReport, onOpenSignal }: { onOpenReport: (id: number) => void; onOpenSignal: (id: number) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/status"));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const post = async (path: string) => {
    setBusy(true);
    try {
      await fetch(path, { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const run = status?.lastRun;
  const targets = Array.isArray(run?.detail) ? run.detail : null;
  const scan = run?.detail && !Array.isArray(run.detail) ? run.detail : null;
  const report = status?.lastReport;
  const live = useLivePrice("BTCUSDT");
  const btc = live ?? status?.btc?.price ?? null;

  return (
    <>
      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>BTC {btc === null ? "—" : fmtPrice(btc)}</span>
          <span style={dim}>{live !== null ? "наживо" : status?.btc ? `скан о ${time(status.btc.at)}` : ""}</span>
        </div>
        {scan && (
          <p style={dim}>
            Ринок {MOOD[scan.market.mood]}
            {scan.market.btcTrend && ` · BTC 4h ${TREND[scan.market.btcTrend]}`}
            {scan.market.breadth !== null && ` · вище EMA200: ${Math.round(scan.market.breadth * 100)}%`}
          </p>
        )}
      </section>
      {report ? (
        <button type="button" onClick={() => onOpenReport(report.id)} style={{ ...card, color: c.ink, textAlign: "left", font: "inherit", cursor: "pointer" }}>
          <span style={dim}>{KIND[report.kind] ?? report.kind} звіт · {time(report.created_at)}</span>
          <span style={{ ...p, fontWeight: 600 }}>{report.headline}</span>
          {report.theses.map((t) => <span key={t} style={p}>• {t}</span>)}
        </button>
      ) : (
        <section style={card}>
          <h2 style={h2}>Звіт</h2>
          <p style={dim}>Звітів ще немає. Перший з'явиться о 07:30 або 20:30 за Києвом.</p>
        </section>
      )}
      <OpenSignals onOpen={onOpenSignal} lastScan={run?.kind === "scan" ? run.started_at : null} />
      <section style={card}>
        <h2 style={h2}>Пульс системи</h2>
        {error && <p style={{ ...p, color: c.orange }}>Немає зв'язку з API: {error}</p>}
        {!error && !run && <p style={dim}>Запусків ще не було.</p>}
        {run && (
          <p style={{ ...p, color: run.status === "ok" ? c.ink : c.orange }}>
            Останній запуск о {time(run.started_at)}: {run.status === "ok" ? "успішно" : `помилка, ${run.error}`}
          </p>
        )}
        {scan && (
          <p style={dim}>
            Скан: {scan.snapshots} із {scan.symbols} монет · джерело {scan.source}
          </p>
        )}
        {targets?.map((t) => (
          <div key={t.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: c.dim }}>
            <span>{t.name}</span>
            <span style={{ color: t.ok ? c.blue : c.orange }}>{t.ok ? "доступний" : "недоступний"} · {t.status ?? "—"} · {t.ms} мс</span>
          </div>
        ))}
        {status && (
          <p style={dim}>
            Витрати на моделі цього місяця: ${status.spend.monthUsd.toFixed(2)}
            {status.spend.budgetUsd !== null && ` із $${status.spend.budgetUsd}`}
          </p>
        )}
        <button type="button" onClick={() => post("/api/probe")} disabled={busy} style={{ ...primary, marginTop: 4 }}>
          {busy ? "Працюю…" : "Перевірити джерела з ЄС"}
        </button>
        <button type="button" onClick={() => post("/api/scan")} disabled={busy} style={secondary}>Запустити скан</button>
      </section>
      <Push />
      <p style={dim}>Скан раз на 30 хв, звіти о 07:30 і 20:30. Система пропонує, рішення за тобою.</p>
    </>
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

  return (
    <div style={{ minHeight: "100dvh", background: c.bg, color: c.ink, fontFamily: "Inter, system-ui, sans-serif", display: "flex", flexDirection: "column" }}>
      <main style={{ flex: 1, padding: "24px 20px 16px", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 640, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600 }}>{TABS[tab]}</h1>
          {tab === "today" && (
            <button type="button" onClick={() => { setTab("settings"); window.scrollTo(0, 0); }} style={{ ...secondary, minHeight: 40, fontSize: 14 }}>
              Налаштування
            </button>
          )}
        </div>
        <OfflineBanner />
        {tab === "today" && <Today onOpenReport={(id) => open("report", id)} onOpenSignal={(id) => open("signal", id)} />}
        {tab === "signals" && <Signals openId={signalId} onOpen={(id) => open("signal", id)} />}
        {tab === "reports" && <Reports openId={reportId} onOpen={(id) => open("report", id)} />}
        {tab === "stats" && <Stats />}
        {tab === "settings" && <Settings onBack={() => setTab("today")} />}
      </main>
      <nav style={{ position: "sticky", bottom: 0, display: "flex", background: c.card, borderTop: `1px solid ${c.line}`, paddingBottom: "env(safe-area-inset-bottom)" }}>
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
            style={{ flex: 1, minHeight: 56, border: 0, background: "transparent", color: tab === t ? c.blue : c.dim, font: "600 13px Inter, system-ui, sans-serif", padding: 0 }}
          >
            {TABS[t]}
          </button>
        ))}
      </nav>
    </div>
  );
}
