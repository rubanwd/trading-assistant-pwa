import { useCallback, useEffect, useState } from "react";
import { entryMid, positionSize, stopDistancePct } from "../shared/risk";
import { SignalChart } from "./Chart";
import { fmtPrice, useLivePrice } from "./live";
import { api, c, card, day, dim, h2, label, num, p, primary, secondary, signed, time, tone } from "./ui";
import { Delta, LiveDot, Pill, Ring, Segmented } from "./viz";

export interface SignalCard {
  id: number;
  created_at: string;
  symbol: string;
  side: "long" | "short";
  setup: string;
  entry_low: number;
  entry_high: number;
  stop: number;
  /** Цілі й R:R були в сетапів на 1h; у трендового пробою позицію закриває вихід за каналом. */
  tp1: number | null;
  tp2: number | null;
  rr: number | null;
  p_analyst: number | null;
  p_skeptic: number | null;
  status: string;
  expires_at: string;
  resolved_at?: string | null;
  result_r: number | null;
  fee_r: number | null;
  shadow_status: string | null;
  shadow_r: number | null;
  action?: "taken" | "skipped" | null;
}

interface Similar { from: number; to: number; n: number; hits: number }

interface SignalFull extends SignalCard {
  reasoning: {
    analyst: { verdict: string; summary: string; argumentsFor: string[]; argumentsAgainst: string[]; invalidation: string };
    skeptic: { strongestRisk: string; argumentsAgainst: string[] } | null;
    rejectedBy: "analyst" | "skeptic" | null;
  } | null;
  events: { ts: string; type: string; price: number | null }[];
  journal: { id: number; ts: string; action: string; note: string | null }[];
  risk: { depositUsd: number | null; riskPct: number };
  similar: { analyst: Similar | null; skeptic: Similar | null };
}

export const SETUP: Record<string, string> = {
  trend_breakout: "Трендовий пробій 4h",
  trend_pullback: "Відкат у тренді",
  breakout_retest: "Пробій із ретестом",
  liquidity_sweep: "Зняття ліквідності",
};
const STATUS: Record<string, string> = {
  pending: "чекає входу", active: "позиція відкрита", exited: "вихід за каналом", tp1: "ціль", tp2: "ціль 2", stopped: "стоп", expired: "прострочений", rejected: "відхилений",
};
const EVENT: Record<string, string> = {
  entry: "Вхід за ринком", exit: "Вихід за каналом 4h", tp1: "Ціль 1", tp2: "Ціль 2", breakeven: "Беззбиток", stop: "Стоп", expired: "Прострочено без входу", missed: "Ціна дійшла до цілі без входу", timeout: "Закрито за часом",
};
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
const coin = (s: string) => s.replace(/USDT$/, "");
/** Результат після комісій. */
const netR = (s: SignalCard) => (s.result_r === null ? null : s.result_r - (s.fee_r ?? 0));

function left(iso: string): string {
  const min = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (min <= 0) return "термін минув";
  return min >= 60 ? `ще ${Math.floor(min / 60)} год ${min % 60} хв` : `ще ${min} хв`;
}

function Row({ label: name, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14 }}>
      <span style={{ color: c.dim }}>{name}</span>
      <span style={{ ...num, color, textAlign: "right" }}>{value}</span>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = { pending: c.yellow, active: c.blue, rejected: c.faint, expired: c.faint };

/** Аватар монети: перші літери на кольоровому колі (колір стабільний для символу). */
export function CoinBadge({ symbol, size = 36 }: { symbol: string; size?: number }) {
  const name = coin(symbol);
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span aria-hidden style={{ flex: "none", width: size, height: size, borderRadius: size / 2, display: "grid", placeItems: "center", fontWeight: 800, fontSize: size * 0.32, color: "#fff", background: `linear-gradient(135deg, hsl(${h} 55% 45%), hsl(${(h + 40) % 360} 60% 30%))` }}>
      {name.slice(0, 4)}
    </span>
  );
}

