import { useEffect, useState } from "react";
import type { BotInfo, TrendBasketConfig } from "../shared/bots";
import { TREND_BACKTEST } from "../shared/tubeBacktest";
import { PERIODS, SIDE, type Period } from "./botParts";
import { PctBacktest } from "./CarryBot";
import { fmtPrice } from "./live";
import { api, c, card, coin, day, dim, h2, label, num, p, pct, secondary, signed, time, tone } from "./ui";
import { Pill, Segmented, Skeleton, Spark, Stat } from "./viz";

/** Сторінка бота Trend Basket: лонг монет вище денної середньої, частки за волатильністю. Облік у % капіталу бота. */

interface Ranked { symbol: string; close: number; sma: number; vol: number; dir: -1 | 0 | 1 | null; target: number | null; weight: number }
interface Detail {
  universe: { source: string; size: number; error: string | null };
  ranked: Ranked[];
  entered: { symbol: string; weight: number }[];
  exited: { symbol: string; reason: string; pnlPct: number }[];
  resized: { symbol: string; from: number; to: number }[];
  pnlPct: number;
  feePct: number;
  fundingPct: number;
  exposure: number;
  open: number;
  note: string | null;
  errors: string[];
}
interface Holding {
  id: number;
  symbol: string;
  side: "long" | "short";
  opened_at: string;
  closed_at: string | null;
  status: "open" | "closed";
  entry_price: number;
  entry_weight: number;
  last_price: number;
  exit_price: number | null;
  pnl: number;
  fee: number;
  funding: number;
  resizes: number;
  reason: string | null;
  weight: number;
  net_pct: number;
}
interface Page {
  bot: BotInfo;
  enabled: boolean;
  config: TrendBasketConfig;
  takerPct: number;
  last: { at: string; status: string; error: string | null; detail: Detail } | null;
  cycles: { at: string; status: string; error: string | null; detail: Detail }[];
  period: { days: number; pnlPct: number; feePct: number; fundingPct: number; netPct: number; aprPct: number | null; exposure: number };
  curve: { day: string; net: number; exposure: number }[];
  open: Holding[];
  closed: Holding[];
  closedSummary: { count: number; wins: number; netPct: number };
}

const pctText = (v: number | null, digits = 2) => (v === null ? "—" : `${signed(v, digits)}%`);
const REASON: Record<string, string> = { below_sma: "закриття нижче середньої", above_sma: "закриття вище середньої", dropped: "випала зі списку", no_data: "контракт зник", disabled: "бот вимкнено" };

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
        Раз на добу після 00:00 UTC: {cfg.topN} найбільших монет з контрактом на Bybit. Закриття вчорашньої доби вище середньої за {cfg.smaDays} діб — лонг
        {cfg.sides === "both" ? ", нижче — шорт" : ", нижче — без позиції"}. Частка = (1/{cfg.topN}) × {cfg.targetVol} / річна волатильність монети за {cfg.volDays} діб, не більше{" "}
        {Math.round(200 / cfg.topN)}% капіталу; разом не більше 100%. Частка міняється, лише коли ціль відійшла більше ніж на {Math.round(cfg.band * 100)}%. Виконання за марк-ціною,
        комісія taker {d.takerPct}%, фандинг за ставками Bybit.
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
  const exposure = d.open.reduce((sum, h) => sum + Math.abs(h.weight), 0);
  return (
    <section style={card}>
      <h2 style={h2}>Результат</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <Stat label="Разом" value={s.days ? pctText(s.netPct) : "—"} color={s.days ? tone(s.netPct) : undefined} sub="капіталу, після комісій" />
        <Stat label="Річних" value={pctText(s.aprPct, 1)} color={s.aprPct === null ? undefined : tone(s.aprPct)} sub={s.aprPct === null ? "мало днів" : `за ${s.days} дн`} />
        <Stat label="Експозиція" value={pct(exposure)} sub={`${d.open.length} монет · середня ${pct(s.exposure)}`} />
      </div>
      {d.curve.length > 1 && <Spark values={[0, ...d.curve.map((x) => x.net)]} width={320} height={64} />}
      <span style={{ ...num, fontSize: 12, color: c.dim }}>
        рух цін {pctText(s.pnlPct)} · комісії −{s.feePct.toFixed(2)}% · фандинг {pctText(s.fundingPct)} · закрито {d.closedSummary.count}, у плюсі {d.closedSummary.wins}
      </span>
    </section>
  );
}

