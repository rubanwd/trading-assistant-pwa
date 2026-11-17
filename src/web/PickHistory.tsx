import { useEffect, useState } from "react";
import { fmtPrice } from "./live";
import { PickReasons, SIDE, VERDICT, distPct, type Idea, type PickGroup, type Side, type Status } from "./Pick";
import { EquityCurve } from "./Stats";
import { api, c, card, coin, day, dim, h2, label, num, p, pct, secondary, signed, time, tone } from "./ui";
import { Pill, Ring, Segmented, Skeleton, Stat } from "./viz";

type Verdict = Idea["verdict"];
type Outcome = "win" | "loss" | "open" | "none";
interface Row {
  id: number;
  created_at: string;
  symbol: string;
  side: Side;
  entry_kind: "market" | "pullback";
  entry: number;
  stop: number;
  target: number;
  score: number;
  verdict: Verdict;
  probability: number | null;
  status: Status;
  result_r: number | null;
  resolved_at: string | null;
  repeats: number;
  outcome: Outcome;
  /** R після комісій. */
  net_r: number | null;
}
interface Summary {
  all: PickGroup;
  byVerdict: Record<Verdict, PickGroup>;
  bySide: Record<Side, PickGroup>;
  byEntry: Record<"market" | "pullback", PickGroup>;
  calibration: { n: number; predicted: number | null; actual: number | null };
}
interface Response { from: string | null; summary: Summary; picks: Row[] }

type Period = "all" | "30" | "7";
type Filter = "all" | Verdict;
const PERIODS: [Period, string][] = [["all", "Увесь час"], ["30", "30 днів"], ["7", "7 днів"]];
const FILTERS: [Filter, string][] = [["all", "Усі"], ["pick", "Вибір ШІ"], ["pass", "ШІ: чекати"], ["none", "Лише ТА"]];

const OUTCOME: Record<Outcome, { text: string; icon: string; color: string }> = {
  win: { text: "підтвердилась", icon: "✓", color: c.up },
  loss: { text: "програла", icon: "✗", color: c.down },
  open: { text: "відкрита", icon: "◷", color: c.blue },
  none: { text: "без входу", icon: "–", color: c.faint },
};
/** Чим закрилась ідея: ціль, стоп чи час. */
const HOW: Partial<Record<Status, string>> = { target: "ціль", stop: "стоп", expired: "за часом" };

