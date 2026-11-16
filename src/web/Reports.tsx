import { useCallback, useEffect, useState } from "react";
import { SETUP } from "./Signals";
import { StatsView, type Stats } from "./Stats";
import { api, c, card, coin, day, dim, h2, KIND, label, num, p, secondary, time } from "./ui";
import { Pill, Segmented } from "./viz";

const KIND_ICON: Record<string, { icon: string; color: string }> = {
  morning: { icon: "☀", color: c.yellow },
  evening: { icon: "☾", color: c.violet },
  weekly: { icon: "▦", color: c.blue },
};
function KindIcon({ kind, size = 32 }: { kind: string; size?: number }) {
  const k = KIND_ICON[kind] ?? { icon: "•", color: c.dim };
  return (
    <span aria-hidden style={{ flex: "none", width: size, height: size, borderRadius: size / 3.5, display: "grid", placeItems: "center", background: `${k.color}22`, color: k.color, fontSize: size * 0.5 }}>{k.icon}</span>
  );
}
const backBtn = { ...secondary, alignSelf: "flex-start", minHeight: 40, fontSize: 14 } as const;

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

/** Колір сценарію за напрямком у назві: зростання, падіння або нейтральний. */
function scenarioColor(title: string): string {
  const t = title.toLowerCase();
  if (/(бич|зрост|вгору|пробій вгору|ріст|відскок|ралі)/.test(t)) return c.up;
  if (/(ведм|паді|вниз|злам|обвал|продаж)/.test(t)) return c.down;
  return c.blue;
}

function Bar({ value, color = c.blue }: { value: number; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 10, borderRadius: 5, background: c.line, overflow: "hidden" }}>
        <div style={{ width: `${Math.round(value * 100)}%`, height: 10, borderRadius: 5, background: `linear-gradient(90deg, ${color}88, ${color})`, transition: "width 0.6s" }} />
      </div>
      <span style={{ ...num, fontSize: 15, fontWeight: 700, minWidth: 40, textAlign: "right", color }}>{Math.round(value * 100)}%</span>
    </div>
  );
}

const OUTCOME_STYLE = {
  happened: { icon: "✓", color: c.up },
  did_not_happen: { icon: "✕", color: c.down },
  pending: { icon: "…", color: c.dim },
} as const;