function Head({ s }: { s: SignalCard }) {
  const done = s.status !== "pending" && s.status !== "active";
  const r = netR(s);
  const long = s.side === "long";
  const statusColor = r !== null ? tone(r) : STATUS_COLOR[s.status] ?? c.dim;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <CoinBadge symbol={s.symbol} />
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 17, fontWeight: 700 }}>{coin(s.symbol)}</span>
          <Pill color={long ? c.up : c.down} solid>{long ? "▲ ЛОНГ" : "▼ ШОРТ"}</Pill>
        </span>
        <span style={{ fontSize: 12, color: c.dim }}>
          {SETUP[s.setup] ?? s.setup} · {done ? `${day(s.created_at)}, ${time(s.created_at)}` : s.status === "pending" ? left(s.expires_at) : `з ${time(s.created_at)}`}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <Pill color={statusColor}>{STATUS[s.status] ?? s.status}</Pill>
        {r !== null && <span style={{ ...num, fontSize: 16, fontWeight: 700, color: tone(r) }}>{signed(r)}R</span>}
        {s.status === "rejected" && s.shadow_r !== null && <span style={{ ...num, fontSize: 12, color: tone(s.shadow_r) }}>якби брали {signed(s.shadow_r)}R</span>}
      </div>
    </div>
  );
}

/** Поточний результат у R від ціни входу; для шорту знак розвертається через стоп вище входу. */
const rNow = (s: SignalCard, price: number) => {
  const entry = entryMid(s.entry_low, s.entry_high);
  return entry === s.stop ? 0 : (price - entry) / (entry - s.stop);
};

/**
 * Драбина R: шкала від стопа (−1R) через вхід (0) до прибутку, з позначкою поточної ціни або результату.
 * Червона частина — шлях до стопа, зелена — у прибуток.
 */
