import { useEffect, useState } from "react";
import type { BotId, BotInfo, BotMode, TubeConfig } from "../shared/bots";
import { positionSize } from "../shared/risk";
import { Backtest, GroupLine, OUTCOME, PERIODS, SIDE, WORD, type Group, type Outcome, type Period, type Side } from "./botParts";
import { ChannelView } from "./ChannelBot";
import { fmtPrice, useLivePrice } from "./live";
import { EquityCurve } from "./Stats";
import { api, c, card, coin, day, dim, h2, label, num, p, pct, secondary, signed, time, tone, useDesk } from "./ui";
import { LiveDot, Meter, Pill, PriceChart, Ring, Segmented, Skeleton, Stat, useCandles } from "./viz";

type Bias = "bull" | "bear" | "neutral";
type Status = "pending" | "cancelled" | "open" | "target" | "stop" | "timeout";

interface Features { symbol: string; price: number; atr: number; atrPct: number; ema20: number; rsi: number | null; volRatio: number | null; change24hPct: number | null; trend4h: "up" | "down" | "range" | null; score: number }
interface Order {
  id: number;
  created_at: string;
  symbol: string;
  side: Side;
  bias: Bias;
  near: 0 | 1 | null;
  rank: number;
  price: number;
  entry: number;
  stop: number;
  target: number;
  status: Status;
  filled_at: string | null;
  resolved_at: string | null;
  exit_price: number | null;
  result_r: number | null;
  fee_r: number | null;
  expires_at?: string;
  max_hold_hours?: number;
}
interface Trade extends Order { outcome: Outcome; net_r: number | null }
interface OrderFull extends Trade { body: { features: Features; offsetAtr: number; market: { mood: string; btcTrend: string | null; breadth: number | null } } }
interface Ranked { symbol: string; price: number; atrPct: number; volRatio: number | null; score: number; trend4h: Features["trend4h"]; change24hPct: number | null; ema20?: number }
interface Cycle { at: string; status: string; error: string | null; bias: Bias | null; chosen: string[]; placed: number; resolved: Record<"filled" | "target" | "stop" | "timeout" | "cancelled", number>; open: number; note: string | null }
interface LastCycle {
  at: string;
  status: string;
  error: string | null;
  detail: { bias: Bias | null; market: { mood: string; btcTrend: string | null; breadth: number | null } | null; universe: { source: string; at: string | null; size: number; error: string | null }; ranked: Ranked[]; chosen: string[]; placed: number; skipped: { symbol: string; side: Side; reason: "position" | "slots" }[]; note: string | null; errors: string[] };
}
interface BotPage {
  bot: BotInfo;
  enabled: boolean;
  config: TubeConfig;
  riskPct: number;
  depositUsd: number | null;
  from: string | null;
  last: LastCycle | null;
  cycles: Cycle[];
  active: Order[];
  summary: { all: Group; bySide: Record<Side, Group>; byBias: Record<Bias, Group>; byDistance: Record<"near" | "far" | "neutral", Group>; bySymbol: ({ symbol: string } & Group)[] };
  trades: Trade[];
}
interface BotListItem extends BotInfo {
  enabled: boolean;
  stats30: Group;
  lastCycle: { at: string; bias: Bias | null; chosen: string[]; placed: number; open: number; note: string | null } | null;
}

const BIAS: Record<Bias, { text: string; icon: string; color: string }> = {
  bull: { text: "бичачий", icon: "▲", color: c.up },
  bear: { text: "ведмежий", icon: "▼", color: c.down },
  neutral: { text: "без напрямку", icon: "•", color: c.dim },
};
const STATUS: Record<Status, { text: string; color: string }> = {
  pending: { text: "ордер чекає", color: c.blue },
  cancelled: { text: "знята", color: c.faint },
  open: { text: "позиція", color: c.blue },
  target: { text: "тейк ✓", color: c.up },
  stop: { text: "стоп", color: c.down },
  timeout: { text: "за часом", color: c.dim },
};
const TREND = { up: "▲ вгору", down: "▼ вниз", range: "боковик" } as const;

const distPct = (from: number, to: number) => ((to - from) / from) * 100;
const times = (ratio: number) => (ratio === 2 ? "удвічі" : `у ${ratio} раза`);

