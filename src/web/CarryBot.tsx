import { useEffect, useState } from "react";
import type { BotInfo, CarryConfig } from "../shared/bots";
import { CARRY_BACKTEST } from "../shared/tubeBacktest";
import { PERIODS, type Period } from "./botParts";
import { api, c, card, coin, day, dim, h2, label, num, p, pct, secondary, signed, time, tone } from "./ui";
import { Meter, Pill, Segmented, Skeleton, Stat } from "./viz";

/** Сторінка бота Funding Carry: спот у лонг і шорт контракту, дохід — фандинг. Облік у % капіталу бота, а не в R. */

interface Ranked { symbol: string; apr: number | null; spot: boolean; open: boolean }
interface Detail {
  universe: { source: string; size: number; withSpot: number; error: string | null };
  ranked: Ranked[];
  entered: { symbol: string; apr: number }[];
  exited: { symbol: string; apr: number | null; reason: string; netPct: number }[];
  fundingPct: number;
  feePct: number;
  open: number;
  note: string | null;
  errors: string[];
}
interface Position {
  id: number;
  opened_at: string;
  symbol: string;
  share: number;
  entry_apr: number;
  entry_price: number | null;
  status: "open" | "closed";
  closed_at: string | null;
  exit_apr: number | null;
  exit_price: number | null;
  funding: number;
  payments: number;
  fee: number;
  reason: string | null;
  net_pct: number;
}
interface PeriodSum { days: number; fundingPct: number; feePct: number; netPct: number; aprPct: number | null; busyDays: number }
interface Page {
  bot: BotInfo;
  enabled: boolean;
  config: CarryConfig;
  takerPct: number;
  last: { at: string; status: string; error: string | null; detail: Detail } | null;
  cycles: { at: string; status: string; error: string | null; detail: Detail }[];
  period: PeriodSum;
  open: Position[];
  closed: Position[];
  closedSummary: { count: number; wins: number; netPct: number };
}

const pctText = (v: number | null, digits = 2) => (v === null ? "—" : `${signed(v, digits)}%`);
const REASON: Record<string, string> = { below_exit: "фандинг нижче порогу", no_data: "немає ставок (контракт зник?)" };
const daysBetween = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 86_400_000);

function Header({ d }: { d: Page }) {
  const cfg = d.config;
  const stale = d.last ? Date.now() - Date.parse(d.last.at) > 26 * 3_600_000 : false;
  return (
    <section style={card} className="rise">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 24, fontWeight: 800 }}>{d.bot.name}</span>
        <Pill color={d.enabled ? c.up : c.faint} style={{ marginLeft: "auto" }}>
          {d.enabled ? "працює" : "вимкнено"}
        </Pill>
      </div>
      <p style={dim}>{d.bot.summary}</p>
      <p style={{ ...p, fontSize: 13 }}>
        Позиція — {Math.round(100 / cfg.maxPositions)}% капіталу бота: купівля на споті й шорт контракту на той самий обсяг, тож зміна ціни гаситься. Коли фандинг
        додатний, лонги платять шортам — це дохід бота. Раз на добу після 00:00 UTC бот рахує середній фандинг за {cfg.lookbackDays} {cfg.lookbackDays === 1 ? "добу" : "доби"} у %
        річних: від {cfg.entryApr}% входить (найвищий першим), нижче {cfg.exitApr}% виходить. Комісії taker на обох ногах при вході й виході: спот 0.1%, контракт {d.takerPct}%.
      </p>
      {d.last ? (
        <span style={{ fontSize: 12, color: stale ? c.orange : c.dim }}>
          Остання доба: {day(d.last.at)}, {time(d.last.at)}
          {stale ? " · давно не було циклу" : ""}
        </span>
      ) : (
        <span style={{ fontSize: 12, color: c.dim }}>Бот ще не мав жодного циклу: перший — у першу годину нової доби UTC.</span>
      )}
    </section>
  );
}

function Summary({ d }: { d: Page }) {
  const s = d.period;
  const openNet = d.open.reduce((sum, x) => sum + x.net_pct, 0);
  return (
    <section style={card}>
      <h2 style={h2}>Результат</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <Stat label="Разом" value={s.days ? pctText(s.netPct) : "—"} color={s.days ? tone(s.netPct) : undefined} sub="капіталу, після комісій" />
        <Stat label="Річних" value={pctText(s.aprPct, 1)} color={s.aprPct === null ? undefined : tone(s.aprPct)} sub={s.aprPct === null ? "мало днів" : `за ${s.days} дн`} />
        <Stat label="Позицій" value={`${d.open.length} з ${d.config.maxPositions}`} sub={`зайнято ${s.days ? Math.round((s.busyDays / s.days) * 100) : 0}% днів`} />
      </div>
      <span style={{ ...num, fontSize: 12, color: c.dim }}>
        фандинг {pctText(s.fundingPct)} · комісії −{s.feePct.toFixed(2)}% · відкриті позиції зараз {pctText(openNet, 3)} · закрито {d.closedSummary.count}, у плюсі {d.closedSummary.wins}
      </span>
    </section>
  );
}