export function RLadder({ value, caption }: { value: number | null; caption?: string }) {
  const lo = -1.25;
  const hi = Math.max(3, value !== null ? Math.ceil(value + 0.5) : 3);
  const pos = (r: number) => ((Math.min(hi, Math.max(lo, r)) - lo) / (hi - lo)) * 100;
  const ticks = Array.from({ length: Math.floor(hi) + 2 }, (_, i) => i - 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ position: "relative", height: 34, marginTop: value !== null ? 14 : 0 }}>
        <div style={{ position: "absolute", top: 12, left: 0, right: 0, height: 8, borderRadius: 4, overflow: "hidden", display: "flex" }}>
          <div style={{ width: `${pos(0)}%`, background: `linear-gradient(90deg, ${c.down}, ${c.down}55)` }} />
          <div style={{ flex: 1, background: `linear-gradient(90deg, ${c.up}33, ${c.up})` }} />
        </div>
        {ticks.map((t) => (
          <span key={t} style={{ position: "absolute", left: `${pos(t)}%`, top: 22, transform: "translateX(-50%)", fontSize: 10, color: t === 0 ? c.ink : c.faint, whiteSpace: "nowrap" }}>
            {t === -1 ? "стоп" : t === 0 ? "вхід" : `+${t}R`}
          </span>
        ))}
        {ticks.map((t) => (
          <span key={`l${t}`} style={{ position: "absolute", left: `calc(${pos(t)}% - 0.5px)`, top: 10, width: 1, height: 12, background: t === 0 ? c.ink : `${c.bg}AA` }} />
        ))}
        {value !== null && (
          <div style={{ position: "absolute", left: `${pos(value)}%`, top: -14, transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", transition: "left 0.6s ease" }}>
            <span style={{ ...num, fontSize: 11, fontWeight: 700, color: c.bg, background: tone(value), borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap" }}>{signed(value)}R</span>
            <span style={{ width: 0, height: 0, borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderTop: `6px solid ${tone(value)}` }} />
            <span style={{ width: 14, height: 14, marginTop: -1, borderRadius: 7, background: c.ink, border: `3px solid ${tone(value)}` }} />
          </div>
        )}
      </div>
      {caption && <span style={{ fontSize: 11, color: c.dim }}>{caption}</span>}
    </div>
  );
}

/** Вхід: одна ціна для входу за ринком або зона для лімітного входу старих сетапів. */
const entryText = (s: SignalCard) => (s.entry_low === s.entry_high ? `${s.entry_low}` : `${s.entry_low} – ${s.entry_high}`);

/** Оцінки моделей кільцями. */
function Votes({ s, size = 44 }: { s: SignalCard; size?: number }) {
  const vote = (name: string, v: number | null) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Ring value={v} size={size} stroke={5} color={v === null ? c.faint : v >= 0.6 ? c.up : v >= 0.45 ? c.yellow : c.down} label={`${name}: ${pct(v)}`}>
        <span style={{ ...num, fontSize: size * 0.27, fontWeight: 700 }}>{v === null ? "—" : Math.round(v * 100)}</span>
      </Ring>
      <span style={{ fontSize: 12, color: c.dim, lineHeight: 1.2 }}>{name}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", gap: 16 }}>
      {vote("аналітик", s.p_analyst)}
      {vote("скептик", s.p_skeptic)}
    </div>
  );
}

function Levels({ s }: { s: SignalCard }) {
  const entry = entryMid(s.entry_low, s.entry_high);
  const cell = (name: string, value: string, sub: string | null, color?: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", borderRadius: 10, background: c.bg, border: `1px solid ${c.line}`, minWidth: 0 }}>
      <span style={label}>{name}</span>
      <span style={{ ...num, fontSize: 14, fontWeight: 700, color }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: c.dim }}>{sub}</span>}
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
      {cell("Вхід", entryText(s), s.entry_low === s.entry_high ? "за ринком" : "зона")}
      {cell("Стоп", String(s.stop), `−${stopDistancePct(entry, s.stop).toFixed(1)}%`, c.down)}
      {s.tp1 === null
        ? cell("Вихід", "канал 10×4h", "без цілі", c.up)
        : cell("Ціль", String(s.tp1), s.rr !== null ? `R:R ${s.rr}` : s.tp2 !== null ? `далі ${s.tp2}` : null, c.up)}
    </div>
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {[
              [`Ризик ${risk.riskPct}%`, `$${size.riskUsd.toFixed(2)}`, c.down],
              ["До стопа", `${size.stopDistancePct.toFixed(2)}%`, undefined],
              ["Обсяг позиції", `$${Math.round(size.notionalUsd)}`, c.blue],
              [`Кількість ${coin(s.symbol)}`, String(Number(size.quantity.toPrecision(4))), undefined],
            ].map(([k, v, color]) => (
              <div key={k} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", borderRadius: 10, background: c.bg, border: `1px solid ${c.line}` }}>
                <span style={label}>{k}</span>
                <span style={{ ...num, fontSize: 16, fontWeight: 700, color }}>{v}</span>
              </div>
            ))}
          </div>
          {Number(deposit) > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: c.dim }}>
              <span>Плече</span>
              <div style={{ flex: 1, height: 6, borderRadius: 3, background: c.line }}>
                <div style={{ height: 6, borderRadius: 3, width: `${Math.min(100, (size.notionalUsd / Number(deposit) / 10) * 100)}%`, background: size.notionalUsd / Number(deposit) > 5 ? c.orange : c.blue }} />
              </div>
              <span style={{ ...num, color: c.ink }}>×{(size.notionalUsd / Number(deposit)).toFixed(1)}</span>
            </div>
          )}
        </>
      ) : (
        <p style={dim}>Вкажи депозит, і код порахує розмір від ризику {risk.riskPct}% на угоду.</p>
      )}
    </section>
  );
}

function Args({ title, items, good }: { title: string; items: string[]; good: boolean }) {
  if (!items.length) return null;
  const color = good ? c.up : c.down;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={label}>{title}</span>
      {items.map((t) => (
        <div key={t} style={{ display: "flex", gap: 8, ...p }}>
          <span aria-hidden style={{ flex: "none", width: 18, height: 18, borderRadius: 9, display: "grid", placeItems: "center", fontSize: 10, fontWeight: 800, background: `${color}26`, color, marginTop: 1 }}>{good ? "+" : "−"}</span>
          <span>{t}</span>
        </div>
      ))}
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
  return <SignalDetails s={s} busy={busy} journal={journal} onBack={onBack} />;
}

