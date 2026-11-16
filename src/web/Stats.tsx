import { useEffect, useRef, useState } from "react";
import { SETUP, type SignalCard } from "./Signals";
import { api, c, card, coin, day, dim, h2, label, num, p, pct, signed, tone } from "./ui";
import { Meter, Pill, Ring, Segmented, Skeleton, Stat } from "./viz";

interface Group { closed: number; wins: number; winRate: number | null; avgR: number | null; totalR: number }
interface Bin { from: number; to: number; n: number; predicted: number; actual: number }
interface Calibration { n: number; brier: number | null; bins: Bin[] }
export interface Stats {
  from: string | null;
  summary: Group & { published: number; open: number; avgFeeR: number | null; riskPct: number; equityPct: number; btcHoldPct: number | null; target: number };
  bySetup: (Group & { setup: string; published: number })[];
  byVersion: (Group & { version: number | null })[];
  journal: Record<"taken" | "skipped" | "none", Group>;
  rejected: Group & { count: number };
  calibration: { analyst: Calibration; skeptic: Calibration; reports: Calibration };
  funnel: { scans: number; detected: number; filtered: Record<string, number>; reviewed: number; published: number; rejected: number };
  spend: { monthUsd: number; budgetUsd: number | null; byPipeline: { pipeline: string; usd: number; calls: number }[] };
}

const PIPELINE: Record<string, string> = {
  news: "Сортувальник новин", morning_report: "Ранкові звіти", evening_report: "Вечірні звіти",
  analyst: "Аналітик", skeptic: "Скептик", weekly_review: "Тижневий розбір", test: "Пробні виклики",
};
const FILTER: Record<string, string> = {
  rr: "R:R нижче порога", stop: "стоп надто близько", regime: "проти режиму", market: "проти настрою ринку", duplicate: "уже є сигнал по монеті",
  cooldown: "пауза після сетапу", macro: "перед макроподією", max_active: "ліміт відкритих",
  weak: "слабкий пробій (обсяг або розмах свічки)", extended: "надто далеко від EMA200",
};

/** Порядок кольорів закріплений за конвеєром, а не за місцем у списку. */
const PIPELINE_COLOR: Record<string, string> = {
  news: "#3987E5", morning_report: "#D95926", evening_report: "#199E70", analyst: "#C98500",
  skeptic: "#D55181", weekly_review: "#9085E9", test: "#E66767",
};

function Row({ label: name, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14 }}>
      <span style={{ color: c.dim }}>{name}</span>
      <span style={{ ...num, color, textAlign: "right" }}>{value}</span>
    </div>
  );
}

const rColor = (v: number | null) => (v === null || v === 0 ? undefined : tone(v));

