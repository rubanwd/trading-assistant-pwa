import { useCallback, useEffect, useState } from "react";
import { entryMid, positionSize } from "../shared/risk";
import { api, c, card, day, dim, h2, p, primary, secondary, time } from "./ui";

export interface SignalCard {
  id: number;
  created_at: string;
  symbol: string;
  side: "long" | "short";
  setup: string;
  entry_low: number;
  entry_high: number;
  stop: number;
  tp1: number;
  tp2: number | null;
  rr: number;
  p_analyst: number | null;
  p_skeptic: number | null;
  status: string;
  expires_at: string;
  result_r: number | null;
  action?: "taken" | "skipped" | null;
}

interface SignalFull extends SignalCard {
  reasoning: {
    analyst: { verdict: string; summary: string; argumentsFor: string[]; argumentsAgainst: string[]; invalidation: string };
    skeptic: { strongestRisk: string; argumentsAgainst: string[] } | null;
    rejectedBy: "analyst" | "skeptic" | null;
  } | null;
  events: { ts: string; type: string; price: number | null }[];
  journal: { id: number; ts: string; action: string; note: string | null }[];
  risk: { depositUsd: number | null; riskPct: number };
}

export const SETUP: Record<string, string> = {
  trend_pullback: "Відкат у тренді",
  breakout_retest: "Пробій із ретестом",
  liquidity_sweep: "Зняття ліквідності",
};
const STATUS: Record<string, string> = {
  pending: "чекає входу", active: "активний", tp1: "ціль", tp2: "ціль 2", stopped: "стоп", expired: "прострочений", rejected: "відхилений",
};
const EVENT: Record<string, string> = {
  entry: "Вхід", tp1: "Ціль", stop: "Стоп", expired: "Прострочено без входу", missed: "Ціна дійшла до цілі без входу", timeout: "Закрито за часом",
};
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const coin = (s: string) => s.replace(/USDT$/, "");

function left(iso: string): string {
  const min = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (min <= 0) return "термін минув";
  return min >= 60 ? `ще ${Math.floor(min / 60)} год ${min % 60} хв` : `ще ${min} хв`;
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14 }}>
      <span style={{ color: c.dim }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", color }}>{value}</span>
    </div>
  );
}

function Head({ s }: { s: SignalCard }) {
  const done = s.status !== "pending" && s.status !== "active";
  const color = s.status === "tp1" || s.status === "tp2" ? c.blue : s.status === "stopped" || s.status === "rejected" ? c.orange : c.dim;
  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontSize: 18, fontWeight: 600 }}>
          {coin(s.symbol)} <span style={{ color: s.side === "long" ? c.blue : c.orange }}>{s.side === "long" ? "лонг" : "шорт"}</span>
        </span>
        <span style={{ fontSize: 13, color }}>
          {STATUS[s.status] ?? s.status}
          {s.result_r !== null && ` · ${s.result_r > 0 ? "+" : ""}${s.result_r}R`}
        </span>
      </div>
      <span style={dim}>
        {SETUP[s.setup] ?? s.setup} · {done ? `${day(s.created_at)}, ${time(s.created_at)}` : s.status === "pending" ? left(s.expires_at) : `з ${time(s.created_at)}`}
      </span>
    </>
  );
}

function Levels({ s }: { s: SignalCard }) {
  return (
    <>
      <Row label="Зона входу" value={`${s.entry_low} – ${s.entry_high}`} />
      <Row label="Стоп" value={String(s.stop)} color={c.orange} />
      <Row label="Ціль" value={s.tp2 === null ? String(s.tp1) : `${s.tp1} · далі ${s.tp2}`} color={c.blue} />
      <Row label="R:R" value={String(s.rr)} />
      <Row label="Аналітик / скептик" value={`${pct(s.p_analyst)} / ${pct(s.p_skeptic)}`} />
    </>
  );
}

