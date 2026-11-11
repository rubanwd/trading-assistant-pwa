import { useEffect, useState } from "react";

type Status = {
  lastScan: { started_at: string; status: string; candidates: number; error: string | null } | null;
  activeSignals: number;
  llmSpendUsd: number;
};

type Probe = {
  colo: string | null;
  binance: { status: number | null; ok: boolean };
  claude: { status: number | null; ok: boolean; skipped?: boolean };
};

const TABS = ["Сьогодні", "Сигнали", "Звіти", "Статистика"] as const;
type Tab = (typeof TABS)[number];

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });

export function App() {
  const [tab, setTab] = useState<Tab>("Сьогодні");
  return (
    <div className="app">
      <header className="header">
        <h1>{tab}</h1>
      </header>
      <main className="content">{tab === "Сьогодні" ? <Today /> : <Soon />}</main>
      <nav className="tabs" aria-label="Розділи">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className="tab"
            aria-current={t === tab ? "page" : undefined}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>
    </div>
  );
}

function Soon() {
  return (
    <div className="card empty">
      <h2>Ще в роботі</h2>
      <p className="muted">Цей розділ з'явиться на наступних етапах.</p>
    </div>
  );
}

function Today() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setStatus)
      .catch(() => setError(true));
  }, []);

  const runProbe = async () => {
    setProbing(true);
    try {
      const r = await fetch("/api/probe", { method: "POST" });
      setProbe(await r.json());
    } finally {
      setProbing(false);
    }
  };

  const scan = status?.lastScan;
  return (
    <>
      <div className="card empty">
        <h2>{status && status.activeSignals > 0 ? `Активних сигналів: ${status.activeSignals}` : "Якісних входів немає"}</h2>
        <p className="muted">
          {error
            ? "Не вдалося отримати стан. Перевір з'єднання."
            : scan
              ? `Останній скан о ${time(scan.started_at)}: ${scan.status === "ok" ? "успішно" : "помилка"}.`
              : "Сканів ще не було."}
        </p>
      </div>
      <div className="card">
        <h2>Витрати на моделі</h2>
        <div className="row">
          <span className="muted">Цього місяця</span>
          <span>${(status?.llmSpendUsd ?? 0).toFixed(2)} із $25</span>
        </div>
      </div>
      <div className="card">
        <h2>Перевірка доступу з ЄС</h2>
        <p className="muted">Рушій звертається до Binance Futures і Claude API зі свого дата-центру.</p>
        <button type="button" className="btn" onClick={runProbe} disabled={probing}>
          {probing ? "Перевіряю…" : "Запустити перевірку"}
        </button>
        {probe && (
          <>
            <div className="row">
              <span className="muted">Дата-центр</span>
              <span>{probe.colo ?? "невідомо"}</span>
            </div>
            <div className="row">
              <span className="muted">Binance Futures</span>
              <span className={probe.binance.ok ? "ok" : "bad"}>{probe.binance.status ?? "немає відповіді"}</span>
            </div>
            <div className="row">
              <span className="muted">Claude API</span>
              <span className={probe.claude.ok ? "ok" : "bad"}>
                {probe.claude.skipped ? "ключ не задано" : (probe.claude.status ?? "немає відповіді")}
              </span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