/** Який ордер зараз ближче до ціни і чому. */
function biasRule(bias: Bias | null, cfg: TubeConfig, mode: BotMode): string {
  if (bias === null) return "Напрямок ринку ще не визначено.";
  if (bias === "neutral" && cfg.skipNeutral) return `Ринок без напрямку: нові ${WORD[mode].many} не ставляться.`;
  const filter = cfg.trendOnly ? ` Ставиться лише ${WORD[mode].one} у бік руху монети (ціна відносно EMA20 1h).` : "";
  if (bias === "neutral" || cfg.biasSide === "off" || cfg.biasRatio === 1) return `Обидва ордери на однаковій відстані від ціни.${filter}`;
  const near: Side = (bias === "bull") === (cfg.biasSide === "counter") ? "short" : "long";
  const far: Side = near === "long" ? "short" : "long";
  return `${SIDE[near].text} ${times(cfg.biasRatio)} ближче до ціни, ніж ${SIDE[far].text.toLowerCase()}.${filter}`;
}

// ── Список ботів ────────────────────────────────────────────────────────────

function BotCard({ b, onOpen }: { b: BotListItem; onOpen: () => void }) {
  const s = b.stats30;
  const last = b.lastCycle;
  return (
    <button type="button" onClick={onOpen} className="press rise" style={{ ...card, color: c.ink, font: "inherit", textAlign: "left", cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 20, fontWeight: 800 }}>{b.name}</span>
        <Pill color={b.enabled ? c.up : c.faint} style={{ marginLeft: "auto" }}>
          {b.enabled ? "працює" : "вимкнено"}
        </Pill>
      </div>
      <p style={{ ...dim, fontSize: 13 }}>{b.summary}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <Stat label="Угод · 30 дн" value={String(s.filled)} sub={s.open ? `відкрито ${s.open}` : undefined} />
        <Stat label="У плюсі" value={pct(s.winRate)} color={s.winRate === null ? undefined : s.winRate >= 0.5 ? c.up : c.orange} sub={`${s.wins} з ${s.closed}`} />
        <Stat label="Результат" value={s.closed ? `${signed(s.totalR)}R` : "—"} color={s.closed ? tone(s.totalR) : undefined} sub="після комісій" />
      </div>
      {last &&
        (b.mode === "channel" ? (
          <span style={{ fontSize: 12, color: c.dim }}>
            Остання година {time(last.at)}: {coin(last.chosen[0] ?? "BTCUSDT")} · {last.open ? "позиція відкрита" : "без позиції, чекає пробою"}
            {last.placed ? " · новий вхід" : ""}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: c.dim }}>
            Остання година {time(last.at)}: {last.chosen.map(coin).join(", ") || "без монет"} · ринок {last.bias ? BIAS[last.bias].text : "—"} · {WORD[b.mode].gen} {last.placed}
          </span>
        ))}
      <span style={{ fontSize: 13, fontWeight: 600, color: c.blue }}>Відкрити →</span>
    </button>
  );
}

/** Розділ «Боти»: список ботів, а вибраний бот відкривається окремою сторінкою. Поки боти працюють лише з крипто. */
const BOT_IDS_WEB: BotId[] = ["hvt", "hvb", "c2010"];

export function Bots({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const desk = useDesk();
  const [list, setList] = useState<BotListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (desk !== "crypto" || openId) return;
    api<{ bots: BotListItem[] }>("/api/bots").then((d) => setList(d.bots), (e) => setError(String(e)));
  }, [desk, openId]);
  if (desk !== "crypto") {
    return (
      <section style={card}>
        <h2 style={h2}>Боти поки лише для крипто</h2>
        <p style={dim}>Боти торгують ф'ючерсами крипто на Bybit. Перемкни ринок на «Крипто» вгорі.</p>
      </section>
    );
  }
  const bot = BOT_IDS_WEB.find((x) => x === openId);
  if (bot === "c2010") return <ChannelView key={bot} id={bot} onBack={() => onOpen(null)} />;
  if (bot) return <BotView key={bot} id={bot} onBack={() => onOpen(null)} />;
  return (
    <>
      <p style={{ ...p, color: c.dim }}>
        Боти самі «ставлять» ордери за правилами коду й ведуть облік кожного. Поки це паперова торгівля на живих даних Bybit: ордери на біржу не йдуть, виконання,
        тейк і стоп рахує код за свічками.
      </p>
      {error && <p style={{ ...p, color: c.orange }}>{error}</p>}
      {!list && !error && <Skeleton height={190} />}
      {list?.map((b) => <BotCard key={b.id} b={b} onOpen={() => onOpen(b.id)} />)}
    </>
  );
}

