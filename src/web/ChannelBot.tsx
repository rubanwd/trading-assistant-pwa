import { useEffect, useState } from "react";
import type { BotId, BotInfo, ChannelConfig } from "../shared/bots";
import { positionSize } from "../shared/risk";
import { Backtest, GroupLine, OUTCOME, PERIODS, SIDE, type Group, type Outcome, type Period, type Side } from "./botParts";
import { fmtPrice, useLivePrice } from "./live";
import { EquityCurve } from "./Stats";
import { api, c, card, coin, day, dim, h2, label, num, p, pct, secondary, signed, time, tone } from "./ui";
import { LiveDot, Pill, PriceChart, Ring, Segmented, Skeleton, Stat, useCandles } from "./viz";

/** Сторінка бота Channel 20/10: денний пробій каналу BTC, одна позиція, стоп підтягується щодня, без тейка. */

type Action = "placed" | "ignored" | "expired" | "disabled" | "none";
interface Levels { upper: number; lower: number; longStop: number | null; shortStop: number | null }
interface SignalInfo { day: string; side: Side | null; close: number; upper: number; lower: number; action: Action; note: string | null }
interface Detail {
  symbol: string;
  price: number | null;
  levels: Levels | null;
  signal: SignalInfo | null;
  position: { id: number; side: Side; status: "pending" | "open"; entry: number; stop: number; initialStop: number; filledAt: string | null; r: number | null } | null;
  note: string | null;
  errors: string[];
}
interface Body {
  signal: { day: number; close: number; upper: number; lower: number };
  cfg: { entryDays: number; exitDays: number };
  atrPct: number | null;
  trailed: { day: string; stop: number }[];
  exit: { price: number; from: number; to: number; gap: boolean; daily: boolean } | null;
  funding: { r: number; events: number; ambiguous: number } | null;
  skip: "beyond_stop" | "no_price" | null;
}
interface Order {
  id: number;
  created_at: string;
  symbol: string;
  side: Side;
  price: number;
  entry: number;
  stop: number;
  trail_stop: number | null;
  status: "pending" | "cancelled" | "open" | "stop";
  filled_at: string | null;
  resolved_at: string | null;
  exit_price: number | null;
  result_r: number | null;
  fee_r: number | null;
}
interface Trade extends Order { outcome: Outcome; net_r: number | null }
interface Cycle { at: string; status: string; error: string | null; placed: number; open: number; note: string | null; signal: SignalInfo | null; trailed: { day: string; stop: number }[]; errors: string[] }
interface Page {
  bot: BotInfo;
  enabled: boolean;
  config: ChannelConfig;
  riskPct: number;
  depositUsd: number | null;
  last: { at: string; status: string; error: string | null; detail: Detail } | null;
  cycles: Cycle[];
  active: (Order & { body: Body })[];
  summary: { all: Group; bySide: Record<Side, Group> };
  trades: Trade[];
}

const ACTION: Record<Action, string> = {
  placed: "вхід за ринком",
  ignored: "проігноровано: позиція вже відкрита",
  expired: "прострочено",
  disabled: "бот вимкнено",
  none: "пробою немає",
};

const distPct = (from: number, to: number) => ((to - from) / from) * 100;
const days = (from: string, to: string | null) => Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 86_400_000);

/** До закриття доби UTC: «через 5 год 12 хв». */
function untilClose(now = Date.now()): string {
  const left = 86_400_000 - (now % 86_400_000);
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return h ? `через ${h} год ${m} хв` : `через ${m} хв`;
}

