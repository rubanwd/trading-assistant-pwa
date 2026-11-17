import { useEffect, useState } from "react";
import { fmtPrice, useLivePrice } from "./live";
import { api, c, card, coin, dim, label, num, p, pct, signed, time } from "./ui";
import { LiveDot, Meter, Pill, PriceChart, Ring, Skeleton, Stat, useCandles } from "./viz";

type Side = "long" | "short";
type Status = "open" | "target" | "stop" | "expired" | "unfilled";
interface Levels { entry: number; stop: number; target: number; stopPct: number }
interface Option { symbol: string; side: Side; score: number; factors: { points: number; note: string }[]; price: number; market: Levels; pullback: Levels | null; roomAtr: number | null }
interface Ai { choice: number; entry: "market" | "pullback"; probability: number; summary: string; argumentsFor: string[]; argumentsAgainst: string[]; invalidation: string }
interface Idea {
  id: number;
  created_at: string;
  symbol: string;
  side: Side;
  entry_kind: "market" | "pullback";
  price: number;
  entry: number;
  stop: number;
  target: number;
  score: number;
  verdict: "pick" | "pass" | "none";
  probability: number | null;
  model: string | null;
  horizon_hours: number;
  status: Status;
  result_r: number | null;
  body: { factors: Option["factors"]; options: Option[]; ai: Ai | null; note: string | null };
}
type Recent = Pick<Idea, "id" | "created_at" | "symbol" | "side" | "score" | "verdict" | "status" | "result_r">;
interface Summary { ideas: number; open: number; target: number; stop: number; expired: number; unfilled: number; avgR: number | null }
interface PickResponse { latest: Idea | null; recent: Recent[]; stats: { ai: Summary; other: Summary } }

/** Бал, нижче якого ідея слабка (як PICK_MIN_SCORE у рушії). */
const MIN_SCORE = 60;
const SIDE = { long: { text: "Лонг", icon: "▲", color: c.up }, short: { text: "Шорт", icon: "▼", color: c.down } } as const;
const STATUS: Record<Status, { text: string; color: string }> = {
  open: { text: "відкрита", color: c.blue },
  target: { text: "ціль ✓", color: c.up },
  stop: { text: "стоп", color: c.down },
  expired: { text: "за часом", color: c.dim },
  unfilled: { text: "без входу", color: c.faint },
};
const VERDICT = {
  pick: { text: "вибір ШІ", color: c.violet },
  pass: { text: "ШІ радить чекати", color: c.orange },
  none: { text: "лише технічний аналіз", color: c.dim },
} as const;

const distPct = (from: number, to: number) => ((to - from) / from) * 100;

function Factors({ factors }: { factors: Option["factors"] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {factors.map((f) => (
        <div key={f.note} style={{ display: "flex", gap: 8, fontSize: 13 }}>
          <span style={{ ...num, flex: "none", width: 30, textAlign: "right", fontWeight: 700, color: f.points > 0 ? c.up : c.down }}>
            {f.points > 0 ? "+" : "−"}
            {Math.abs(f.points)}
          </span>
          <span style={{ color: "#C9CFD9" }}>{f.note}</span>
        </div>
      ))}
    </div>
  );
}

function Bullets({ items, color, mark }: { items: string[]; color: string; mark: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {items.map((t) => (
        <div key={t} style={{ display: "flex", gap: 8, ...p, fontSize: 13 }}>
          <span aria-hidden style={{ color, flex: "none", fontWeight: 700 }}>{mark}</span>
          <span style={{ color: "#C9CFD9" }}>{t}</span>
        </div>
      ))}
    </div>
  );
}