// ── Сторінка бота ───────────────────────────────────────────────────────────

function Header({ d }: { d: BotPage }) {
  const cfg = d.config;
  const last = d.last;
  const bias = last?.detail.bias ?? null;
  const stale = last ? Date.now() - Date.parse(last.at) > 2 * 3_600_000 : false;
  return (
    <section style={card} className="rise">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 24, fontWeight: 800 }}>{d.bot.name}</span>
        <Pill color={d.enabled ? c.up : c.faint} style={{ marginLeft: "auto" }}>
          {d.enabled ? "працює" : "вимкнено"}
        </Pill>
      </div>
      <p style={{ ...dim, fontSize: 13 }}>{d.bot.summary}</p>
      {last ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={label}>Година {time(last.at)}</span>
            {bias && (
              <Pill color={BIAS[bias].color}>
                {BIAS[bias].icon} ринок {BIAS[bias].text}
              </Pill>
            )}
          </div>
          <p style={{ ...p, fontSize: 13 }}>{biasRule(bias, cfg, d.bot.mode)}</p>
          {last.detail.note && <p style={{ ...dim, fontSize: 12, color: c.orange }}>{last.detail.note}</p>}
          {stale && <p style={{ ...dim, fontSize: 12, color: c.orange }}>Остання година бота понад 2 години тому: цикл, схоже, не запускався.</p>}
        </>
      ) : (
        <p style={dim}>Бот ще не працював: перша година почнеться з найближчим запуском рушія.</p>
      )}
      <p style={{ ...dim, fontSize: 12 }}>
        Щогодини {cfg.pickN} з {cfg.topN} монет · {WORD[d.bot.mode].one} на {cfg.entryAtr} ATR 1h від ціни (ближчий ÷{cfg.biasRatio}) · стоп {cfg.stopAtr} ATR · тейк {cfg.targetR}R · до{" "}
        {cfg.maxHoldHours} год · до {cfg.maxPositions} позицій · ризик {d.riskPct}% на угоду
        {cfg.trendOnly ? " · лише в бік руху" : ""}
        {cfg.skipNeutral ? " · без ринку без напрямку" : ""}
      </p>
    </section>
  );
}