function Funding({ d }: { d: Page }) {
  const det = d.last?.detail;
  if (!det) return null;
  const cfg = d.config;
  const max = Math.max(cfg.entryApr * 2, ...det.ranked.map((r) => r.apr ?? 0));
  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2 style={h2}>Фандинг монет</h2>
        <span style={{ fontSize: 12, color: c.dim, marginLeft: "auto" }}>за {cfg.lookbackDays} дн, % річних</span>
      </div>
      <span style={{ fontSize: 12, color: c.dim }}>
        Список: {det.universe.size} монет ({det.universe.source === "coingecko" ? "топ за капіталізацією" : "стартовий список"}), зі спотом на Bybit — {det.universe.withSpot}
      </span>
      {det.ranked.map((r) => (
        <div key={r.symbol} style={{ display: "grid", gridTemplateColumns: "72px minmax(0, 1fr) 72px", alignItems: "center", gap: 8, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>
            {coin(r.symbol)}
            {r.open && <span style={{ color: c.blue }}> ●</span>}
          </span>
          <Meter value={r.apr === null ? null : Math.max(0, Math.min(1, r.apr / max))} marker={cfg.entryApr / max} color={r.apr !== null && r.apr >= cfg.entryApr ? c.up : r.apr !== null && r.apr < cfg.exitApr ? c.faint : c.blue} />
          <span style={{ ...num, textAlign: "right", color: r.spot ? tone(r.apr) : c.faint }}>{r.apr === null ? "—" : `${r.apr.toFixed(1)}%`}</span>
        </div>
      ))}
      <span style={{ fontSize: 11, color: c.faint }}>● — відкрита позиція · риска — поріг входу {cfg.entryApr}%</span>
      {det.note && <p style={{ ...dim, fontSize: 12 }}>{det.note}</p>}
      {det.errors.length > 0 && <p style={{ ...dim, fontSize: 12, color: c.orange }}>Помилки: {det.errors.slice(0, 3).join("; ")}</p>}
    </section>
  );
}

function PositionRow({ x }: { x: Position }) {
  const held = daysBetween(x.opened_at, x.closed_at ?? new Date().toISOString());
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "8px 0", borderBottom: `1px solid ${c.line}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14 }}>
        <span style={{ fontWeight: 600 }}>{coin(x.symbol)}</span>
        <span style={{ ...num, fontWeight: 700, color: tone(x.net_pct) }}>{pctText(x.net_pct, 3)}</span>
      </div>
      <span style={{ ...num, fontSize: 12, color: c.dim }}>
        {day(x.opened_at)}
        {x.closed_at ? ` — ${day(x.closed_at)}` : ""} · {held.toFixed(1)} дн · вхід при {x.entry_apr.toFixed(1)}%
        {x.status === "closed" ? ` · вихід при ${x.exit_apr === null ? "—" : `${x.exit_apr.toFixed(1)}%`} (${REASON[x.reason ?? ""] ?? x.reason ?? "—"})` : ""}
      </span>
      <span style={{ ...num, fontSize: 12, color: c.dim }}>
        фандинг {pctText(x.funding * 100, 3)} обсягу за {x.payments} нарах. · комісії −{(x.fee * 100).toFixed(2)}% · частка {Math.round(x.share * 100)}% капіталу
      </span>
    </div>
  );
}

function Positions({ title, rows, empty }: { title: string; rows: Position[]; empty: string }) {
  return (
    <section style={card}>
      <h2 style={h2}>{title}</h2>
      {rows.length ? rows.map((x) => <PositionRow key={x.id} x={x} />) : <p style={dim}>{empty}</p>}
    </section>
  );
}

function Backtest() {
  const b = CARRY_BACKTEST;
  const [open, setOpen] = useState(false);
  const full = b.periods.find((x) => x.key === "full")!;
  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2 style={h2}>Бектест</h2>
        <span style={{ fontSize: 12, color: c.dim, marginLeft: "auto" }}>
          {b.from} — {b.to}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <Stat label="Річних" value={pctText(full.aprPct, 1)} color={tone(full.aprPct)} />
        <Stat label="Просадка" value={`${full.maxDrawdownPct}%`} color={c.down} />
        <Stat label="Зайнято" value={pct(full.utilization)} sub={`${full.trades} угод`} />
      </div>
      <p style={{ ...p, fontSize: 13 }}>{b.verdict}</p>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 52px 64px", gap: 6, fontSize: 11, color: c.faint }}>
        <span />
        <span style={{ textAlign: "right" }}>угод</span>
        <span style={{ textAlign: "right" }}>річних</span>
      </div>
      {b.periods
        .filter((x) => x.key !== "full")
        .map((s) => (
          <div key={s.key} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 0", borderBottom: `1px solid ${c.line}` }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 52px 64px", gap: 6, fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>{s.label}</span>
              <span style={{ ...num, textAlign: "right" }}>{s.trades}</span>
              <span style={{ ...num, textAlign: "right", fontWeight: 700, color: tone(s.aprPct) }}>{pctText(s.aprPct, 1)}</span>
            </div>
            {s.note && <span style={{ fontSize: 11, color: c.dim }}>{s.note}</span>}
          </div>
        ))}
      <button type="button" onClick={() => setOpen(!open)} style={{ background: "none", border: 0, color: c.blue, font: "600 13px Inter, system-ui, sans-serif", textAlign: "left", padding: 0, minHeight: 32, cursor: "pointer" }}>
        {open ? "Сховати ▴" : "Що ще перевірено ▾"}
      </button>
      {open && b.findings.map((f) => <p key={f} style={{ ...dim, fontSize: 12 }}>• {f}</p>)}
      <p style={{ ...dim, fontSize: 11 }}>{b.source}</p>
    </section>
  );
}

function Journal({ cycles }: { cycles: Page["cycles"] }) {
  return (
    <section style={card}>
      <h2 style={h2}>Журнал діб</h2>
      {cycles.length === 0 && <p style={dim}>Ще порожньо.</p>}
      {cycles.map((x) => (
        <div key={x.at} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 0", borderBottom: `1px solid ${c.line}`, fontSize: 13 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontWeight: 600 }}>{day(x.at)}</span>
            <span style={{ ...num, color: tone(x.detail.fundingPct - x.detail.feePct) }}>{pctText(x.detail.fundingPct - x.detail.feePct, 3)}</span>
          </div>
          <span style={{ fontSize: 12, color: x.status === "error" ? c.orange : c.dim }}>
            позицій {x.detail.open}
            {x.detail.entered.length ? ` · вхід: ${x.detail.entered.map((e) => `${coin(e.symbol)} ${e.apr.toFixed(0)}%`).join(", ")}` : ""}
            {x.detail.exited.length ? ` · вихід: ${x.detail.exited.map((e) => coin(e.symbol)).join(", ")}` : ""}
            {x.error ? ` · ${x.error}` : ""}
          </span>
        </div>
      ))}
    </section>
  );
}

export function CarryView({ onBack }: { onBack: () => void }) {
  const [period, setPeriod] = useState<Period>("all");
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Page>(`/api/bots/carry?period=${period}`).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(String(e)),
    );
  }, [period]);
  return (
    <>
      <button type="button" style={{ ...secondary, alignSelf: "flex-start" }} onClick={onBack}>
        ← Усі боти
      </button>
      {error && <p style={{ ...p, color: c.orange }}>{error}</p>}
      {!data && !error && (
        <>
          <Skeleton height={170} />
          <Skeleton height={320} />
        </>
      )}
      {data && (
        <>
          <Header d={data} />
          <Segmented options={PERIODS} value={period} onChange={setPeriod} />
          <Summary d={data} />
          <Positions title="Відкриті позиції" rows={data.open} empty="Зараз жодна монета не має фандингу вище порогу входу: капітал вільний." />
          <Funding d={data} />
          <Backtest />
          <Positions title="Закриті позиції" rows={data.closed} empty="Закритих позицій за період немає." />
          <Journal cycles={data.cycles} />
          <p style={{ ...dim, fontSize: 11 }}>
            <span style={label}>Паперова торгівля</span> Ордери на біржу не йдуть, торгових ключів немає. Фандинг — фактичні ставки Bybit у моменти нарахування. Не враховано
            зміну базису (різниці ціни контракту й споту) між входом і виходом.
          </p>
        </>
      )}
    </>
  );
}