function TrackRecord({ stats, recent }: { stats: PickResponse["stats"]; recent: Recent[] }) {
  const s = stats.ai;
  const closed = s.target + s.stop + s.expired;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 10, borderTop: `1px solid ${c.line}` }}>
      <span style={label}>Як спрацювали ідеї ШІ за 30 днів</span>
      {s.ideas === 0 ? (
        <p style={{ ...dim, fontSize: 12 }}>Ще немає закритих ідей: результат рахує код за свічками 1h.</p>
      ) : (
        <p style={{ ...dim, fontSize: 12 }}>
          {s.ideas} ідей · ціль <b style={{ color: c.up }}>{s.target}</b> · стоп <b style={{ color: c.down }}>{s.stop}</b> · за часом {s.expired} · без входу {s.unfilled}
          {s.open ? ` · відкриті ${s.open}` : ""}
          {closed > 0 && s.avgR !== null ? ` · середнє ${signed(s.avgR)}R` : ""}
        </p>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {recent.slice(0, 8).map((r) => (
          <Pill key={r.id} color={STATUS[r.status].color} style={{ fontSize: 11 }}>
            <span style={{ color: SIDE[r.side].color }}>{SIDE[r.side].icon}</span>
            {coin(r.symbol)} {time(r.created_at)} · {STATUS[r.status].text}
            {r.result_r !== null && r.status !== "target" && r.status !== "stop" ? ` ${signed(r.result_r)}R` : ""}
          </Pill>
        ))}
      </div>
    </div>
  );
}

/**
 * Ідея скану: одна монета, напрямок і вхід щопів години. Бал, ціни, стоп і ціль рахує код,
 * ШІ вибирає один із найкращих варіантів і пояснює вибір. Це не сигнал.
 */