function OrderLine({ o, live, sizing }: { o: Order; live: number | null; sizing: { depositUsd: number | null; riskPct: number } }) {
  const side = SIDE[o.side];
  // Розмір позиції рахує код від ризику на угоду; без депозиту в налаштуваннях не показується.
  const size = sizing.depositUsd ? positionSize(sizing.depositUsd, sizing.riskPct, o.entry, o.stop) : null;
  const isPos = o.status === "open";
  const risk = Math.abs(o.entry - o.stop);
  const pnl = isPos && live !== null && risk > 0 ? ((live - o.entry) / risk) * (o.side === "long" ? 1 : -1) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 0", borderTop: `1px solid ${c.line}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: side.color, fontWeight: 700, fontSize: 14 }}>
          {side.icon} {side.text}
        </span>
        <Pill color={STATUS[o.status].color} style={{ fontSize: 11 }}>
          {isPos ? `позиція з ${o.filled_at ? time(o.filled_at) : "—"}` : STATUS[o.status].text}
        </Pill>
        {o.near !== null && <span style={{ fontSize: 11, color: c.dim }}>{o.near ? "ближчий" : "дальній"}</span>}
        {pnl !== null && <span style={{ ...num, marginLeft: "auto", fontWeight: 700, color: tone(pnl) }}>{signed(pnl)}R</span>}
      </div>
      <span style={{ ...num, fontSize: 12, color: c.dim, display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
        <span>
          вхід <span style={{ color: c.blue }}>{fmtPrice(o.entry)}</span> ({signed(distPct(o.price, o.entry))}%)
        </span>
        <span>
          тейк <span style={{ color: c.up }}>{fmtPrice(o.target)}</span>
        </span>
        <span>
          стоп <span style={{ color: c.down }}>{fmtPrice(o.stop)}</span> ({Math.abs(distPct(o.entry, o.stop)).toFixed(2)}%)
        </span>
        {size && <span>розмір ${Math.round(size.notionalUsd).toLocaleString("uk-UA")}</span>}
      </span>
    </div>
  );
}

/** Зараз: робочі ордери й відкриті позиції, графік «труби» вибраної монети. */
function Now({ d }: { d: BotPage }) {
  const symbols = [...new Set([...(d.last?.detail.chosen ?? []), ...d.active.map((o) => o.symbol)])].filter((s) => d.active.some((o) => o.symbol === s));
  const [sel, setSel] = useState<string | null>(symbols[0] ?? null);
  const symbol = sel && symbols.includes(sel) ? sel : (symbols[0] ?? null);
  const live = useLivePrice(symbol);
  const { candles } = useCandles(symbol, "1h", 48);
  if (!symbols.length) {
    return (
      <section style={card}>
        <h2 style={h2}>Зараз</h2>
        <p style={dim}>Робочих {WORD[d.bot.mode].gen} і відкритих позицій немає.</p>
      </section>
    );
  }
  const orders = d.active.filter((o) => o.symbol === symbol);
  // Ціна до живої — з найсвіжішого ордера монети (позиція могла відкритись кілька годин тому).
  const lastPrice = orders.reduce((a, o) => (o.created_at > a.created_at ? o : a), orders[0]!).price;
  const levels = orders.flatMap((o) => {
    const s = o.side === "long" ? "Л" : "Ш";
    return [
      { price: o.entry, color: c.blue, label: `${s} вхід ${fmtPrice(o.entry)}` },
      { price: o.target, color: c.up, label: `${s} тейк` },
      { price: o.stop, color: c.down, label: `${s} стоп` },
    ];
  });
  const rank = d.last?.detail.ranked.findIndex((r) => r.symbol === symbol) ?? -1;
  return (
    <section style={{ ...card, gap: 12 }} className="rise">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2 style={h2}>Зараз</h2>
        <span style={{ fontSize: 12, color: c.dim, marginLeft: "auto" }}>
          {WORD[d.bot.mode].gen} {d.active.filter((o) => o.status === "pending").length} · позицій {d.active.filter((o) => o.status === "open").length}
        </span>
      </div>
      {symbols.length > 1 && <Segmented options={symbols.map((s) => [s, coin(s)] as [string, string])} value={symbol!} onChange={setSel} size="sm" />}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22, fontWeight: 800 }}>{coin(symbol!)}</span>
        {rank >= 0 && <Pill color={c.violet}>№{rank + 1} за рухом</Pill>}
        <span style={{ ...num, marginLeft: "auto", fontSize: 16, fontWeight: 600 }}>{fmtPrice(live ?? lastPrice)}</span>
        {live !== null && <LiveDot />}
      </div>
      {candles?.length ? <PriceChart candles={candles} live={live} height={170} levels={levels} /> : <Skeleton height={190} />}
      <div>
        {orders.map((o) => (
          <OrderLine key={o.id} o={o} live={live} sizing={d} />
        ))}
      </div>
      <p style={{ ...dim, fontSize: 11 }}>
        {WORD[d.bot.mode].Many} знімаються й ставляться заново щогодини за свіжими даними. Виконання паперове:{" "}
        {d.bot.mode === "breakout" ? "вхід, коли ціна торкнулась стоп-ордера" : "вхід, коли ціна пройшла лімітку"}, тейк і стоп — за свічками 15m.
      </p>
    </section>
  );
}