function SimilarHint({ who, v }: { who: string; v: Similar | null }) {
  if (!v) return null;
  const range = `${Math.round(v.from * 100)}–${Math.round(v.to * 100)}%`;
  if (v.n === 0) return <p style={dim}>Сигналів з оцінкою {who} {range} з відомим результатом ще немає.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: c.dim }}>
        З оцінкою {who} {range} ціна проходила +1R у {v.hits} з {v.n} випадків
      </span>
      <div style={{ display: "flex", gap: 2 }} aria-hidden>
        {Array.from({ length: v.n }, (_, i) => (
          <span key={i} style={{ flex: 1, maxWidth: 14, height: 8, borderRadius: 2, background: i < v.hits ? c.up : c.line }} />
        ))}
      </div>
    </div>
  );
}

function SignalDetails({ s, busy, journal, onBack }: { s: SignalFull; busy: boolean; journal: (a: "taken" | "skipped") => void; onBack: () => void }) {
  const open = s.status === "pending" || s.status === "active";
  const live = useLivePrice(open ? s.symbol : null);
  const r = s.reasoning;
  const decision = s.journal[0]?.action;
  return (
    <>
      <button type="button" className="press" style={{ ...secondary, alignSelf: "flex-start", minHeight: 40, fontSize: 14 }} onClick={onBack}>← Усі сигнали</button>
      <section style={card} className="rise">
        <Head s={s} />
        {live !== null && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <LiveDot />
            <span style={{ ...num, fontSize: 22, fontWeight: 700 }}>{fmtPrice(live)}</span>
            <Delta value={((live - entryMid(s.entry_low, s.entry_high)) / entryMid(s.entry_low, s.entry_high)) * 100} size={13} bg />
            <span style={{ fontSize: 12, color: c.dim }}>від входу</span>
          </div>
        )}
        {(open || netR(s) !== null) && (
          <RLadder value={open ? (live !== null ? rNow(s, live) : null) : netR(s)} caption={open ? (live !== null ? "Де ціна зараз між стопом і прибутком" : undefined) : "Результат після комісій"} />
        )}
        <SignalChart symbol={s.symbol} live={live} levels={{ entryLow: s.entry_low, entryHigh: s.entry_high, stop: s.stop, tp1: s.tp1, tp2: s.tp2, createdAt: Date.parse(s.created_at) }} />
        <Levels s={s} />
        {s.fee_r !== null && s.result_r !== null && <Row label="Без комісій / комісії" value={`${signed(s.result_r)}R / ${s.fee_r.toFixed(3)}R`} />}
      </section>
      {s.status !== "rejected" && (
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="press" style={{ ...(decision === "taken" ? { ...primary, background: c.up } : secondary), flex: 1 }} disabled={busy} onClick={() => journal("taken")}>✓ Взяв</button>
          <button type="button" className="press" style={{ ...(decision === "skipped" ? { ...primary, background: c.faint, color: c.ink } : secondary), flex: 1 }} disabled={busy} onClick={() => journal("skipped")}>✕ Пропустив</button>
        </div>
      )}
      {(s.p_analyst !== null || s.p_skeptic !== null) && (
        <section style={card}>
          <h2 style={h2}>Оцінки моделей</h2>
          <Votes s={s} size={56} />
          <SimilarHint who="аналітика" v={s.similar.analyst} />
          <SimilarHint who="скептика" v={s.similar.skeptic} />
        </section>
      )}
      {r && (
        <section style={card}>
          <h2 style={h2}>Аналітик · {pct(s.p_analyst)}</h2>
          <p style={p}>{r.analyst.summary}</p>
          <Args title="За" items={r.analyst.argumentsFor} good />
          <Args title="Проти" items={r.analyst.argumentsAgainst} good={false} />
          {r.analyst.invalidation && (
            <p style={{ ...dim, padding: "8px 10px", borderRadius: 10, background: `${c.orange}14`, borderLeft: `3px solid ${c.orange}` }}>Скасування: {r.analyst.invalidation}</p>
          )}
        </section>
      )}
      {r?.skeptic && (
        <section style={card}>
          <h2 style={h2}>Скептик · {pct(s.p_skeptic)}</h2>
          <p style={{ ...p, padding: "8px 10px", borderRadius: 10, background: `${c.down}14`, borderLeft: `3px solid ${c.down}` }}>{r.skeptic.strongestRisk}</p>
          <Args title="Проти" items={r.skeptic.argumentsAgainst} good={false} />
        </section>
      )}
      {r?.rejectedBy && <p style={dim}>Сигнал не опубліковано: {r.rejectedBy === "analyst" ? "аналітик радить пропустити" : "оцінка скептика нижча за поріг"}.</p>}
      {s.status !== "rejected" && <Calculator s={s} risk={s.risk} />}
      {s.events.length > 0 && (
        <section style={card}>
          <h2 style={h2}>Хід сигналу</h2>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {s.events.map((e, i) => {
              const color = e.type === "stop" ? c.down : e.type === "entry" ? c.blue : e.type === "exit" || e.type.startsWith("tp") ? c.up : c.dim;
              return (
                <div key={`${e.type}-${e.ts}`} style={{ display: "flex", gap: 12 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 12 }} aria-hidden>
                    <span style={{ width: 12, height: 12, borderRadius: 6, background: color, border: `2px solid ${c.card}`, boxShadow: `0 0 0 2px ${color}55`, marginTop: 4 }} />
                    {i < s.events.length - 1 && <span style={{ flex: 1, width: 2, background: c.line, minHeight: 18 }} />}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", paddingBottom: 12, minWidth: 0 }}>
                    <span style={{ ...p, fontWeight: 600 }}>{EVENT[e.type] ?? e.type}{e.price !== null && <span style={{ ...num, color: c.dim, fontWeight: 400 }}> · {e.price}</span>}</span>
                    <span style={{ fontSize: 12, color: c.dim }}>{day(e.ts)}, {time(e.ts)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
      <p style={dim}>
        {s.tp1 === null
          ? "Вхід за ринком у момент сигналу. Позицію закриває стоп або закриття свічки 4h за каналом 10 свічок: про вихід прийде сповіщення. Більшість угод закривається невеликим збитком, результат дають рідкі довгі тренди. Результат в R рахується від ціни входу і вже після комісій."
          : "Вхід зараховувався, коли ціна дійшла до середини зони; результат в R рахується від цієї ціни і вже після комісій."}{" "}
        Це аналіз, а не фінансова порада.
      </p>
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
      <Segmented options={(Object.keys(SCOPE) as Scope[]).map((k) => [k, SCOPE[k]])} value={scope} onChange={setScope} />
      {error && <p style={{ ...p, color: c.orange }}>{error}</p>}
      {list === null && !error && <p style={dim}>Завантажую…</p>}
      {list?.length === 0 && <EmptyRadar text={scope === "open" ? "Якісних входів зараз немає. Це нормальний стан: більшість сканів нічого не знаходить." : "Тут поки порожньо."} />}
      {scope === "closed" && list && list.length > 0 && <ResultStrip list={list} />}
      {list?.map((s) => <SignalTile key={s.id} s={s} onOpen={onOpen} full={scope !== "rejected"} />)}
    </>
  );
}

/** Картка сигналу в списку: для відкритих — жива ціна на драбині R. */
function SignalTile({ s, onOpen, full = true }: { s: SignalCard; onOpen: (id: number) => void; full?: boolean }) {
  const open = s.status === "pending" || s.status === "active";
  const live = useLivePrice(open ? s.symbol : null);
  const r = open ? (live !== null ? rNow(s, live) : null) : netR(s);
  const accent = s.side === "long" ? c.up : c.down;
  return (
    <button
      type="button"
      className="press rise"
      onClick={() => onOpen(s.id)}
      style={{ ...card, color: c.ink, textAlign: "left", font: "inherit", cursor: "pointer", borderLeft: `3px solid ${s.status === "rejected" ? c.faint : accent}` }}
    >
      <Head s={s} />
      {full && <Levels s={s} />}
      {full && (open || r !== null) && <RLadder value={r} caption={open && live === null ? "Жива ціна недоступна" : undefined} />}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Votes s={s} size={36} />
        {s.action && <Pill color={s.action === "taken" ? c.up : c.dim}>{s.action === "taken" ? "✓ взяв" : "✕ пропустив"}</Pill>}
      </div>
    </button>
  );
}

/** Порожній стан: радар, що шукає сетапи. */
function EmptyRadar({ text, title }: { text: string; title?: string }) {
  return (
    <section style={{ ...card, flexDirection: "row", alignItems: "center", gap: 14 }}>
      <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden style={{ flex: "none" }}>
        <circle cx="28" cy="28" r="26" fill="none" stroke={c.line} />
        <circle cx="28" cy="28" r="17" fill="none" stroke={c.line} />
        <circle cx="28" cy="28" r="8" fill="none" stroke={c.line} />
        <g className="spin" style={{ transformOrigin: "28px 28px" }}>
          <path d="M28 28 L28 2 A26 26 0 0 1 50.5 15 Z" fill={c.blue} opacity={0.25} />
          <line x1="28" y1="28" x2="28" y2="2" stroke={c.blue} strokeWidth="1.5" />
        </g>
        <circle cx="28" cy="28" r="2.5" fill={c.blue} />
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {title && <h2 style={h2}>{title}</h2>}
        <p style={dim}>{text}</p>
      </div>
    </section>
  );
}

/** Смуга результатів закритих сигналів: кожен стовпчик — одна угода в R. */
function ResultStrip({ list }: { list: SignalCard[] }) {
  const rs = list.map(netR).filter((v): v is number => v !== null).reverse();
  if (!rs.length) return null;
  const max = Math.max(1, ...rs.map(Math.abs));
  const total = rs.reduce((a, b) => a + b, 0);
  return (
    <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={label}>Останні {rs.length} угод</span>
        <span style={{ ...num, fontSize: 15, fontWeight: 700, color: tone(total) }}>{signed(total)}R</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 2, height: 64 }} role="img" aria-label={`Результати ${rs.length} угод, разом ${signed(total)}R`}>
        {rs.map((v, i) => (
          <div key={i} style={{ flex: 1, maxWidth: 16, height: "100%", display: "flex", flexDirection: "column", justifyContent: "center" }} title={`${signed(v)}R`}>
            <div style={{ height: "50%", display: "flex", alignItems: "flex-end" }}>
              {v > 0 && <div style={{ width: "100%", height: `${(v / max) * 100}%`, minHeight: 2, background: c.up, borderRadius: "3px 3px 0 0" }} />}
            </div>
            <div style={{ height: "50%" }}>
              {v <= 0 && <div style={{ width: "100%", height: `${(-v / max) * 100}%`, minHeight: 2, background: c.down, borderRadius: "0 0 3px 3px" }} />}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Відкриті сигнали для екрана «Сьогодні». */
export function OpenSignals({ onOpen, lastScan }: { onOpen: (id: number) => void; lastScan: string | null }) {
  const [list, setList] = useState<SignalCard[] | null>(null);
  useEffect(() => {
    api<{ signals: SignalCard[] }>("/api/signals?scope=open").then((d) => setList(d.signals), () => setList(null));
  }, []);
  if (!list) return null;
  if (!list.length) return <EmptyRadar title="Сигнали" text={`Якісних входів немає${lastScan ? `, останній скан о ${time(lastScan)}` : ""}. Радар шукає пробій 4h у бік тренду.`} />;
  return (
    <>
      {list.map((s) => <SignalTile key={s.id} s={s} onOpen={onOpen} />)}
    </>
  );
}
