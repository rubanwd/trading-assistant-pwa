import { useCallback, useEffect, useState } from "react";

interface Target { name: string; ok: boolean; status: number | null; ms: number; note?: string }
interface Status {
  lastRun: { kind: string; started_at: string; status: string; detail: Target[] | null; error: string | null } | null;
}

const c = { bg: "#0E1116", card: "#171B22", line: "#262C36", ink: "#E8EBF0", dim: "#9AA3B2", blue: "#5B9DFF", orange: "#FF9F4A" };
const card = { background: c.card, border: `1px solid ${c.line}`, borderRadius: 14, padding: 16 } as const;

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const probe = async () => {
    setBusy(true);
    try {
      await fetch("/api/probe", { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const run = status?.lastRun;
  const time = run ? new Date(run.started_at).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <main style={{ minHeight: "100dvh", background: c.bg, color: c.ink, fontFamily: "Inter, system-ui, sans-serif", padding: "24px 20px", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 12 }}>
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 600 }}>Сьогодні</h1>
      <section style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Пульс системи</h2>
        {error && <p style={{ margin: 0, color: c.orange, fontSize: 14 }}>Немає зв'язку з API: {error}</p>}
        {!error && !run && <p style={{ margin: 0, color: c.dim, fontSize: 14 }}>Запусків ще не було.</p>}
        {run && (
          <p style={{ margin: 0, fontSize: 14, color: run.status === "ok" ? c.ink : c.orange }}>
            Останній запуск о {time}: {run.status === "ok" ? "успішно" : `помилка, ${run.error}`}
          </p>
        )}
        {run?.detail?.map((t) => (
          <div key={t.name} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: c.dim }}>
            <span>{t.name}</span>
            <span style={{ color: t.ok ? c.blue : c.orange }}>{t.ok ? "доступний" : "недоступний"} · {t.status ?? "—"} · {t.ms} мс</span>
          </div>
        ))}
        <button type="button" onClick={probe} disabled={busy} style={{ minHeight: 48, borderRadius: 12, border: 0, background: c.blue, color: c.bg, font: "600 15px Inter, system-ui, sans-serif", marginTop: 4 }}>
          {busy ? "Перевіряю…" : "Перевірити джерела з ЄС"}
        </button>
      </section>
      <p style={{ margin: 0, fontSize: 13, color: c.dim, lineHeight: 1.4 }}>Етап «Каркас»: сигналів і звітів ще немає.</p>
    </main>
  );
}
