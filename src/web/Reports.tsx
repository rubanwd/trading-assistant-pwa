import { useCallback, useEffect, useState } from "react";
import { SETUP } from "./Signals";
import { StatsView, type Stats } from "./Stats";
import { api, c, card, day, dim, h2, KIND, p, secondary, time } from "./ui";

export interface ReportCard {
  id: number;
  kind: string;
  date: string;
  created_at: string;
  headline: string;
  theses: string[];
}

interface Scenario { title: string; description: string; probability: number; invalidation: string; statement: string | null }
interface Level { symbol: string; price: number; kind: "support" | "resistance"; note: string }
interface Forecast { id: number; statement: string; probability: number; resolve_at: string; outcome: number | null }
interface News { id: number; ts: string; source: string; url: string; title: string; impact: string | null; sentiment: string | null }
interface Prior { title: string; statement: string; probability_pct: number; outcome: "happened" | "did_not_happen" | "pending" }
interface Report {
  id: number;
  kind: string;
  created_at: string;
  model: string | null;
  cost_usd: number | null;
  body: {
    content: { headline: string; theses: string[]; regime: string; levels: Level[]; scenarios: Scenario[]; plan: { do: string[]; avoid: string[] }; review: string };
    prior: Prior[];
  };
  forecasts: Forecast[];
  news: News[];
}

const OUTCOME = { happened: "збулося", did_not_happen: "не збулося", pending: "ще відкритий" } as const;

function Bar({ value }: { value: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, borderRadius: 3, background: c.line }}>
        <div style={{ width: `${Math.round(value * 100)}%`, height: 6, borderRadius: 3, background: c.blue }} />
      </div>
      <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right" }}>{Math.round(value * 100)}%</span>
    </div>
  );
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p style={{ ...dim, marginBottom: 4 }}>{title}</p>
      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((t) => <li key={t} style={p}>{t}</li>)}
      </ul>
    </div>
  );
}

interface WeeklyReport {
  id: number;
  created_at: string;
  model: string | null;
  cost_usd: number | null;
  body: {
    content: { headline: string };
    week: Stats;
    allTime: Stats;
    review: {
      summary: string;
      working: string[];
      failing: string[];
      calibration: string;
      proposals: { target: string; change: string; reason: string; evidence: string }[];
      nextWeek: string[];
    } | null;
    reviewNote: string | null;
  };
}

const TARGET: Record<string, string> = { ...SETUP, filter: "Фільтр", general: "Загалом" };

function WeeklyView({ report, onBack }: { report: WeeklyReport; onBack: () => void }) {
  const [scope, setScope] = useState<"week" | "allTime">("week");
  const r = report.body.review;
  return (
    <>
      <button type="button" style={{ ...secondary, alignSelf: "flex-start" }} onClick={onBack}>← Усі звіти</button>
      <section style={card}>
        <p style={dim}>Тижневий розбір · {day(report.created_at)}</p>
        <h2 style={{ ...h2, fontSize: 18, lineHeight: 1.3 }}>{report.body.content.headline}</h2>
        {r ? <p style={p}>{r.summary}</p> : <p style={dim}>Розбору моделі немає: {report.body.reviewNote}. Цифри нижче порахував код.</p>}
      </section>
      {r && (
        <>
          <section style={card}>
            <List title="Що працює" items={r.working} />
            <List title="Що не працює" items={r.failing} />
            {r.calibration && <p style={p}>{r.calibration}</p>}
            <List title="На що дивитися наступного тижня" items={r.nextWeek} />
          </section>
          <section style={card}>
            <h2 style={h2}>Пропозиції змін</h2>
            {r.proposals.length === 0 && <p style={dim}>Цього тижня цифри не вимагають змін.</p>}
            {r.proposals.map((x) => (
              <div key={x.change} style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8, borderBottom: `1px solid ${c.line}` }}>
                <p style={dim}>{TARGET[x.target] ?? x.target}</p>
                <p style={{ ...p, fontWeight: 600 }}>{x.change}</p>
                <p style={p}>{x.reason}</p>
                {x.evidence && <p style={dim}>Підстава: {x.evidence}</p>}
              </div>
            ))}
            <p style={dim}>Зміни вмикаєш ти в «Налаштуваннях», розділ «Правила сетапів»; не частіше ніж раз на два тижні.</p>
          </section>
        </>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        {(["week", "allTime"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={scope === k}
            onClick={() => setScope(k)}
            style={{ ...secondary, flex: 1, minHeight: 40, fontSize: 14, padding: 0, color: scope === k ? c.blue : c.dim, borderColor: scope === k ? c.blue : c.line }}
          >
            {k === "week" ? "Цей тиждень" : "Увесь час"}
          </button>
        ))}
      </div>
      <StatsView stats={report.body[scope]} />
      <p style={dim}>
        Модель: {report.model ?? "—"}
        {report.cost_usd !== null && ` · $${report.cost_usd.toFixed(3)}`} (Batch API, −50%). Це аналіз, а не фінансова порада.
      </p>
    </>
  );
}