/** Рядок групи: частка підтверджених смужкою і результат після комісій. */
function GroupLine({ name, g }: { name: string; g: PickGroup }) {
  const closed = g.wins + g.losses;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "8px 0", borderBottom: `1px solid ${c.line}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14 }}>
        <span style={{ fontWeight: 600 }}>{name}</span>
        <span style={{ ...num, fontWeight: 700, color: closed ? tone(g.totalR) : c.dim }}>{closed ? `${signed(g.totalR)}R` : "—"}</span>
      </div>
      {closed > 0 ? (
        <>
          <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", gap: 2 }} aria-hidden>
            {g.wins > 0 && <div style={{ width: `${(g.wins / closed) * 100}%`, background: c.up }} />}
            {g.losses > 0 && <div style={{ flex: 1, background: `${c.down}AA` }} />}
          </div>
          <span style={{ ...num, fontSize: 12, color: c.dim }}>
            ✓ {g.wins} · ✗ {g.losses} · {pct(g.winRate)} підтвердились · середнє {g.avgR === null ? "—" : `${signed(g.avgR)}R`}
          </span>
        </>
      ) : (
        <span style={{ fontSize: 12, color: c.dim }}>{g.ideas ? `${g.ideas} ідей, жодна ще не закрилась` : "ідей немає"}</span>
      )}
    </div>
  );
}

function SummaryCard({ s, filter }: { s: Summary; filter: Filter }) {
  const g = s.all;
  const closed = g.wins + g.losses;
  const cal = s.calibration;
  return (
    <section style={card} className="rise">
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Ring value={g.winRate} size={88} stroke={8} color={c.up} track={closed ? `${c.down}88` : c.line} label="частка підтверджених ідей">
          <span style={{ ...num, fontSize: 20, fontWeight: 700 }}>{pct(g.winRate)}</span>
          <span style={{ fontSize: 9, color: c.dim }}>підтвердились</span>
        </Ring>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span style={{ ...num, fontSize: 26, fontWeight: 700, color: closed ? tone(g.totalR) : c.dim }}>{closed ? `${signed(g.totalR)}R` : "—"}</span>
          <span style={{ fontSize: 12, color: c.dim }}>
            разом після комісій · {closed} закритих із {g.ideas} ідей
          </span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <Stat label="Успішні" value={String(g.wins)} color={c.up} sub={`ціль ${g.target} · час ${g.wins - g.target}`} />
        <Stat label="Програли" value={String(g.losses)} color={c.down} sub={`стоп ${g.stop} · час ${g.losses - g.stop}`} />
        <Stat label="Середнє" value={g.avgR === null ? "—" : `${signed(g.avgR)}R`} color={g.avgR === null ? undefined : tone(g.avgR)} sub="на закриту ідею" />
        <Stat label="Відкриті" value={String(g.open)} color={c.blue} />
        <Stat label="Без входу" value={String(g.unfilled)} sub="лімітка не спрацювала" />
        <Stat label="Ідей" value={String(g.ideas)} sub="без повторів" />
      </div>
      {(filter === "all" || filter === "pick") && cal.n > 0 && cal.predicted !== null && cal.actual !== null && (
        <p style={{ ...dim, fontSize: 12 }}>
          Чесність ШІ: у середньому обіцяв <b style={{ color: c.violet }}>{pct(cal.predicted)}</b> на ціль, дійшло до цілі{" "}
          <b style={{ color: cal.actual >= cal.predicted ? c.up : c.orange }}>{pct(cal.actual)}</b> ({cal.n} закритих ідей ШІ).
        </p>
      )}
    </section>
  );
}

function Breakdown({ s, filter }: { s: Summary; filter: Filter }) {
  return (
    <section style={card}>
      <h2 style={h2}>Розріз</h2>
      {filter === "all" && (
        <>
          <span style={{ ...label, marginTop: 4 }}>Хто вибрав</span>
          <GroupLine name="Вибір ШІ" g={s.byVerdict.pick} />
          <GroupLine name="ШІ радив чекати (найкращий за ТА)" g={s.byVerdict.pass} />
          <GroupLine name="Лише технічний аналіз" g={s.byVerdict.none} />
        </>
      )}
      <span style={{ ...label, marginTop: 4 }}>Напрямок</span>
      <GroupLine name="▲ Лонг" g={s.bySide.long} />
      <GroupLine name="▼ Шорт" g={s.bySide.short} />
      <span style={{ ...label, marginTop: 4 }}>Вхід</span>
      <GroupLine name="За ринком" g={s.byEntry.market} />
      <GroupLine name="Лімітка на відкаті" g={s.byEntry.pullback} />
    </section>
  );
}

/** Рядок ідеї: торкнись, щоб побачити пояснення ШІ й ознаки балу. */
function IdeaRow({ r }: { r: Row }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Idea | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setOpen(!open);
    if (!detail && !open) api<Idea>(`/api/picks/${r.id}`).then(setDetail, (e) => setError(String(e)));
  };
  const o = OUTCOME[r.outcome];
  const side = SIDE[r.side];
  const v = VERDICT[r.verdict];
  return (
    <div style={{ borderBottom: `1px solid ${c.line}` }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{ width: "100%", background: "none", border: 0, color: c.ink, font: "inherit", textAlign: "left", padding: "10px 0", display: "flex", flexDirection: "column", gap: 4, cursor: "pointer" }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ ...num, fontSize: 12, color: c.dim, flex: "none" }}>{time(r.created_at)}</span>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{coin(r.symbol)}</span>
          <span style={{ color: side.color, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
            {side.icon} {side.text}
          </span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
            <Pill color={o.color} style={{ fontSize: 11 }}>
              {o.icon} {o.text}
            </Pill>
            {r.net_r !== null && <span style={{ ...num, fontWeight: 700, fontSize: 14, color: tone(r.net_r), minWidth: 52, textAlign: "right" }}>{signed(r.net_r)}R</span>}
          </span>
        </span>
        <span style={{ ...num, fontSize: 12, color: c.dim, display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
          <span>
            {r.entry_kind === "market" ? "ринок" : "лімітка"} <span style={{ color: c.blue }}>{fmtPrice(r.entry)}</span>
          </span>
          <span>
            стоп <span style={{ color: c.down }}>{fmtPrice(r.stop)}</span>
          </span>
          <span>
            ціль <span style={{ color: c.up }}>{fmtPrice(r.target)}</span>
          </span>
          {HOW[r.status] && <span>закрита: {HOW[r.status]}{r.resolved_at ? ` ${day(r.resolved_at)} ${time(r.resolved_at)}` : ""}</span>}
        </span>
        <span style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 11, color: c.dim }}>
          <span style={{ color: v.color }}>{v.text}</span>
          {r.probability !== null && <span>· ШІ {pct(r.probability)}</span>}
          <span>· бал {r.score}</span>
          {r.repeats > 0 && <span>· повторювалась ще {r.repeats}×</span>}
          <span style={{ marginLeft: "auto", color: c.blue }}>{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 0 12px" }}>
          {error ? (
            <p style={{ ...dim, color: c.orange }}>{error}</p>
          ) : !detail ? (
            <Skeleton height={80} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={{ ...num, fontSize: 12, color: c.dim }}>
                Ціна в момент ідеї {fmtPrice(detail.price)} · стоп {Math.abs(distPct(r.entry, r.stop)).toFixed(2)}% · ціль {Math.abs(distPct(r.entry, r.target)).toFixed(2)}% · горизонт {detail.horizon_hours} год
                {r.result_r !== null && r.net_r !== null ? ` · ${signed(r.result_r)}R до комісій` : ""}
              </span>
              {detail.body.ai?.summary && <p style={{ ...p, fontSize: 14, fontWeight: 600 }}>{detail.body.ai.summary}</p>}
              {detail.body.note && <p style={{ ...dim, fontSize: 12, color: c.orange }}>{detail.body.note}</p>}
              <PickReasons pick={detail} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Ідеї, згруповані за днем, від нових. */
function IdeaList({ rows }: { rows: Row[] }) {
  const [limit, setLimit] = useState(40);
  const shown = rows.slice(0, limit);
  const days: { day: string; rows: Row[] }[] = [];
  for (const r of shown) {
    const d = day(r.created_at);
    const last = days[days.length - 1];
    if (last?.day === d) last.rows.push(r);
    else days.push({ day: d, rows: [r] });
  }
  return (
    <section style={card}>
      <h2 style={h2}>Усі ідеї</h2>
      {!rows.length && <p style={dim}>За цей період ідей немає.</p>}
      {days.map((d) => (
        <div key={d.day} style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ ...label, paddingTop: 8 }}>{d.day}</span>
          {d.rows.map((r) => (
            <IdeaRow key={r.id} r={r} />
          ))}
        </div>
      ))}
      {rows.length > limit && (
        <button type="button" className="press" onClick={() => setLimit(limit + 40)} style={secondary}>
          Показати ще ({rows.length - limit})
        </button>
      )}
    </section>
  );
}

/**
 * Історія й облік ідей скану: кожна рекомендація з результатом, підсумки, розріз і крива результату.
 * Результат рахує код за свічками 1h; R — після комісій.
 */
export function PickHistory({ onBack }: { onBack: () => void }) {
  const [period, setPeriod] = useState<Period>("all");
  const [filter, setFilter] = useState<Filter>("all");
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    api<Response>(`/api/picks?period=${period}&verdict=${filter}`).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(String(e)),
    );
  }, [period, filter]);
  const curve = (data?.picks ?? [])
    .filter((r) => r.net_r !== null)
    .map((r) => ({ r: r.net_r!, at: r.resolved_at ?? r.created_at, symbol: r.symbol }))
    .sort((a, b) => a.at.localeCompare(b.at));
  return (
    <>
      <button type="button" style={{ ...secondary, alignSelf: "flex-start" }} onClick={onBack}>
        ← Назад
      </button>
      <p style={{ ...p, color: c.dim }}>
        Кожна ідея скану з результатом. Підтвердилась — ціна дійшла до цілі раніше за стоп або ідея закрилась за часом у плюсі; програла — стоп або
        закриття за часом у мінусі. Результат рахує код за свічками 1h, R — після комісій. Повтори тієї самої ідеї в наступних сканах окремо не рахуються.
      </p>
      <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      <Segmented options={FILTERS} value={filter} onChange={setFilter} size="sm" />
      {error && <p style={{ ...p, color: c.orange }}>{error}</p>}
      {!data && !error && (
        <>
          <Skeleton height={190} />
          <Skeleton height={240} />
        </>
      )}
      {data && (
        <>
          <SummaryCard s={data.summary} filter={filter} />
          <EquityCurve trades={curve} title="Крива результату ідей" unit="ідей" />
          <Breakdown s={data.summary} filter={filter} />
          <IdeaList rows={data.picks} />
        </>
      )}
    </>
  );
}