function Coins({ d }: { d: Page }) {
  const det = d.last?.detail;
  if (!det) return null;
  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2 style={h2}>Монети</h2>
        <span style={{ fontSize: 12, color: c.dim, marginLeft: "auto" }}>{det.universe.source === "coingecko" ? "топ за капіталізацією" : "стартовий список"}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "60px minmax(0, 1fr) 56px 56px", gap: 6, fontSize: 11, color: c.faint }}>
        <span />
        <span>від середньої</span>
        <span style={{ textAlign: "right" }}>волат.</span>
        <span style={{ textAlign: "right" }}>частка</span>
      </div>
      {det.ranked.map((r) => {
        const dist = r.sma ? (r.close / r.sma - 1) * 100 : null;
        return (
          <div key={r.symbol} style={{ display: "grid", gridTemplateColumns: "60px minmax(0, 1fr) 56px 56px", alignItems: "center", gap: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>{coin(r.symbol)}</span>
            <span style={{ ...num, color: tone(dist) }}>{dist === null ? "немає даних" : `${dist > 0 ? "▲" : "▼"} ${signed(dist, 1)}%`}</span>
            <span style={{ ...num, textAlign: "right", color: c.dim }}>{r.vol ? `${Math.round(r.vol * 100)}%` : "—"}</span>
            <span style={{ ...num, textAlign: "right", fontWeight: 700, color: r.weight ? (r.weight > 0 ? c.up : c.down) : c.faint }}>{r.weight ? `${(Math.abs(r.weight) * 100).toFixed(1)}%` : "—"}</span>
          </div>
        );
      })}
      {det.note && <p style={{ ...dim, fontSize: 12 }}>{det.note}</p>}
      {det.errors.length > 0 && <p style={{ ...dim, fontSize: 12, color: c.orange }}>Помилки: {det.errors.slice(0, 3).join("; ")}</p>}
    </section>
  );
}

function HoldingRow({ h }: { h: Holding }) {
  const side = SIDE[h.side];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, padding: "8px 0", borderBottom: `1px solid ${c.line}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14 }}>
        <span style={{ fontWeight: 600 }}>
          <span style={{ color: side.color }}>{side.icon}</span> {coin(h.symbol)}
        </span>
        <span style={{ ...num, fontWeight: 700, color: tone(h.net_pct) }}>{pctText(h.net_pct, 3)}</span>
      </div>
      <span style={{ ...num, fontSize: 12, color: c.dim }}>
        {day(h.opened_at)}
        {h.closed_at ? ` — ${day(h.closed_at)}` : ""} · вхід {fmtPrice(h.entry_price)}
        {h.status === "closed" && h.exit_price !== null ? ` · вихід ${fmtPrice(h.exit_price)} (${REASON[h.reason ?? ""] ?? h.reason ?? "—"})` : ` · зараз ${fmtPrice(h.last_price)}`}
      </span>
      <span style={{ ...num, fontSize: 12, color: c.dim }}>
        частка {(h.entry_weight * 100).toFixed(1)}%{h.status === "open" ? ` → ${(Math.abs(h.weight) * 100).toFixed(1)}%` : ""} капіталу · перебалансувань {h.resizes} · комісії −{(h.fee * 100).toFixed(2)}% · фандинг{" "}
        {pctText(h.funding * 100, 3)}
      </span>
    </div>
  );
}

function Holdings({ title, rows, empty }: { title: string; rows: Holding[]; empty: string }) {
  return (
    <section style={card}>
      <h2 style={h2}>{title}</h2>
      {rows.length ? rows.map((h) => <HoldingRow key={h.id} h={h} />) : <p style={dim}>{empty}</p>}
    </section>
  );
}

function Journal({ cycles }: { cycles: Page["cycles"] }) {
  return (
    <section style={card}>
      <h2 style={h2}>Журнал діб</h2>
      {cycles.length === 0 && <p style={dim}>Ще порожньо.</p>}
      {cycles.map((x) => {
        const net = x.detail.pnlPct + x.detail.fundingPct - x.detail.feePct;
        return (
          <div key={x.at} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 0", borderBottom: `1px solid ${c.line}`, fontSize: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontWeight: 600 }}>{day(x.at)}</span>
              <span style={{ ...num, color: tone(net) }}>{pctText(net, 3)}</span>
            </div>
            <span style={{ fontSize: 12, color: x.status === "error" ? c.orange : c.dim }}>
              позицій {x.detail.open} · експозиція {pct(x.detail.exposure)}
              {x.detail.entered.length ? ` · вхід: ${x.detail.entered.map((e) => coin(e.symbol)).join(", ")}` : ""}
              {x.detail.exited.length ? ` · вихід: ${x.detail.exited.map((e) => coin(e.symbol)).join(", ")}` : ""}
              {x.detail.resized.length ? ` · перебалансовано ${x.detail.resized.length}` : ""}
              {x.error ? ` · ${x.error}` : ""}
            </span>
          </div>
        );
      })}
    </section>
  );
}

export function TrendView({ onBack }: { onBack: () => void }) {
  const [period, setPeriod] = useState<Period>("all");
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Page>(`/api/bots/trend?period=${period}`).then(
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
          <Holdings title="Позиції" rows={data.open} empty="Жодна монета зараз не вище середньої: капітал вільний." />
          <Coins d={data} />
          <PctBacktest b={TREND_BACKTEST} exposure />
          <Holdings title="Закриті позиції" rows={data.closed} empty="Закритих позицій за період немає." />
          <Journal cycles={data.cycles} />
          <p style={{ ...dim, fontSize: 11 }}>
            <span style={label}>Паперова торгівля</span> Ордери на біржу не йдуть, торгових ключів немає. Результат — у % капіталу бота без плеча, після комісій і фандингу.
          </p>
        </>
      )}
    </>
  );
}