/** Рядок групи: назва, частка прибуткових смужкою і сума R. */
function GroupRow({ name, g, extra }: { name: string; g: Group; extra?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "10px 0", borderBottom: `1px solid ${c.line}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14 }}>
        <span style={{ fontWeight: 600 }}>{name}</span>
        <span style={{ ...num, fontWeight: 700, color: g.closed ? tone(g.totalR) : c.dim }}>{g.closed ? `${signed(g.totalR)}R` : "—"}</span>
      </div>
      {g.closed > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, display: "flex", height: 6, borderRadius: 3, overflow: "hidden", gap: 2 }} aria-hidden>
            <div style={{ width: `${(g.wins / g.closed) * 100}%`, background: c.up }} />
            <div style={{ flex: 1, background: `${c.down}AA` }} />
          </div>
          <span style={{ ...num, fontSize: 12, color: c.dim, whiteSpace: "nowrap" }}>
            {g.wins}/{g.closed} · {pct(g.winRate)}{g.avgR !== null && ` · ${signed(g.avgR)}R`}
          </span>
        </div>
      ) : (
        <span style={{ fontSize: 12, color: c.dim }}>немає закритих</span>
      )}
      {extra && <span style={{ fontSize: 12, color: c.dim }}>{extra}</span>}
    </div>
  );
}

/** Діаграма надійності: точка = кошик оцінок; на діагоналі — ідеальне калібрування. Розмір точки — кількість. */
function CalibrationView({ title, cal, color }: { title: string; cal: Calibration; color: string }) {
  const [pick, setPick] = useState<Bin | null>(null);
  const S = 100;
  const maxN = Math.max(1, ...cal.bins.map((b) => b.n));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
      <svg viewBox={`-8 -4 ${S + 12} ${S + 14}`} width="100%" role="img" aria-label={`Калібрування: ${title}`} style={{ display: "block" }}>
        <rect x={0} y={0} width={S} height={S} fill={c.bg} stroke={c.line} />
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line x1={f * S} x2={f * S} y1={0} y2={S} stroke={c.line} strokeDasharray="1 3" />
            <line y1={f * S} y2={f * S} x1={0} x2={S} stroke={c.line} strokeDasharray="1 3" />
          </g>
        ))}
        <line x1={0} y1={S} x2={S} y2={0} stroke={c.faint} strokeDasharray="3 3" />
        {cal.bins.filter((b) => b.n > 0).map((b) => (
          <g key={b.from} onClick={() => setPick(pick?.from === b.from ? null : b)} style={{ cursor: "pointer" }}>
            <circle cx={b.predicted * S} cy={(1 - b.actual) * S} r={12} fill="transparent" />
            <circle cx={b.predicted * S} cy={(1 - b.actual) * S} r={3 + (b.n / maxN) * 5} fill={color} stroke={pick?.from === b.from ? c.ink : c.card} strokeWidth={1.5} />
          </g>
        ))}
        <text x={0} y={S + 9} fontSize={7} fill={c.faint}>0</text>
        <text x={S} y={S + 9} fontSize={7} fill={c.faint} textAnchor="end">оцінка 100%</text>
        <text x={-2} y={4} fontSize={7} fill={c.faint} textAnchor="end">100</text>
      </svg>
      <span style={{ ...num, fontSize: 11, color: c.dim, minHeight: 28 }}>
        {pick
          ? `${Math.round(pick.from * 100)}–${Math.round(pick.to * 100)}%: оцінка ${Math.round(pick.predicted * 100)}%, збулось ${Math.round(pick.actual * 100)}% з ${pick.n}`
          : cal.n
            ? `${cal.n} перевірених · Браєр ${cal.brier}`
            : "ще немає перевірених"}
      </span>
    </div>
  );
}

/** Порівняння двох відсотків від нуля: депозит системи проти утримання BTC. */
function VersusBars({ items }: { items: { name: string; value: number | null }[] }) {
  const max = Math.max(1, ...items.map((i) => Math.abs(i.value ?? 0)));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((i) => (
        <div key={i.name} style={{ display: "grid", gridTemplateColumns: "92px 1fr 64px", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: c.dim }}>{i.name}</span>
          <div style={{ position: "relative", height: 14 }} aria-hidden>
            <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: c.faint }} />
            {i.value !== null && (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  height: 14,
                  borderRadius: 4,
                  background: tone(i.value),
                  ...(i.value >= 0 ? { left: "50%", width: `${(i.value / max) * 50}%` } : { right: "50%", width: `${(-i.value / max) * 50}%` }),
                }}
              />
            )}
          </div>
          <span style={{ ...num, fontSize: 13, fontWeight: 700, textAlign: "right", color: tone(i.value) }}>{i.value === null ? "—" : `${signed(i.value, 1)}%`}</span>
        </div>
      ))}
    </div>
  );
}

/** Крива капіталу в R із перехрестям: торкнись, щоб побачити угоду. */
function EquityCurve({ trades }: { trades: { r: number; at: string; symbol: string }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  if (trades.length < 2) return null;
  const pts = trades.reduce<number[]>((acc, t) => [...acc, (acc[acc.length - 1] ?? 0) + t.r], [0]);
  const W = 360;
  const H = 150;
  const min = Math.min(0, ...pts);
  const max = Math.max(0, ...pts);
  const span = max - min || 1;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => 8 + ((max - v) / span) * (H - 16);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  // Найглибша просадка: від піку до мінімуму після нього.
  let peak = 0;
  let dd = 0;
  for (const v of pts) {
    peak = Math.max(peak, v);
    dd = Math.min(dd, v - peak);
  }
  const last = pts[pts.length - 1]!;
  const col = tone(last);
  const h = hover !== null && hover > 0 ? hover : null;
  const pick = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setHover(Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * (pts.length - 1)));
  };
  return (
    <section style={card} className="rise">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h2 style={h2}>Крива результату</h2>
        <span style={{ ...num, fontSize: 18, fontWeight: 700, color: col }}>{signed(last)}R</span>
      </div>
      <div style={{ ...num, fontSize: 12, color: c.dim, minHeight: 18 }}>
        {h !== null ? (
          <>
            Угода {h}: {coin(trades[h - 1]!.symbol)} <span style={{ color: tone(trades[h - 1]!.r), fontWeight: 600 }}>{signed(trades[h - 1]!.r)}R</span> · разом{" "}
            <span style={{ color: tone(pts[h]!), fontWeight: 600 }}>{signed(pts[h]!)}R</span> · {day(trades[h - 1]!.at)}
          </>
        ) : (
          <>Найбільша просадка <span style={{ color: c.down, fontWeight: 600 }}>{signed(dd)}R</span> · {trades.length} угод</>
        )}
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: "block", touchAction: "pan-y" }}
        role="img"
        aria-label={`Крива результату: ${signed(last)}R за ${trades.length} угод`}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerMove={(e) => (e.pointerType === "mouse" || e.buttons ? pick(e.clientX) : undefined)}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="eq" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={col} stopOpacity={0.3} />
            <stop offset="1" stopColor={col} stopOpacity={0} />
          </linearGradient>
        </defs>
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke={c.faint} strokeDasharray="3 3" />
        <text x={W - 2} y={y(0) - 4} fontSize={9} fill={c.faint} textAnchor="end">0R</text>
        <path d={`${line} L${W} ${y(0)} L0 ${y(0)} Z`} fill="url(#eq)" />
        <path d={line} stroke={col} strokeWidth={2} fill="none" strokeLinejoin="round" />
        {pts.slice(1).map((v, i) => (
          <circle key={i} cx={x(i + 1)} cy={y(v)} r={2} fill={tone(trades[i]!.r)} />
        ))}
        {h !== null && (
          <g pointerEvents="none">
            <line x1={x(h)} x2={x(h)} y1={0} y2={H} stroke={c.ink} strokeOpacity={0.5} />
            <circle cx={x(h)} cy={y(pts[h]!)} r={5} fill={col} stroke={c.ink} strokeWidth={2} />
          </g>
        )}
      </svg>
    </section>
  );
}

type Period = "all" | "30" | "7";
const PERIOD: Record<Period, string> = { all: "Увесь час", "30": "30 днів", "7": "7 днів" };

export function StatsView({ stats }: { stats: Stats }) {
  const s = stats.summary;
  const beats = s.btcHoldPct === null ? null : s.equityPct > s.btcHoldPct;
  const f = stats.funnel;
  const funnel = [
    { name: "Сканів зі свіжою 4h", v: f.scans, color: c.faint },
    { name: "Знайдено сетапів", v: f.detected, color: c.blue },
    { name: "Перевірила модель", v: f.reviewed, color: c.violet },
    { name: "Опубліковано", v: f.published, color: c.up },
  ];
  const fmax = Math.max(1, ...funnel.map((x) => x.v));
  const spendTotal = stats.spend.byPipeline.reduce((a, x) => a + x.usd, 0);
  return (
    <>
      <section style={card} className="rise">
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Ring value={s.closed / s.target} size={96} stroke={9} color={c.blue} label={`Закрито ${s.closed} із ${s.target}`}>
            <span style={{ ...num, fontSize: 24, fontWeight: 800 }}>{s.closed}</span>
            <span style={{ fontSize: 10, color: c.dim }}>із {s.target}</span>
          </Ring>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <span style={label}>Закритих сигналів</span>
            <span style={{ fontSize: 13, color: c.dim, lineHeight: 1.4 }}>
              {s.closed >= s.target ? "Вибірки досить для рішення." : `Ще ${s.target - s.closed} до рішення про реальні гроші.`}
            </span>
            <span style={{ fontSize: 12, color: c.dim }}>опубліковано {s.published} · відкрито {s.open}</span>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, paddingTop: 10, borderTop: `1px solid ${c.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Ring value={s.winRate} size={44} stroke={5} color={c.up} track={`${c.down}66`} label={`Прибуткових ${pct(s.winRate)}`}>
              <span style={{ ...num, fontSize: 11, fontWeight: 700 }}>{pct(s.winRate)}</span>
            </Ring>
            <span style={{ fontSize: 11, color: c.dim, lineHeight: 1.2 }}>при&shy;бут&shy;кових</span>
          </div>
          <Stat label="Середня" value={s.avgR === null ? "—" : `${signed(s.avgR)}R`} color={rColor(s.avgR)} />
          <Stat label="Разом" value={`${signed(s.totalR)}R`} color={rColor(s.totalR)} sub={s.avgFeeR === null ? undefined : `комісія ${s.avgFeeR}R/угода`} />
        </div>
      </section>

      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <h2 style={h2}>Проти утримання BTC</h2>
          {beats !== null && s.closed > 0 && <Pill color={beats ? c.up : c.down}>{beats ? "▲ краще" : "▼ гірше"}</Pill>}
        </div>
        <VersusBars items={[{ name: `Депозит, ризик ${s.riskPct}%`, value: s.equityPct }, { name: "Утримання BTC", value: s.btcHoldPct }]} />
        <p style={{ ...dim, fontSize: 12 }}>Усі R після комісій. Задум підтверджено, якщо після 100 закритих середній результат вищий за 0R і кращий за BTC.</p>
      </section>

      <section style={card}>
        <h2 style={h2}>За сетапами</h2>
        {stats.bySetup.length === 0 && <p style={dim}>Сигналів ще немає.</p>}
        <div>
          {stats.bySetup.map((g) => <GroupRow key={g.setup} name={SETUP[g.setup] ?? g.setup} g={g} extra={`${g.published} опубліковано`} />)}
          {stats.byVersion.length > 1 && stats.byVersion.map((g) => <GroupRow key={String(g.version)} name={`Правила, версія ${g.version ?? "—"}`} g={g} />)}
        </div>
        <p style={{ ...dim, fontSize: 12 }}>Смужка: зелене — прибуткові, червоне — збиткові.</p>
      </section>

      <section style={card}>
        <h2 style={h2}>Твої рішення</h2>
        <div>
          <GroupRow name="✓ Взяв" g={stats.journal.taken} />
          <GroupRow name="✕ Пропустив" g={stats.journal.skipped} />
          <GroupRow name="Без позначки" g={stats.journal.none} />
          <GroupRow name="Відхилені моделлю, якби брали" g={stats.rejected} extra={`${stats.rejected.count} кандидатів`} />
        </div>
      </section>

      <section style={card}>
        <h2 style={h2}>Калібрування</h2>
        <p style={{ ...dim, fontSize: 12 }}>Точка — кошик оцінок: праворуч вища оцінка, вгорі частіше збувалося. Добре відкалібровані точки лежать на пунктирі. Торкнись точки.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
          <CalibrationView title="Аналітик" cal={stats.calibration.analyst} color={c.violet} />
          <CalibrationView title="Скептик" cal={stats.calibration.skeptic} color={c.orange} />
          <CalibrationView title="Звіти" cal={stats.calibration.reports} color={c.blue} />
        </div>
      </section>

      <section style={card}>
        <h2 style={h2}>Воронка</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {funnel.map((x) => (
            <div key={x.name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
              <div style={{ width: `${Math.max(14, (x.v / fmax) * 100)}%`, minHeight: 30, borderRadius: 8, background: `${x.color}40`, border: `1px solid ${x.color}`, display: "grid", placeItems: "center", transition: "width 0.6s" }}>
                <span style={{ ...num, fontWeight: 700, fontSize: 14 }}>{x.v}</span>
              </div>
              <span style={{ fontSize: 11, color: c.dim }}>{x.name}</span>
            </div>
          ))}
        </div>
        {Object.keys(f.filtered).length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 8, borderTop: `1px solid ${c.line}` }}>
            <span style={label}>Відсіяв фільтр</span>
            {Object.entries(f.filtered)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => (
                <div key={k} style={{ display: "grid", gridTemplateColumns: "1fr 90px 28px", gap: 8, alignItems: "center", fontSize: 12 }}>
                  <span style={{ color: c.dim }}>{FILTER[k] ?? k}</span>
                  <Meter value={v / Math.max(1, f.detected)} color={c.orange} />
                  <span style={{ ...num, textAlign: "right" }}>{v}</span>
                </div>
              ))}
          </div>
        )}
        <Row label="Відхилила модель" value={String(f.rejected)} />
      </section>

      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={h2}>Витрати цього місяця</h2>
          <span style={{ ...num, fontWeight: 700 }}>
            ${stats.spend.monthUsd.toFixed(2)}
            {stats.spend.budgetUsd !== null && <span style={{ color: c.dim, fontWeight: 400 }}> із ${stats.spend.budgetUsd}</span>}
          </span>
        </div>
        {stats.spend.budgetUsd !== null && (
          <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", background: c.line, gap: 2 }} role="img" aria-label="Витрати за конвеєрами від бюджету">
            {stats.spend.byPipeline.map((x) => (
              <div key={x.pipeline} title={`${PIPELINE[x.pipeline] ?? x.pipeline}: $${x.usd.toFixed(3)}`} style={{ width: `${(x.usd / stats.spend.budgetUsd!) * 100}%`, background: PIPELINE_COLOR[x.pipeline] ?? c.dim }} />
            ))}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {stats.spend.byPipeline.map((x) => (
            <div key={x.pipeline} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, background: PIPELINE_COLOR[x.pipeline] ?? c.dim }} />
              <span style={{ flex: 1, minWidth: 0 }}>{PIPELINE[x.pipeline] ?? x.pipeline}</span>
              <span style={{ fontSize: 12, color: c.dim }}>{x.calls} викл.</span>
              <span style={{ ...num, width: 60, textAlign: "right" }}>${x.usd.toFixed(3)}</span>
              <span style={{ ...num, width: 36, textAlign: "right", color: c.dim, fontSize: 12 }}>{spendTotal ? Math.round((x.usd / spendTotal) * 100) : 0}%</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

export function Stats() {
  const [period, setPeriod] = useState<Period>("all");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState<SignalCard[] | null>(null);
  useEffect(() => {
    setStats(null);
    api<Stats>(`/api/stats?period=${period}`).then(
      (d) => {
        setStats(d);
        setError(null);
      },
      (e) => setError(String(e)),
    );
  }, [period]);
  useEffect(() => {
    api<{ signals: SignalCard[] }>("/api/signals?scope=closed").then((d) => setClosed(d.signals), () => setClosed(null));
  }, []);
  // Крива з останніх закритих сигналів (до 50) у межах періоду, від старих до нових.
  const trades = (closed ?? [])
    .filter((x) => x.result_r !== null && (!stats?.from || (x.resolved_at ?? x.created_at) >= stats.from))
    .map((x) => ({ r: x.result_r! - (x.fee_r ?? 0), at: x.resolved_at ?? x.created_at, symbol: x.symbol }))
    .sort((a, b) => a.at.localeCompare(b.at));
  return (
    <>
      <Segmented options={(Object.keys(PERIOD) as Period[]).map((k) => [k, PERIOD[k]])} value={period} onChange={setPeriod} />
      {error && <p style={{ ...p, color: c.orange }}>{error}</p>}
      {!stats && !error && (
        <>
          <Skeleton height={170} />
          <Skeleton height={120} />
        </>
      )}
      {stats && <EquityCurve trades={trades} />}
      {stats && <StatsView stats={stats} />}
    </>
  );
}