function Header({ d }: { d: Page }) {
  const cfg = d.config;
  const stale = d.last ? Date.now() - Date.parse(d.last.at) > 2 * 3_600_000 : false;
  return (
    <section style={card} className="rise">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 24, fontWeight: 800 }}>{d.bot.name}</span>
        <Pill color={d.enabled ? c.up : c.faint} style={{ marginLeft: "auto" }}>
          {d.enabled ? "працює" : "вимкнено"}
        </Pill>
      </div>
      <p style={{ ...dim, fontSize: 13 }}>{d.bot.summary}</p>
      {d.last?.detail.note && <p style={{ ...dim, fontSize: 12, color: c.orange }}>{d.last.detail.note}</p>}
      {!d.last && <p style={dim}>Бот ще не працював: перша година почнеться з найближчим запуском рушія.</p>}
      {stale && <p style={{ ...dim, fontSize: 12, color: c.orange }}>Остання година бота понад 2 години тому: цикл, схоже, не запускався.</p>}
      <p style={{ ...dim, fontSize: 12 }}>
        {coin(cfg.symbol)} · свічки 1d UTC · вхід: закриття доби за каналом {cfg.entryDays} діб · стоп: канал {cfg.exitDays} діб, лише в бік зменшення ризику · без тейка · одна позиція · вікно входу {cfg.entryWindowHours} год ·
        ризик {d.riskPct}% на угоду
      </p>
    </section>
  );
}

/** Зараз: позиція або межі каналу, з якими порівнюватиметься наступне закриття доби. */
function Now({ d }: { d: Page }) {
  const symbol = d.config.symbol;
  const live = useLivePrice(symbol);
  const { candles } = useCandles(symbol, "1d", 60);
  const det = d.last?.detail ?? null;
  const pos = d.active[0] ?? null;
  const price = live ?? det?.price ?? null;
  const lv = det?.levels ?? null;
  const stop = pos ? (pos.trail_stop ?? pos.stop) : null;
  const levels: { price: number; color: string; label: string }[] = [];
  if (pos && stop !== null) {
    if (pos.status === "open") levels.push({ price: pos.entry, color: c.blue, label: `вхід ${fmtPrice(pos.entry)}` });
    levels.push({ price: stop, color: c.down, label: `стоп ${fmtPrice(stop)}` });
  } else if (lv) {
    levels.push({ price: lv.upper, color: c.up, label: `лонг вище ${fmtPrice(lv.upper)}` }, { price: lv.lower, color: c.down, label: `шорт нижче ${fmtPrice(lv.lower)}` });
  }
  const risk = pos ? Math.abs(pos.entry - pos.stop) : 0;
  const r = pos?.status === "open" && price !== null && risk > 0 ? ((price - pos.entry) / risk) * (pos.side === "long" ? 1 : -1) : null;
  const locked = pos?.status === "open" && stop !== null && risk > 0 ? ((stop - pos.entry) / risk) * (pos.side === "long" ? 1 : -1) : null;
  const size = pos && d.depositUsd ? positionSize(d.depositUsd, d.riskPct, pos.entry, pos.stop) : null;
  return (
    <section style={{ ...card, gap: 12 }} className="rise">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2 style={h2}>Зараз</h2>
        <span style={{ fontSize: 12, color: c.dim, marginLeft: "auto" }}>закриття доби {untilClose()}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22, fontWeight: 800 }}>{coin(symbol)}</span>
        {pos && (
          <Pill color={SIDE[pos.side].color}>
            {SIDE[pos.side].icon} {SIDE[pos.side].text} · {pos.status === "open" ? "позиція" : "вхід за ринком"}
          </Pill>
        )}
        <span style={{ ...num, marginLeft: "auto", fontSize: 16, fontWeight: 600 }}>{price === null ? "—" : fmtPrice(price)}</span>
        {live !== null && <LiveDot />}
      </div>
      {candles?.length ? <PriceChart candles={candles} live={live} height={180} levels={levels} /> : <Skeleton height={200} />}
      {pos ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
          <Stat label="Зараз" value={r === null ? "—" : `${signed(r)}R`} color={r === null ? undefined : tone(r)} sub={pos.filled_at ? `з ${day(pos.filled_at)}` : "чекає входу"} />
          <Stat label="Стоп" value={stop === null ? "—" : fmtPrice(stop)} color={c.down} sub={locked === null ? undefined : `гарантує ${signed(locked)}R`} />
          <Stat label="Вхід" value={fmtPrice(pos.entry)} sub={size ? `розмір $${Math.round(size.notionalUsd).toLocaleString("uk-UA")}` : pos.status === "open" ? `${days(pos.filled_at!, null).toFixed(0)} дн` : "за ринком"} />
        </div>
      ) : lv && price !== null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ ...num, fontSize: 13 }}>
            <span style={{ color: c.up, fontWeight: 700 }}>▲ Лонг</span>, якщо доба закриється вище {fmtPrice(lv.upper)} ({signed(distPct(price, lv.upper))}%), стоп {lv.longStop === null ? "—" : fmtPrice(lv.longStop)}
          </span>
          <span style={{ ...num, fontSize: 13 }}>
            <span style={{ color: c.down, fontWeight: 700 }}>▼ Шорт</span>, якщо нижче {fmtPrice(lv.lower)} ({signed(distPct(price, lv.lower))}%), стоп {lv.shortStop === null ? "—" : fmtPrice(lv.shortStop)}
          </span>
        </div>
      ) : (
        <p style={dim}>Межі каналу з'являться після першої години бота.</p>
      )}
      {pos && pos.body.trailed.length > 0 && (
        <p style={{ ...dim, fontSize: 12 }}>
          Стоп підтягнуто {pos.body.trailed.length} раз: {fmtPrice(pos.stop)} → {fmtPrice(stop!)}. Новий рівень діє з наступної доби після закриття.
        </p>
      )}
      <p style={{ ...dim, fontSize: 11 }}>
        Межі — найбільший High і найменший Low останніх {d.config.entryDays} діб; сигнал дає лише закриття доби за ними, не дотик. Виконання паперове: вхід за першою ціною 15m після
        закриття доби, стоп за свічками 15m Bybit.
      </p>
    </section>
  );
}