/** Рейтинг руху останньої години: усі монети списку, взяті в роботу підсвічені. */
function Ranking({ d }: { d: BotPage }) {
  const [all, setAll] = useState(false);
  const last = d.last;
  if (!last?.detail.ranked.length) return null;
  const ranked = last.detail.ranked;
  const max = Math.max(...ranked.map((r) => r.score));
  const chosen = new Set(last.detail.chosen);
  const shown = all ? ranked : ranked.slice(0, 8);
  const u = last.detail.universe;
  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2 style={h2}>Рух монет</h2>
        <span style={{ fontSize: 12, color: c.dim, marginLeft: "auto" }}>{time(last.at)}</span>
      </div>
      <p style={{ ...dim, fontSize: 12 }}>Бал руху = ATR 1h у % від ціни × √активності (обсяг за 6 год до звичайного за тиждень). Бот бере {d.config.pickN} найрухливіші.</p>
      {shown.map((r, i) => (
        <div key={r.symbol} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 0", borderBottom: `1px solid ${c.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ ...num, width: 20, color: c.faint }}>{i + 1}</span>
            <span style={{ fontWeight: 700, width: 52 }}>{coin(r.symbol)}</span>
            <Meter value={max > 0 ? r.score / max : 0} color={chosen.has(r.symbol) ? c.violet : c.blue} />
            <span style={{ ...num, width: 40, textAlign: "right", fontWeight: 600 }}>{r.score.toFixed(2)}</span>
          </div>
          <span style={{ ...num, fontSize: 11, color: c.dim, paddingLeft: 28, display: "flex", flexWrap: "wrap", gap: "0 10px" }}>
            <span>ATR {r.atrPct.toFixed(2)}%</span>
            <span>активність ×{r.volRatio === null ? "—" : r.volRatio.toFixed(2)}</span>
            {r.change24hPct !== null && (
              <span style={{ color: tone(r.change24hPct) }}>
                {r.change24hPct > 0 ? "▲" : r.change24hPct < 0 ? "▼" : "•"} {Math.abs(r.change24hPct).toFixed(1)}% за добу
              </span>
            )}
            {r.trend4h && <span>4h {TREND[r.trend4h]}</span>}
            {r.ema20 !== undefined && <span>{r.price >= r.ema20 ? "▲ над EMA20" : "▼ під EMA20"}</span>}
            {chosen.has(r.symbol) && <span style={{ color: c.violet, fontWeight: 600 }}>у роботі</span>}
          </span>
        </div>
      ))}
      {ranked.length > 8 && (
        <button type="button" onClick={() => setAll(!all)} style={{ background: "none", border: 0, color: c.blue, font: "600 13px Inter, system-ui, sans-serif", textAlign: "left", padding: 0, minHeight: 32, cursor: "pointer" }}>
          {all ? "Сховати ▴" : `Усі ${ranked.length} монет ▾`}
        </button>
      )}
      <p style={{ ...dim, fontSize: 11 }}>
        Список: {u.source === "coingecko" ? "топ за капіталізацією CoinGecko" : "стартовий топ-20"} з контрактом на Bybit, {u.size} монет з даними
        {u.error ? ` · оновити список не вдалося: ${u.error}` : ""}.
      </p>
    </section>
  );
}

function SummaryCard({ d }: { d: BotPage }) {
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
            після комісій · {g.closed} закритих угод
            {g.closed ? ` · ${signed(pctDeposit)}% депозиту` : ""}
            {g.closed && d.depositUsd ? ` (${signed((pctDeposit / 100) * d.depositUsd, 0)} $)` : ""}
          </span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <Stat label="Тейк" value={String(g.target)} color={c.up} />
        <Stat label="Стоп" value={String(g.stop)} color={c.down} />
        <Stat label="За часом" value={String(g.timeout)} />
        <Stat label="Середнє" value={g.avgR === null ? "—" : `${signed(g.avgR, 3)}R`} color={g.avgR === null ? undefined : tone(g.avgR)} sub="на угоду" />
        <Stat label="Відкрито" value={String(g.open)} color={c.blue} />
        <Stat label="Виконалось" value={pct(g.fillRate)} sub={`${g.filled} з ${g.filled + g.cancelled} ${WORD[d.bot.mode].gen}`} />
      </div>
      <p style={{ ...dim, fontSize: 11 }}>У плюсі — тейк або закриття за часом у плюсі після комісій. Зняті без виконання ордери зберігаються 30 днів, тож частка виконаних — за останній місяць.</p>
    </section>
  );
}