export function PickCard() {
  const [data, setData] = useState<PickResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api<PickResponse>("/api/pick").then(setData, () => setFailed(true));
  }, []);
  const pick = data?.latest ?? null;
  const live = useLivePrice(pick?.symbol ?? null);
  const { candles } = useCandles(pick?.symbol ?? null, "1h", 48);

  if (failed) return null;
  if (!data) return <section style={card}><Skeleton height={140} /></section>;
  if (!pick) {
    return (
      <section style={card} className="rise">
        <span style={label}>Ідея скану</span>
        <p style={dim}>Перша ідея з'явиться після найближчого скану: код вибере найкращі за технічним аналізом монети, ШІ — одну з них.</p>
      </section>
    );
  }

  const side = SIDE[pick.side];
  const ai = pick.body.ai;
  const price = live ?? pick.price;
  const stale = Date.now() - Date.parse(pick.created_at) > 90 * 60_000;
  const others = pick.body.options.filter((o) => o.symbol !== pick.symbol);
  const verdict = VERDICT[pick.verdict];
  const levels = [
    { price: pick.target, color: c.up, label: `ціль ${fmtPrice(pick.target)}` },
    { price: pick.entry, color: c.blue, label: `вхід ${fmtPrice(pick.entry)}` },
    { price: pick.stop, color: c.down, label: `стоп ${fmtPrice(pick.stop)}` },
  ];

  return (
    <section style={{ ...card, gap: 12 }} className="rise">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={label}>Ідея скану · {time(pick.created_at)}</span>
        <Pill color={verdict.color} style={{ marginLeft: "auto" }}>{verdict.text}</Pill>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 24, fontWeight: 800 }}>{coin(pick.symbol)}</span>
        <Pill color={side.color} solid>
          {side.icon} {side.text}
        </Pill>
        <span style={{ ...num, fontSize: 17, fontWeight: 600, marginLeft: "auto" }}>{fmtPrice(price)}</span>
        {live !== null && <LiveDot />}
      </div>

      {pick.verdict === "pass" && (
        <p style={{ ...p, fontSize: 13, color: c.orange }}>ШІ не радить входити зараз. Нижче найкращий варіант за технічним аналізом, для орієнтиру.</p>
      )}
      {pick.status !== "open" && (
        <p style={{ ...p, fontSize: 13, color: STATUS[pick.status].color }}>
          Ідея вже закрита: {STATUS[pick.status].text}
          {pick.result_r !== null ? ` (${signed(pick.result_r)}R)` : ""}.
        </p>
      )}
      {stale && pick.status === "open" && <p style={{ ...dim, fontSize: 12, color: c.orange }}>Ідея старша за півтори години: останній скан, схоже, не вдався.</p>}

      {candles?.length ? <PriceChart candles={candles} live={live} height={150} levels={levels} /> : <Skeleton height={170} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <Stat
          label={pick.entry_kind === "market" ? "Вхід за ринком" : "Лімітка на відкаті"}
          value={fmtPrice(pick.entry)}
          color={c.blue}
          sub={pick.entry_kind === "market" ? "біля поточної ціни" : `${Math.abs(distPct(price, pick.entry)).toFixed(2)}% від ціни`}
        />
        <Stat label="Стоп" value={fmtPrice(pick.stop)} color={c.down} sub={`${Math.abs(distPct(pick.entry, pick.stop)).toFixed(2)}% · −1R`} />
        <Stat label="Ціль" value={fmtPrice(pick.target)} color={c.up} sub={`${Math.abs(distPct(pick.entry, pick.target)).toFixed(2)}% · +2R`} />
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <Ring value={pick.probability} size={76} color={c.violet} label="оцінка ШІ">
          <span style={{ ...num, fontSize: 18, fontWeight: 700 }}>{pick.probability === null ? "—" : pct(pick.probability)}</span>
          <span style={{ fontSize: 9, color: c.dim }}>ШІ</span>
        </Ring>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 12, color: c.dim }}>
            {pick.probability === null ? "ШІ не оцінював цей варіант." : `Імовірність, що ціль буде раніше за стоп протягом ${pick.horizon_hours} год.`}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: c.dim, flex: "none" }}>Технічний бал</span>
            <Meter value={pick.score / 100} marker={MIN_SCORE / 100} color={pick.score >= MIN_SCORE ? c.blue : c.orange} />
            <span style={{ ...num, fontWeight: 700, flex: "none" }}>{pick.score}</span>
          </div>
        </div>
      </div>

      {ai?.summary && <p style={{ ...p, fontWeight: 600 }}>{ai.summary}</p>}
      {pick.body.note && <p style={{ ...dim, fontSize: 12, color: c.orange }}>{pick.body.note}</p>}

      <button type="button" onClick={() => setOpen(!open)} style={{ background: "none", border: 0, color: c.blue, font: "600 13px Inter, system-ui, sans-serif", textAlign: "left", padding: 0, cursor: "pointer", minHeight: 32 }}>
        {open ? "Сховати деталі ▴" : "Чому саме ця монета ▾"}
      </button>
      {open && (
        <div className="rise" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {ai && ai.argumentsFor.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={label}>За</span>
              <Bullets items={ai.argumentsFor} color={c.up} mark="+" />
            </div>
          )}
          {ai && ai.argumentsAgainst.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={label}>Проти</span>
              <Bullets items={ai.argumentsAgainst} color={c.down} mark="−" />
            </div>
          )}
          {ai?.invalidation && (
            <p style={{ ...dim, fontSize: 13 }}>
              <b style={{ color: c.ink }}>Скасує ідею:</b> {ai.invalidation}
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={label}>З чого склався бал {pick.score} (старт 50)</span>
            <Factors factors={pick.body.factors} />
          </div>
          {others.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={label}>Інші варіанти</span>
              {others.map((o) => (
                <div key={o.symbol} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  <span style={{ fontWeight: 700, width: 56 }}>{coin(o.symbol)}</span>
                  <span style={{ color: SIDE[o.side].color }}>
                    {SIDE[o.side].icon} {SIDE[o.side].text.toLowerCase()}
                  </span>
                  <span style={{ ...num, marginLeft: "auto", color: c.dim }}>бал {o.score}</span>
                </div>
              ))}
            </div>
          )}
          {pick.model && <p style={{ ...dim, fontSize: 11 }}>Модель: {pick.model}</p>}
        </div>
      )}

      <TrackRecord stats={data.stats} recent={data.recent} />
      <p style={{ ...dim, fontSize: 11 }}>Ідея, не сигнал: її не перевіряє скептик і про неї не приходять сповіщення. Ціни, стоп і ціль порахував код; розмір позиції бери від ризику на угоду.</p>
    </section>
  );
}