function SummaryCard({ d }: { d: Page }) {
  const g = d.summary.all;
  const pctDeposit = g.totalR * d.riskPct;
  return (
    <section style={card} className="rise">
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Ring value={g.winRate} size={88} stroke={8} color={c.up} track={g.closed ? `${c.down}88` : c.line} label="частка угод у плюсі">
          <span style={{ ...num, fontSize: 20, fontWeight: 700 }}>{pct(g.winRate)}</span>
          <span style={{ fontSize: 9, color: c.dim }}>у плюсі</span>
        </Ring>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span style={{ ...num, fontSize: 26, fontWeight: 700, color: g.closed ? tone(g.totalR) : c.dim }}>{g.closed ? `${signed(g.totalR)}R` : "—"}</span>
          <span style={{ fontSize: 12, color: c.dim }}>
            після комісій і фандингу · {g.closed} закритих угод
            {g.closed ? ` · ${signed(pctDeposit)}% депозиту` : ""}
            {g.closed && d.depositUsd ? ` (${signed((pctDeposit / 100) * d.depositUsd, 0)} $)` : ""}
          </span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <Stat label="Середнє" value={g.avgR === null ? "—" : `${signed(g.avgR, 3)}R`} color={g.avgR === null ? undefined : tone(g.avgR)} sub="на угоду" />
        <Stat label="Відкрито" value={String(g.open)} color={c.blue} />
        <Stat label="Без входу" value={String(g.cancelled)} sub="ціна вже за стопом" />
      </div>
      <GroupLine name="▲ Лонг" g={d.summary.bySide.long} />
      <GroupLine name="▼ Шорт" g={d.summary.bySide.short} />
      <p style={{ ...dim, fontSize: 11 }}>R рахується від стопа на момент входу; вихід за підтягнутим стопом може бути в плюсі. Результат — у R, тож від розміру депозиту не залежить.</p>
    </section>
  );
}