function Calculator({ s, risk }: { s: SignalFull; risk: SignalFull["risk"] }) {
  const [deposit, setDeposit] = useState(() => {
    try {
      return localStorage.getItem("deposit") ?? (risk.depositUsd ? String(risk.depositUsd) : "");
    } catch {
      return risk.depositUsd ? String(risk.depositUsd) : "";
    }
  });
  const size = positionSize(Number(deposit), risk.riskPct, entryMid(s.entry_low, s.entry_high), s.stop);
  return (
    <section style={card}>
      <h2 style={h2}>Розмір позиції</h2>
      <label style={{ ...dim, display: "flex", flexDirection: "column", gap: 4 }}>
        Депозит, $
        <input
          inputMode="decimal"
          value={deposit}
          onChange={(e) => {
            setDeposit(e.target.value);
            try { localStorage.setItem("deposit", e.target.value); } catch { /* приватний режим */ }
          }}
          style={{ minHeight: 44, borderRadius: 10, border: `1px solid ${c.line}`, background: c.bg, color: c.ink, font: "16px Inter, system-ui, sans-serif", padding: "0 12px" }}
        />
      </label>
      {size ? (
        <>
          <Row label={`Ризик ${risk.riskPct}% депозиту`} value={`$${size.riskUsd.toFixed(2)}`} />
          <Row label="До стопа" value={`${size.stopDistancePct.toFixed(2)}%`} />
          <Row label="Обсяг позиції" value={`$${Math.round(size.notionalUsd)}`} />
          <Row label={`Кількість ${coin(s.symbol)}`} value={String(Number(size.quantity.toPrecision(4)))} />
        </>
      ) : (
        <p style={dim}>Вкажи депозит, і код порахує розмір від ризику {risk.riskPct}% на угоду.</p>
      )}
    </section>
  );
}