/** Рівні однієї монети на вертикальній шкалі: опори вгорі, підтримки внизу. */
function LevelLadder({ symbol, items }: { symbol: string; items: Level[] }) {
  const sorted = [...items].sort((a, b) => b.price - a.price);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontWeight: 700, fontSize: 14 }}>{coin(symbol)}</span>
      <div style={{ display: "flex", flexDirection: "column", borderLeft: `2px solid ${c.line}`, marginLeft: 4 }}>
        {sorted.map((l) => {
          const color = l.kind === "support" ? c.up : c.down;
          return (
            <div key={`${l.price}-${l.kind}`} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "4px 0" }}>
              <span aria-hidden style={{ width: 10, height: 2, background: color, marginTop: 9, marginLeft: -2, flex: "none" }} />
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ ...num, fontWeight: 700, fontSize: 14 }}>{l.price}</span>
                  <Pill color={color}>{l.kind === "support" ? "▼ підтримка" : "▲ опір"}</Pill>
                </span>
                {l.note && <span style={{ fontSize: 12, color: c.dim }}>{l.note}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function List({ title, items, mark = "•", color = c.dim }: { title: string; items: string[]; mark?: string; color?: string }) {
  if (!items.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={label}>{title}</span>
      {items.map((t) => (
        <div key={t} style={{ display: "flex", gap: 8, ...p }}>
          <span aria-hidden style={{ flex: "none", width: 18, height: 18, borderRadius: 9, display: "grid", placeItems: "center", fontSize: 10, fontWeight: 800, background: `${color}26`, color, marginTop: 1 }}>{mark}</span>
          <span>{t}</span>
        </div>
      ))}
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
      <button type="button" className="press" style={backBtn} onClick={onBack}>← Усі звіти</button>
      <section style={card}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <KindIcon kind="weekly" size={28} />
          <span style={label}>Тижневий розбір · {day(report.created_at)}</span>
        </span>
        <h2 style={{ ...h2, fontSize: 18, lineHeight: 1.3 }}>{report.body.content.headline}</h2>
        {r ? <p style={p}>{r.summary}</p> : <p style={dim}>Розбору моделі немає: {report.body.reviewNote}. Цифри нижче порахував код.</p>}
      </section>
      {r && (
        <>
          <section style={card}>
            <List title="Що працює" items={r.working} mark="+" color={c.up} />
            <List title="Що не працює" items={r.failing} mark="−" color={c.down} />
            {r.calibration && <p style={p}>{r.calibration}</p>}
            <List title="На що дивитися наступного тижня" items={r.nextWeek} mark="→" color={c.blue} />
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
      <Segmented options={[["week", "Цей тиждень"], ["allTime", "Увесь час"]]} value={scope} onChange={setScope} />
      <StatsView stats={report.body[scope]} />
      <p style={dim}>
        Модель: {report.model ?? "—"}
        {report.cost_usd !== null && ` · $${report.cost_usd.toFixed(3)}`}. Це аналіз, а не фінансова порада.
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
      <button type="button" className="press" style={backBtn} onClick={onBack}>← Усі звіти</button>
      <section style={card}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <KindIcon kind={report.kind} size={28} />
          <span style={label}>{KIND[report.kind] ?? report.kind} звіт · {day(report.created_at)}, {time(report.created_at)}</span>
        </span>
        <h2 style={{ ...h2, fontSize: 19, lineHeight: 1.3, fontWeight: 700 }}>{r.headline}</h2>
        <p style={{ ...p, color: "#C9CFD9" }}>{r.regime}</p>
      </section>
      {r.review && (
        <section style={card}>
          <h2 style={h2}>Що збулося</h2>
          {report.body.prior.map((f) => {
            const o = OUTCOME_STYLE[f.outcome];
            return (
              <div key={f.statement} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                <span aria-hidden style={{ flex: "none", width: 22, height: 22, borderRadius: 11, display: "grid", placeItems: "center", background: `${o.color}26`, color: o.color, fontWeight: 800 }}>{o.icon}</span>
                <span style={{ flex: 1, minWidth: 0 }}>{f.title}</span>
                <span style={{ ...num, color: c.dim }}>{f.probability_pct}%</span>
                <span style={{ color: o.color, whiteSpace: "nowrap", fontWeight: 600 }}>{OUTCOME[f.outcome]}</span>
              </div>
            );
          })}
          <p style={p}>{r.review}</p>
        </section>
      )}
      <section style={card}>
        <h2 style={h2}>Сценарії</h2>
        {r.scenarios.length > 1 && (
          <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", gap: 2 }} role="img" aria-label="Розподіл ймовірностей сценаріїв">
            {r.scenarios.map((s) => (
              <div key={s.title} style={{ flex: s.probability, background: scenarioColor(s.title) }} title={`${s.title}: ${Math.round(s.probability * 100)}%`} />
            ))}
          </div>
        )}
        {r.scenarios.map((s) => (
          <div key={s.title} style={{ display: "flex", flexDirection: "column", gap: 6, padding: 12, borderRadius: 12, background: c.bg, borderLeft: `3px solid ${scenarioColor(s.title)}` }}>
            <p style={{ ...p, fontWeight: 700 }}>{s.title}</p>
            <Bar value={s.probability} color={scenarioColor(s.title)} />
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
          {[...new Set(r.levels.map((l) => l.symbol))].map((sym) => (
            <LevelLadder key={sym} symbol={sym} items={r.levels.filter((l) => l.symbol === sym)} />
          ))}
        </section>
      )}
      <section style={card}>
        <h2 style={h2}>План</h2>
        <List title="Що робити" items={r.plan.do} mark="✓" color={c.up} />
        <List title="Чого не робити" items={r.plan.avoid} mark="✕" color={c.down} />
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
      const res = await api<{ status: string; id?: number; error?: string }>("/api/reports/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "weekly" }) });
      load();
      if (res.status === "saved" && res.id) onOpen(res.id);
      else setNote(res.status === "exists" ? "Тижневий розбір за сьогодні вже є." : res.error ?? res.status);
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
        <button key={r.id} type="button" className="press rise" onClick={() => onOpen(r.id)} style={{ ...card, flexDirection: "row", alignItems: "flex-start", gap: 12, color: c.ink, textAlign: "left", font: "inherit", cursor: "pointer" }}>
          <KindIcon kind={r.kind} />
          <span style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
            <span style={label}>{KIND[r.kind] ?? r.kind} · {day(r.created_at)}, {time(r.created_at)}</span>
            <span style={{ ...p, fontWeight: 600 }}>{r.headline}</span>
          </span>
          <span aria-hidden style={{ color: c.faint, fontSize: 18, alignSelf: "center" }}>›</span>
        </button>
      ))}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="press" style={{ ...secondary, flex: 1, fontSize: 14 }} disabled={busy} onClick={() => run("morning")}>{busy ? "Складаю…" : "☀ Ранковий"}</button>
        <button type="button" className="press" style={{ ...secondary, flex: 1, fontSize: 14 }} disabled={busy} onClick={() => run("evening")}>{busy ? "Складаю…" : "☾ Вечірній"}</button>
      </div>
      <button type="button" className="press" style={{ ...secondary, fontSize: 14 }} disabled={busy} onClick={weekly}>▦ Тижневий розбір зараз</button>
    </>
  );
}