function TradeRow({ t, id }: { t: Trade; id: BotId }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<(Order & { body: Body }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setOpen(!open);
    if (!detail && !open) api<Order & { body: Body }>(`/api/bots/${id}/orders/${t.id}`).then(setDetail, (e) => setError(String(e)));
  };
  const side = SIDE[t.side];
  const o = OUTCOME[t.outcome];
  const b = detail?.body;
  return (
    <div style={{ borderBottom: `1px solid ${c.line}` }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{ width: "100%", background: "none", border: 0, color: c.ink, font: "inherit", textAlign: "left", padding: "10px 0", display: "flex", flexDirection: "column", gap: 4, cursor: "pointer" }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ ...num, fontSize: 12, color: c.dim, flex: "none" }}>{day(t.filled_at ?? t.created_at)}</span>
          <span style={{ color: side.color, fontSize: 14, fontWeight: 700, whiteSpace: "nowrap" }}>
            {side.icon} {side.text}
          </span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
            <Pill color={o.color} style={{ fontSize: 11 }}>
              {o.icon} {t.status === "open" ? "позиція" : t.status === "stop" ? "вихід за стопом" : o.text}
            </Pill>
            {t.net_r !== null && <span style={{ ...num, fontWeight: 700, fontSize: 14, color: tone(t.net_r), minWidth: 56, textAlign: "right" }}>{signed(t.net_r)}R</span>}
          </span>
        </span>
        <span style={{ ...num, fontSize: 12, color: c.dim, display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
          <span>
            вхід <span style={{ color: c.blue }}>{fmtPrice(t.entry)}</span>
          </span>
          <span>
            стоп <span style={{ color: c.down }}>{fmtPrice(t.stop)}</span>
            {t.trail_stop !== null && t.trail_stop !== t.stop ? ` → ${fmtPrice(t.trail_stop)}` : ""}
          </span>
          {t.exit_price !== null && t.resolved_at && <span>вихід {fmtPrice(t.exit_price)} {day(t.resolved_at)}</span>}
          {t.filled_at && <span>{days(t.filled_at, t.resolved_at).toFixed(0)} дн</span>}
          <span style={{ marginLeft: "auto", color: c.blue }}>{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 0 12px" }}>
          {error ? (
            <p style={{ ...dim, color: c.orange }}>{error}</p>
          ) : !detail || !b ? (
            <Skeleton height={60} />
          ) : (
            <p style={{ ...num, ...dim, fontSize: 12 }}>
              Сигнал {day(new Date(b.signal.day).toISOString())}: закриття {fmtPrice(b.signal.close)} при каналі {fmtPrice(b.signal.lower)} … {fmtPrice(b.signal.upper)} ({b.cfg.entryDays}/{b.cfg.exitDays})
              {b.atrPct !== null ? ` · ATR 1d ${b.atrPct.toFixed(1)}%` : ""} · стоп на вході {Math.abs(distPct(t.entry, t.stop)).toFixed(1)}%
              {b.trailed.length ? ` · стоп підтягнуто ${b.trailed.length} раз` : ""}
              {b.exit ? ` · вихід ${b.exit.gap ? "за Open (геп за стопом)" : "за стопом"}${b.exit.daily ? ", перевірено денною свічкою" : ""}` : ""}
              {detail.result_r !== null ? ` · ${signed(detail.result_r)}R до витрат` : ""}
              {b.funding ? ` · фандинг ${signed(b.funding.r, 3)}R (${b.funding.events} нарахувань${b.funding.ambiguous ? `, ${b.funding.ambiguous} неоднозначних` : ""})` : ""}
              {detail.fee_r !== null && b.funding ? ` · комісії ${(detail.fee_r + b.funding.r).toFixed(3)}R` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Trades({ trades, id }: { trades: Trade[]; id: BotId }) {
  const [limit, setLimit] = useState(30);
  return (
    <section style={card}>
      <h2 style={h2}>Угоди</h2>
      {!trades.length && <p style={dim}>За цей період угод не було: бот входить лише після закриття доби за межею каналу, у середньому раз на місяць.</p>}
      {trades.slice(0, limit).map((t) => (
        <TradeRow key={t.id} t={t} id={id} />
      ))}
      {trades.length > limit && (
        <button type="button" className="press" onClick={() => setLimit(limit + 30)} style={secondary}>
          Показати ще ({trades.length - limit})
        </button>
      )}
    </section>
  );
}

/** Журнал: денні сигнали, перерахунки стопа й збої. Порожні години не показуються. */
function Journal({ cycles }: { cycles: Cycle[] }) {
  const [open, setOpen] = useState(false);
  const rows = cycles.filter((x) => x.signal || x.trailed.length || x.note || x.error || x.errors.length);
  if (!rows.length) return null;
  return (
    <section style={card}>
      <button type="button" onClick={() => setOpen(!open)} style={{ background: "none", border: 0, color: c.ink, font: "inherit", textAlign: "left", padding: 0, display: "flex", alignItems: "baseline", gap: 8, cursor: "pointer" }}>
        <h2 style={h2}>Журнал</h2>
        <span style={{ fontSize: 12, color: c.blue, marginLeft: "auto" }}>{open ? "сховати ▴" : `${rows.length} подій ▾`}</span>
      </button>
      {open &&
        rows.map((x) => (
          <div key={x.at} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 0", borderTop: `1px solid ${c.line}`, fontSize: 12 }}>
            <span style={{ ...num, color: c.dim }}>
              {day(x.at)} {time(x.at)}
            </span>
            {x.signal && (
              <span>
                <span style={label}>Доба {x.signal.day}</span>{" "}
                {x.signal.side ? (
                  <span style={{ color: SIDE[x.signal.side].color, fontWeight: 600 }}>
                    {SIDE[x.signal.side].icon} {SIDE[x.signal.side].text}
                  </span>
                ) : null}{" "}
                закриття {fmtPrice(x.signal.close)}, канал {fmtPrice(x.signal.lower)} … {fmtPrice(x.signal.upper)} · {ACTION[x.signal.action]}
                {x.signal.note ? ` (${x.signal.note})` : ""}
              </span>
            )}
            {x.trailed.map((t) => (
              <span key={t.day} style={{ color: c.dim }}>
                стоп після закриття {t.day}: {fmtPrice(t.stop)}
              </span>
            ))}
            {(x.note || x.error) && <span style={{ color: c.orange }}>{x.note ?? x.error}</span>}
            {x.errors.map((e) => (
              <span key={e} style={{ color: c.orange }}>
                {e}
              </span>
            ))}
          </div>
        ))}
    </section>
  );
}

export function ChannelView({ id, onBack }: { id: Exclude<BotId, "carry">; onBack: () => void }) {
  const [period, setPeriod] = useState<Period>("all");
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Page>(`/api/bots/${id}?period=${period}`).then(
      (d) => {
        setData(d);
        setError(null);
      },
      (e) => setError(String(e)),
    );
  }, [id, period]);
  const curve = (data?.trades ?? [])
    .filter((t) => t.net_r !== null)
    .map((t) => ({ r: t.net_r!, at: t.resolved_at ?? t.created_at, symbol: t.symbol }))
    .sort((a, b) => a.at.localeCompare(b.at));
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
          <Now d={data} />
          <Segmented options={PERIODS} value={period} onChange={setPeriod} />
          <SummaryCard d={data} />
          <EquityCurve trades={curve} title="Крива результату бота" />
          <Backtest id={id} mode="channel" />
          <Trades trades={data.trades} id={id} />
          <Journal cycles={data.cycles} />
          <p style={{ ...dim, fontSize: 11 }}>
            Паперова торгівля: ордери на біржу не йдуть, торгових ключів немає. Вхід і вихід за ринком (taker), R — після комісій і фандингу за історичними ставками Bybit.
          </p>
        </>
      )}
    </>
  );
}