function Args({ title, items }: { title: string; items: string[] }) {
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

function SignalView({ id, onBack }: { id: number; onBack: () => void }) {
  const [s, setS] = useState<SignalFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<SignalFull>(`/api/signals/${id}`).then(setS, (e) => setError(String(e)));
  }, [id]);
  useEffect(load, [load]);

  const journal = async (action: "taken" | "skipped") => {
    setBusy(true);
    try {
      await api(`/api/signals/${id}/journal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p style={{ ...p, color: c.orange }}>Не вдалося відкрити сигнал: {error}</p>;
  if (!s) return <p style={dim}>Завантажую…</p>;
  const r = s.reasoning;
  const decision = s.journal[0]?.action;
  return (
    <>
      <button type="button" style={{ ...secondary, alignSelf: "flex-start" }} onClick={onBack}>← Усі сигнали</button>
      <section style={card}>
        <Head s={s} />
        <Levels s={s} />
      </section>
      {s.status !== "rejected" && (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={{ ...(decision === "taken" ? primary : secondary), flex: 1 }} disabled={busy} onClick={() => journal("taken")}>Взяв</button>
          <button type="button" style={{ ...(decision === "skipped" ? primary : secondary), flex: 1 }} disabled={busy} onClick={() => journal("skipped")}>Пропустив</button>
        </div>
      )}
      {r && (
        <section style={card}>
          <h2 style={h2}>Аналітик · {pct(s.p_analyst)}</h2>
          <p style={p}>{r.analyst.summary}</p>
          <Args title="За" items={r.analyst.argumentsFor} />
          <Args title="Проти" items={r.analyst.argumentsAgainst} />
          {r.analyst.invalidation && <p style={dim}>Скасування: {r.analyst.invalidation}</p>}
        </section>
      )}
      {r?.skeptic && (
        <section style={card}>
          <h2 style={h2}>Скептик · {pct(s.p_skeptic)}</h2>
          <p style={p}>{r.skeptic.strongestRisk}</p>
          <Args title="Проти" items={r.skeptic.argumentsAgainst} />
        </section>
      )}
      {r?.rejectedBy && <p style={dim}>Сигнал не опубліковано: {r.rejectedBy === "analyst" ? "аналітик радить пропустити" : "оцінка скептика нижча за поріг"}.</p>}
      {s.status !== "rejected" && <Calculator s={s} risk={s.risk} />}
      {s.events.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Хід сигналу</h2>
          {s.events.map((e) => (
            <Row key={`${e.type}-${e.ts}`} label={`${day(e.ts)}, ${time(e.ts)}`} value={`${EVENT[e.type] ?? e.type}${e.price !== null ? ` · ${e.price}` : ""}`} />
          ))}
        </section>
      )}
      <p style={dim}>Результат в R рахується від середини зони входу, без комісій. Це аналіз, а не фінансова порада.</p>
    </>
  );
}

type Scope = "open" | "closed" | "rejected";
const SCOPE: Record<Scope, string> = { open: "Відкриті", closed: "Закриті", rejected: "Відхилені" };

export function Signals({ openId, onOpen }: { openId: number | null; onOpen: (id: number | null) => void }) {
  const [scope, setScope] = useState<Scope>("open");
  const [list, setList] = useState<SignalCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setList(null);
    api<{ signals: SignalCard[] }>(`/api/signals?scope=${scope}`).then((d) => { setList(d.signals); setError(null); }, (e) => setError(String(e)));
  }, [scope, openId]);

  if (openId !== null) return <SignalView id={openId} onBack={() => onOpen(null)} />;
  return (
    <>
      <div style={{ display: "flex", gap: 8 }}>
        {(Object.keys(SCOPE) as Scope[]).map((k) => (
          <button key={k} type="button" aria-pressed={scope === k} onClick={() => setScope(k)}
            style={{ ...secondary, flex: 1, minHeight: 40, fontSize: 14, padding: 0, color: scope === k ? c.blue : c.dim, borderColor: scope === k ? c.blue : c.line }}>
            {SCOPE[k]}
          </button>
        ))}
      </div>
      {error && <p style={{ ...p, color: c.orange }}>{error}</p>}
      {list?.length === 0 && <p style={dim}>{scope === "open" ? "Якісних входів зараз немає. Це нормальний стан: більшість сканів нічого не знаходить." : "Тут поки порожньо."}</p>}
      {list?.map((s) => (
        <button key={s.id} type="button" onClick={() => onOpen(s.id)} style={{ ...card, color: c.ink, textAlign: "left", font: "inherit", cursor: "pointer" }}>
          <Head s={s} />
          {scope !== "rejected" && <Levels s={s} />}
          {s.action && <span style={dim}>У журналі: {s.action === "taken" ? "взяв" : "пропустив"}</span>}
        </button>
      ))}
    </>
  );
}

/** Відкриті сигнали для екрана «Сьогодні». */
export function OpenSignals({ onOpen, lastScan }: { onOpen: (id: number) => void; lastScan: string | null }) {
  const [list, setList] = useState<SignalCard[] | null>(null);
  useEffect(() => {
    api<{ signals: SignalCard[] }>("/api/signals?scope=open").then((d) => setList(d.signals), () => setList(null));
  }, []);
  if (!list) return null;
  if (!list.length) {
    return (
      <section style={card}>
        <h2 style={h2}>Сигнали</h2>
        <p style={dim}>Якісних входів немає{lastScan && `, останній скан о ${time(lastScan)}`}.</p>
      </section>
    );
  }
  return (
    <>
      {list.map((s) => (
        <button key={s.id} type="button" onClick={() => onOpen(s.id)} style={{ ...card, color: c.ink, textAlign: "left", font: "inherit", cursor: "pointer" }}>
          <Head s={s} />
          <Row label="Вхід" value={`${s.entry_low} – ${s.entry_high}`} />
          <Row label="Стоп / ціль" value={`${s.stop} / ${s.tp1}`} />
        </button>
      ))}
    </>
  );
}