function Breakdown({ d }: { d: BotPage }) {
  const s = d.summary;
  const [more, setMore] = useState(false);
  const coins = more ? s.bySymbol : s.bySymbol.slice(0, 6);
  return (
    <section style={card}>
      <h2 style={h2}>Розріз</h2>
      <span style={{ ...label, marginTop: 4 }}>Напрямок</span>
      <GroupLine name="▲ Лонг" g={s.bySide.long} />
      <GroupLine name="▼ Шорт" g={s.bySide.short} />
      <span style={{ ...label, marginTop: 4 }}>Ринок у момент постановки</span>
      <GroupLine name="▲ Бичачий" g={s.byBias.bull} />
      <GroupLine name="▼ Ведмежий" g={s.byBias.bear} />
      <GroupLine name="• Без напрямку" g={s.byBias.neutral} />
      <span style={{ ...label, marginTop: 4 }}>Правило «{times(d.config.biasRatio)} ближче»</span>
      <GroupLine name={WORD[d.bot.mode].near[0]!.toUpperCase() + WORD[d.bot.mode].near.slice(1)} g={s.byDistance.near} />
      <GroupLine name={WORD[d.bot.mode].far[0]!.toUpperCase() + WORD[d.bot.mode].far.slice(1)} g={s.byDistance.far} />
      {s.bySymbol.length > 0 && (
        <>
          <span style={{ ...label, marginTop: 4 }}>Монети</span>
          {coins.map((x) => (
            <GroupLine key={x.symbol} name={coin(x.symbol)} g={x} />
          ))}
          {s.bySymbol.length > 6 && (
            <button type="button" onClick={() => setMore(!more)} style={{ background: "none", border: 0, color: c.blue, font: "600 13px Inter, system-ui, sans-serif", textAlign: "left", padding: 0, minHeight: 32, cursor: "pointer" }}>
              {more ? "Сховати ▴" : `Усі ${s.bySymbol.length} монет ▾`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function TradeRow({ t, id, mode }: { t: Trade; id: BotId; mode: BotMode }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<OrderFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setOpen(!open);
    if (!detail && !open) api<OrderFull>(`/api/bots/${id}/orders/${t.id}`).then(setDetail, (e) => setError(String(e)));
  };
  const side = SIDE[t.side];
  const o = OUTCOME[t.outcome];
  const f = detail?.body.features;
  return (
    <div style={{ borderBottom: `1px solid ${c.line}` }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{ width: "100%", background: "none", border: 0, color: c.ink, font: "inherit", textAlign: "left", padding: "10px 0", display: "flex", flexDirection: "column", gap: 4, cursor: "pointer" }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ ...num, fontSize: 12, color: c.dim, flex: "none" }}>{time(t.filled_at ?? t.created_at)}</span>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{coin(t.symbol)}</span>
          <span style={{ color: side.color, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" }}>
            {side.icon} {side.text}
          </span>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, flex: "none" }}>
            <Pill color={o.color} style={{ fontSize: 11 }}>
              {o.icon} {STATUS[t.status].text}
            </Pill>
            {t.net_r !== null && <span style={{ ...num, fontWeight: 700, fontSize: 14, color: tone(t.net_r), minWidth: 56, textAlign: "right" }}>{signed(t.net_r)}R</span>}
          </span>
        </span>
        <span style={{ ...num, fontSize: 12, color: c.dim, display: "flex", flexWrap: "wrap", gap: "2px 10px" }}>
          <span>
            вхід <span style={{ color: c.blue }}>{fmtPrice(t.entry)}</span>
          </span>
          <span>
            тейк <span style={{ color: c.up }}>{fmtPrice(t.target)}</span>
          </span>
          <span>
            стоп <span style={{ color: c.down }}>{fmtPrice(t.stop)}</span>
          </span>
          {t.exit_price !== null && t.resolved_at && (
            <span>
              вихід {fmtPrice(t.exit_price)} о {time(t.resolved_at)}
            </span>
          )}
        </span>
        <span style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 11, color: c.dim }}>
          <span style={{ color: BIAS[t.bias].color }}>ринок {BIAS[t.bias].text}</span>
          {t.near !== null && <span>· {t.near ? WORD[mode].near : WORD[mode].far}</span>}
          <span>· №{t.rank} за рухом</span>
          <span style={{ marginLeft: "auto", color: c.blue }}>{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <div style={{ padding: "0 0 12px" }}>
          {error ? (
            <p style={{ ...dim, color: c.orange }}>{error}</p>
          ) : !detail || !f ? (
            <Skeleton height={60} />
          ) : (
            <p style={{ ...num, ...dim, fontSize: 12 }}>
              Поставлено {day(detail.created_at)} о {time(detail.created_at)} за ціни {fmtPrice(detail.price)} · {WORD[mode].one} на {detail.body.offsetAtr} ATR від ціни · ATR 1h{" "}
              {fmtPrice(f.atr)} ({f.atrPct.toFixed(2)}%) · активність ×{f.volRatio === null ? "—" : f.volRatio.toFixed(2)}
              {f.rsi !== null ? ` · RSI 1h ${Math.round(f.rsi)}` : ""}
              {f.trend4h ? ` · тренд 4h ${TREND[f.trend4h]}` : ""} · стоп {Math.abs(distPct(t.entry, t.stop)).toFixed(2)}%, тейк {Math.abs(distPct(t.entry, t.target)).toFixed(2)}%
              {detail.result_r !== null ? ` · ${signed(detail.result_r)}R до комісій, комісії ${(detail.fee_r ?? 0).toFixed(3)}R` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Trades({ trades, id, mode }: { trades: Trade[]; id: BotId; mode: BotMode }) {
  const [limit, setLimit] = useState(40);
  const days: { day: string; rows: Trade[] }[] = [];
  for (const t of trades.slice(0, limit)) {
    const d = day(t.filled_at ?? t.created_at);
    const last = days[days.length - 1];
    if (last?.day === d) last.rows.push(t);
    else days.push({ day: d, rows: [t] });
  }
  return (
    <section style={card}>
      <h2 style={h2}>Угоди</h2>
      {!trades.length && <p style={dim}>За цей період жоден ордер не виконався.</p>}
      {days.map((d) => (
        <div key={d.day} style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ ...label, paddingTop: 8 }}>{d.day}</span>
          {d.rows.map((t) => (
            <TradeRow key={t.id} t={t} id={id} mode={mode} />
          ))}
        </div>
      ))}
      {trades.length > limit && (
        <button type="button" className="press" onClick={() => setLimit(limit + 40)} style={secondary}>
          Показати ще ({trades.length - limit})
        </button>
      )}
    </section>
  );
}

function Cycles({ cycles, mode }: { cycles: Cycle[]; mode: BotMode }) {
  const [open, setOpen] = useState(false);
  if (!cycles.length) return null;
  return (
    <section style={card}>
      <button type="button" onClick={() => setOpen(!open)} style={{ background: "none", border: 0, color: c.ink, font: "inherit", textAlign: "left", padding: 0, display: "flex", alignItems: "baseline", gap: 8, cursor: "pointer" }}>
        <h2 style={h2}>Журнал годин</h2>
        <span style={{ fontSize: 12, color: c.blue, marginLeft: "auto" }}>{open ? "сховати ▴" : `${cycles.length} останніх ▾`}</span>
      </button>
      {open &&
        cycles.map((x) => {
          const r = x.resolved;
          return (
            <div key={x.at} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 0", borderTop: `1px solid ${c.line}`, fontSize: 12 }}>
              <span style={{ display: "flex", gap: 8 }}>
                <span style={{ ...num, color: c.dim }}>
                  {day(x.at)} {time(x.at)}
                </span>
                <span style={{ fontWeight: 600 }}>{x.chosen.map(coin).join(", ") || "—"}</span>
                {x.bias && <span style={{ color: BIAS[x.bias].color, marginLeft: "auto" }}>{BIAS[x.bias].text}</span>}
              </span>
              <span style={{ ...num, color: c.dim }}>
                {WORD[mode].gen} {x.placed} · виконалось {r.filled} · тейк {r.target} · стоп {r.stop} · за часом {r.timeout} · знято {r.cancelled} · позицій {x.open}
              </span>
              {(x.note || x.error) && <span style={{ color: c.orange }}>{x.note ?? x.error}</span>}
            </div>
          );
        })}
    </section>
  );
}

/** Сторінка бота: що він робить зараз, як торгував, бектест і кожна угода. */
function BotView({ id, onBack }: { id: BotId; onBack: () => void }) {
  const [period, setPeriod] = useState<Period>("all");
  const [data, setData] = useState<BotPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<BotPage>(`/api/bots/${id}?period=${period}`).then(
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
          <Ranking d={data} />
          <Segmented options={PERIODS} value={period} onChange={setPeriod} />
          <SummaryCard d={data} />
          <EquityCurve trades={curve} title="Крива результату бота" />
          <Breakdown d={data} />
          <Backtest id={id} mode={data.bot.mode} />
          <Trades trades={data.trades} id={id} mode={data.bot.mode} />
          <Cycles cycles={data.cycles} mode={data.bot.mode} />
          <p style={{ ...dim, fontSize: 11 }}>
            Паперова торгівля: ордери на біржу не йдуть, торгових ключів немає. Виконання рахує код за свічками 15m Bybit;{" "}
            {data.bot.mode === "breakout"
              ? "стоп-ордер спрацьовує, коли ціна торкнулась ціни входу, у свічці входу тейк не зараховується. R — після комісій (вхід і стоп за ринком — taker, тейк — maker)."
              : "лімітка виконується, лише коли ціна її пройшла, у свічці входу тейк не зараховується. R — після комісій (вхід і тейк maker, стоп і закриття за часом taker)."}
          </p>
        </>
      )}
    </>
  );
}