function ReportView({ id, onBack }: { id: number; onBack: () => void }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReport(null);
    api<Report>(`/api/reports/${id}`).then(setReport, (e) => setError(String(e)));
  }, [id]);

  if (error) return <p style={{ ...p, color: c.orange }}>Не вдалося відкрити звіт: {error}</p>;
  if (!report) return <p style={dim}>Завантажую…</p>;
  if (report.kind === "weekly") return <WeeklyView report={report as unknown as WeeklyReport} onBack={onBack} />;
  const r = report.body.content;
  return (
    <>
      <button type="button" style={{ ...secondary, alignSelf: "flex-start" }} onClick={onBack}>← Усі звіти</button>
      <section style={card}>
        <p style={dim}>{KIND[report.kind] ?? report.kind} звіт · {day(report.created_at)}, {time(report.created_at)}</p>
        <h2 style={{ ...h2, fontSize: 18, lineHeight: 1.3 }}>{r.headline}</h2>
        <p style={p}>{r.regime}</p>
      </section>
      {r.review && (
        <section style={card}>
          <h2 style={h2}>Що збулося</h2>
          {report.body.prior.map((f) => (
            <div key={f.statement} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
              <span>{f.title} · {f.probability_pct}%</span>
              <span style={{ color: f.outcome === "happened" ? c.blue : f.outcome === "pending" ? c.dim : c.orange, whiteSpace: "nowrap" }}>{OUTCOME[f.outcome]}</span>
            </div>
          ))}
          <p style={p}>{r.review}</p>
        </section>
      )}
      <section style={card}>
        <h2 style={h2}>Сценарії</h2>
        {r.scenarios.map((s) => (
          <div key={s.title} style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8, borderBottom: `1px solid ${c.line}` }}>
            <p style={{ ...p, fontWeight: 600 }}>{s.title}</p>
            <Bar value={s.probability} />
            <p style={p}>{s.description}</p>
            {s.statement && <p style={dim}>Перевірка: {s.statement}</p>}
            {s.invalidation && <p style={dim}>Скасування: {s.invalidation}</p>}
          </div>
        ))}
        {report.forecasts.some((f) => f.outcome !== null) && (
          <div>
            <p style={{ ...dim, marginBottom: 4 }}>Результати перевірки</p>
            {report.forecasts.map((f) => (
              <p key={f.id} style={dim}>
                {f.statement}: <span style={{ color: f.outcome === 1 ? c.blue : f.outcome === 0 ? c.orange : c.dim }}>{f.outcome === null ? "ще відкритий" : f.outcome === 1 ? "збулося" : "не збулося"}</span>
              </p>
            ))}
          </div>
        )}
      </section>
      {r.levels.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Ключові рівні</h2>
          {r.levels.map((l) => (
            <div key={`${l.symbol}-${l.price}-${l.kind}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
              <span>{l.symbol.replace("USDT", "")} <span style={{ fontVariantNumeric: "tabular-nums" }}>{l.price}</span> · {l.kind === "support" ? "підтримка" : "опір"}</span>
              <span style={{ color: c.dim, textAlign: "right" }}>{l.note}</span>
            </div>
          ))}
        </section>
      )}
      <section style={card}>
        <h2 style={h2}>План</h2>
        <List title="Що робити" items={r.plan.do} />
        <List title="Чого не робити" items={r.plan.avoid} />
      </section>
      {report.news.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Новини, які врахував звіт</h2>
          {report.news.map((n) => (
            <a key={n.id} href={n.url} target="_blank" rel="noopener noreferrer" style={{ ...p, color: c.ink, textDecoration: "none" }}>
              {n.title}
              <span style={{ ...dim, display: "block" }}>{n.source} · {time(n.ts)}</span>
            </a>
          ))}
        </section>
      )}
      <p style={dim}>
        Модель: {report.model ?? "—"}{report.cost_usd !== null && ` · $${report.cost_usd.toFixed(3)}`}. Це аналіз, а не фінансова порада.
      </p>
    </>
  );
}

export function Reports({ openId, onOpen }: { openId: number | null; onOpen: (id: number | null) => void }) {
  const [list, setList] = useState<ReportCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ reports: ReportCard[] }>("/api/reports").then((d) => { setList(d.reports); setError(null); }, (e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (kind: "morning" | "evening") => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ id: number }>("/api/reports/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) });
      load();
      onOpen(res.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const [note, setNote] = useState<string | null>(null);
  const weekly = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ status: string; error?: string }>("/api/reports/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "weekly" }) });
      const text: Record<string, string> = {
        submitted: "Розбір відправлено Opus через Batch API. Він з'явиться тут протягом години, після одного з наступних запусків рушія.",
        pending: "Розбір за сьогодні вже обробляється.",
        exists: "Тижневий розбір за сьогодні вже є.",
        saved: "Розбір моделі зараз недоступний: збережено статистику без нього.",
      };
      setNote(text[res.status] ?? res.error ?? res.status);
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (openId !== null) return <ReportView id={openId} onBack={() => onOpen(null)} />;
  return (
    <>
      {error && <p style={{ ...p, color: c.orange }}>{error}</p>}
      {note && <p style={dim}>{note}</p>}
      {list?.length === 0 && <p style={dim}>Звітів ще немає. Перший з'явиться о 07:30 або 20:30 за Києвом, тижневий розбір у неділю.</p>}
      {list?.map((r) => (
        <button key={r.id} type="button" onClick={() => onOpen(r.id)} style={{ ...card, color: c.ink, textAlign: "left", font: "inherit", cursor: "pointer" }}>
          <span style={dim}>{KIND[r.kind] ?? r.kind} · {day(r.created_at)}, {time(r.created_at)}</span>
          <span style={{ ...p, fontWeight: 600 }}>{r.headline}</span>
        </button>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={{ ...secondary, flex: 1 }} disabled={busy} onClick={() => run("morning")}>{busy ? "Складаю…" : "Скласти ранковий"}</button>
        <button type="button" style={{ ...secondary, flex: 1 }} disabled={busy} onClick={() => run("evening")}>{busy ? "Складаю…" : "Скласти вечірній"}</button>
      </div>
      <button type="button" style={secondary} disabled={busy} onClick={weekly}>Тижневий розбір зараз</button>
    </>
  );
}
