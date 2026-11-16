import { useCallback, useEffect, useMemo, useState } from "react";
import { errorSummary } from "../shared/errors";
import { fmtPrice, useLivePrice } from "./live";
import { Push } from "./Push";
import type { ReportCard } from "./Reports";
import { OpenSignals } from "./Signals";
import { api, c, card, coin, dim, h2, KIND, label, num, p, primary, secondary, time, tone } from "./ui";
import { Delta, Gauge, LiveDot, Meter, Pill, PriceChart, Ring, Segmented, Skeleton, Slider, Stat, useCandles } from "./viz";

interface Target { name: string; ok: boolean; status: number | null; ms: number; note?: string }
type Trend = "up" | "down" | "range" | null;
interface ScanDetail {
  source: string;
  market: { mood: "risk_on" | "risk_off" | "mixed"; btcTrend: Trend; breadth: number | null };
  symbols: number;
  snapshots: number;
}
interface MarketContext { btcDominancePct: number | null; totalMarketCapUsd: number | null; marketCapChange24hPct: number | null; fearGreed: number | null; at: string }
interface Status {
  lastRun: { kind: string; started_at: string; status: string; detail: Target[] | ScanDetail | null; error: string | null } | null;
  lastReport: ReportCard | null;
  context: MarketContext | null;
  spend: { monthUsd: number; budgetUsd: number | null };
  btc: { price: number; at: string } | null;
  cycle: { at: string; steps: number; maxRequests: number; failed: number } | null;
}

interface Tf { close: number; ema20: number | null; ema50: number | null; ema200: number | null; rsi14: number | null; atrPct: number | null; changePct: number | null; volumeRatio: number | null }
interface Level { price: number; touches: number }
interface Snapshot {
  symbol: string;
  ts: string;
  price: number;
  tf: Record<"15m" | "1h" | "4h" | "1d", Tf>;
  levels: { "4h": { support: Level[]; resistance: Level[] } };
  funding: { rate: number } | null;
  openInterest: { valueUsd: number | null; change24hPct: number | null } | null;
  regime: { trend: Trend; higherTrend: Trend; volatility: "low" | "normal" | "high" | null };
}

const MOOD = {
  risk_on: { text: "ризик-он", color: c.up, icon: "▲" },
  risk_off: { text: "ризик-оф", color: c.down, icon: "▼" },
  mixed: { text: "змішаний", color: c.yellow, icon: "◆" },
} as const;
const TREND_ICON = { up: "↗", down: "↘", range: "→" } as const;
const TREND_TEXT = { up: "вгору", down: "вниз", range: "боковик" } as const;
const trendColor = (t: Trend) => (t === "up" ? c.up : t === "down" ? c.down : c.dim);
const VOL = { low: "низька", normal: "звичайна", high: "висока" } as const;

function fearText(v: number): string {
  if (v < 25) return "екстремальний страх";
  if (v < 45) return "страх";
  if (v <= 55) return "нейтрально";
  if (v <= 75) return "жадібність";
  return "екстремальна жадібність";
}

const usdShort = (v: number) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)} трлн` : v >= 1e9 ? `$${(v / 1e9).toFixed(1)} млрд` : `$${Math.round(v / 1e6)} млн`);

// ───────────────────────── BTC ─────────────────────────

type Range = "1d" | "3d" | "10d";
const RANGE: Record<Range, { tf: "1h" | "4h"; limit: number; text: string }> = {
  "1d": { tf: "1h", limit: 24, text: "за 24 год" },
  "3d": { tf: "1h", limit: 72, text: "за 3 дні" },
  "10d": { tf: "4h", limit: 60, text: "за 10 днів" },
};

function BtcHero({ status, scan }: { status: Status | null; scan: ScanDetail | null }) {
  const [range, setRange] = useState<Range>("1d");
  const live = useLivePrice("BTCUSDT");
  const { candles, error } = useCandles("BTCUSDT", RANGE[range].tf, RANGE[range].limit);
  const price = live ?? candles?.[candles.length - 1]?.close ?? status?.btc?.price ?? null;
  const base = candles?.[0]?.open ?? null;
  const change = price !== null && base ? ((price - base) / base) * 100 : null;
  return (
    <section style={{ ...card, gap: 8 }} className="rise">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span aria-hidden style={{ width: 34, height: 34, borderRadius: 17, background: "#F7931A", color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 18 }}>₿</span>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Bitcoin</span>
          <span style={{ fontSize: 12, color: c.dim }}>BTCUSDT · ф'ючерс</span>
        </div>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: c.dim }}>
          <LiveDot on={live !== null} />
          {live !== null ? "наживо" : status?.btc ? `скан о ${time(status.btc.at)}` : ""}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ ...num, fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>{price === null ? "—" : fmtPrice(price)}</span>
        <Delta value={change} size={15} bg />
        <span style={{ fontSize: 12, color: c.dim }}>{RANGE[range].text}</span>
      </div>
      {scan && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Pill color={MOOD[scan.market.mood].color}>{MOOD[scan.market.mood].icon} Ринок {MOOD[scan.market.mood].text}</Pill>
          {scan.market.btcTrend && (
            <Pill color={trendColor(scan.market.btcTrend)}>
              {TREND_ICON[scan.market.btcTrend]} 4h {TREND_TEXT[scan.market.btcTrend]}
            </Pill>
          )}
        </div>
      )}
      {error ? (
        <p style={dim}>Графік недоступний: {error}</p>
      ) : candles?.length ? (
        <PriceChart candles={candles} live={live} />
      ) : (
        <Skeleton height={190} />
      )}
      <Segmented options={[["1d", "24 год"], ["3d", "3 дні"], ["10d", "10 днів"]]} value={range} onChange={setRange} size="sm" />
    </section>
  );
}

// ───────────────────────── Ринок ─────────────────────────

function MarketGauges({ scan, ctx }: { scan: ScanDetail | null; ctx: MarketContext | null }) {
  const breadth = scan?.market.breadth ?? null;
  const fg = ctx?.fearGreed ?? null;
  return (
    <section style={card} className="rise">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={h2}>Настрій ринку</h2>
        {ctx && <span style={{ fontSize: 11, color: c.faint }}>фон зі звіту о {time(ctx.at)}</span>}
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <Gauge value={fg === null ? null : fg / 100} display={fg === null ? "—" : String(Math.round(fg))} caption={fg === null ? "Страх і жадібність" : `Страх і жадібність · ${fearText(fg)}`} />
        <Gauge value={breadth} display={breadth === null ? "—" : `${Math.round(breadth * 100)}%`} caption="Монет вище EMA200 на 4h" />
      </div>
      {ctx && (ctx.btcDominancePct !== null || ctx.marketCapChange24hPct !== null) && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, paddingTop: 10, borderTop: `1px solid ${c.line}` }}>
          {ctx.btcDominancePct !== null && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <Stat label="Домінація BTC" value={`${ctx.btcDominancePct.toFixed(1)}%`} />
              <Meter value={ctx.btcDominancePct / 100} color="#F7931A" />
            </div>
          )}
          {ctx.marketCapChange24hPct !== null && (
            <Stat
              label="Капіталізація"
              value={<Delta value={ctx.marketCapChange24hPct} size={17} />}
              sub={ctx.totalMarketCapUsd !== null ? `${usdShort(ctx.totalMarketCapUsd)} · за 24 год` : "за 24 год"}
            />
          )}
        </div>
      )}
    </section>
  );
}

// ───────────────────────── Монети ─────────────────────────

type Metric = "1h" | "4h" | "ema" | "rsi" | "funding" | "oi";
const METRIC: Record<Metric, { name: string; scale: number; center?: number; get: (s: Snapshot) => number | null; fmt: (v: number) => string; hint: string }> = {
  "1h": { name: "1h", scale: 1.5, get: (s) => s.tf["1h"].changePct, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`, hint: "Зміна за останню закриту свічку 1h." },
  "4h": { name: "4h", scale: 3, get: (s) => s.tf["4h"].changePct, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`, hint: "Зміна за останню закриту свічку 4h." },
  ema: {
    name: "EMA200",
    scale: 10,
    get: (s) => (s.tf["4h"].ema200 ? ((s.price - s.tf["4h"].ema200) / s.tf["4h"].ema200) * 100 : null),
    fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`,
    hint: "Відстань ціни від EMA200 на 4h: вище нуля — монета в бичачій зоні.",
  },
  rsi: { name: "RSI", scale: 25, center: 50, get: (s) => s.tf["4h"].rsi14, fmt: (v) => v.toFixed(0), hint: "RSI 14 на 4h: вище 70 перекупленість, нижче 30 перепроданість." },
  funding: { name: "Фандинг", scale: 0.03, get: (s) => (s.funding ? s.funding.rate * 100 : null), fmt: (v) => `${v.toFixed(3)}%`, hint: "Ставка фінансування: плюс — лонги платять шортам." },
  oi: { name: "OI 24h", scale: 10, get: (s) => s.openInterest?.change24hPct ?? null, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`, hint: "Зміна відкритого інтересу за добу." },
};

/** Фон плитки: інтенсивність кольору за силою значення (розбіжна шкала навколо нуля або центру). */
function heat(v: number | null, scale: number, center = 0): string {
  if (v === null) return c.card2;
  const d = v - center;
  const a = Math.min(1, Math.abs(d) / scale);
  const hex = Math.round(18 + a * 150).toString(16).padStart(2, "0");
  return d === 0 ? c.card2 : `${d > 0 ? c.up : c.down}${hex}`;
}

function CoinDetail({ s }: { s: Snapshot }) {
  const { candles } = useCandles(s.symbol, "4h", 42);
  const live = useLivePrice(s.symbol);
  const price = live ?? s.price;
  const sup = s.levels["4h"].support[0]?.price ?? null;
  const res = s.levels["4h"].resistance[0]?.price ?? null;
  const ema200 = s.tf["4h"].ema200;
  const rsi = s.tf["4h"].rsi14;
  const levels = [
    ...(res !== null ? [{ price: res, color: c.down, label: `опір ${fmtPrice(res)}` }] : []),
    ...(sup !== null ? [{ price: sup, color: c.up, label: `підтримка ${fmtPrice(sup)}` }] : []),
  ];
  return (
    <div className="rise" style={{ display: "flex", flexDirection: "column", gap: 12, padding: 12, borderRadius: 14, background: c.bg, border: `1px solid ${c.line}` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 17 }}>{coin(s.symbol)}</span>
        <span style={{ ...num, fontSize: 17, fontWeight: 600 }}>{fmtPrice(price)}</span>
        <Delta value={s.tf["4h"].changePct} size={12} />
        {live !== null && <LiveDot />}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Pill color={trendColor(s.regime.trend)}>{s.regime.trend ? TREND_ICON[s.regime.trend] : "?"} 4h {s.regime.trend ? TREND_TEXT[s.regime.trend] : "—"}</Pill>
        <Pill color={trendColor(s.regime.higherTrend)}>{s.regime.higherTrend ? TREND_ICON[s.regime.higherTrend] : "?"} 1д {s.regime.higherTrend ? TREND_TEXT[s.regime.higherTrend] : "—"}</Pill>
        {s.regime.volatility && <Pill color={s.regime.volatility === "high" ? c.orange : c.blue}>волатильність {VOL[s.regime.volatility]}</Pill>}
      </div>
      {candles?.length ? <PriceChart candles={candles} live={live} height={140} levels={levels} /> : <Skeleton height={160} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: c.dim }}>
          <span>RSI 14 · 4h</span>
          <span style={{ ...num, color: rsi === null ? c.dim : rsi >= 70 ? c.orange : rsi <= 30 ? c.blue : c.ink, fontWeight: 600 }}>
            {rsi === null ? "—" : `${Math.round(rsi)}${rsi >= 70 ? " · перекуплено" : rsi <= 30 ? " · перепродано" : ""}`}
          </span>
        </div>
        <Slider value={rsi} min={0} max={100} ticks={[30, 50, 70]} zones={[{ to: 30, color: c.blue }, { to: 70, color: c.faint }, { to: 100, color: c.orange }]} />
      </div>
      {sup !== null && res !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12, color: c.dim }}>Ціна між рівнями 4h</span>
          <Slider value={price} min={sup} max={res} zones={[{ to: sup + (res - sup) / 3, color: c.up }, { to: res - (res - sup) / 3, color: c.faint }, { to: res, color: c.down }]} />
          <div style={{ ...num, display: "flex", justifyContent: "space-between", fontSize: 11, color: c.dim, gap: 8 }}>
            <span>
              <span style={{ color: c.up }}>підтримка {fmtPrice(sup)}</span> · {(((price - sup) / price) * 100).toFixed(1)}%
            </span>
            <span style={{ textAlign: "right" }}>
              {(((res - price) / price) * 100).toFixed(1)}% · <span style={{ color: c.down }}>опір {fmtPrice(res)}</span>
            </span>
          </div>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <Stat label="EMA200" value={ema200 ? `${(((price - ema200) / ema200) * 100).toFixed(1)}%` : "—"} color={ema200 ? tone(price - ema200) : undefined} sub={ema200 ? fmtPrice(ema200) : undefined} />
        <Stat label="Фандинг" value={s.funding ? `${(s.funding.rate * 100).toFixed(3)}%` : "—"} color={s.funding ? tone(s.funding.rate) : undefined} />
        <Stat label="OI 24h" value={<Delta value={s.openInterest?.change24hPct ?? null} digits={1} size={17} />} sub={s.openInterest?.valueUsd ? usdShort(s.openInterest.valueUsd) : undefined} />
        <Stat label="ATR 4h" value={s.tf["4h"].atrPct === null ? "—" : `${s.tf["4h"].atrPct.toFixed(2)}%`} />
        <Stat label="Обсяг" value={s.tf["4h"].volumeRatio === null ? "—" : `×${s.tf["4h"].volumeRatio.toFixed(1)}`} sub="до середнього 20" />
        <Stat label="1h" value={<Delta value={s.tf["1h"].changePct} size={17} />} />
      </div>
    </div>
  );
}

function CoinMap() {
  const [data, setData] = useState<{ at: string; snapshots: Snapshot[] } | null>(null);
  const [metric, setMetric] = useState<Metric>("4h");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    api<{ run: { started_at: string } | null; snapshots: Snapshot[] }>("/api/snapshots/latest").then(
      (d) => setData(d.run ? { at: d.run.started_at, snapshots: d.snapshots.filter((s) => s?.tf?.["4h"]) } : null),
      () => setData(null),
    );
  }, []);
  const m = METRIC[metric];
  const sorted = useMemo(
    () => [...(data?.snapshots ?? [])].sort((a, b) => (m.get(b) ?? -Infinity) - (m.get(a) ?? -Infinity)),
    [data, m],
  );
  if (!data?.snapshots.length) return null;
  const sel = sorted.find((s) => s.symbol === selected) ?? null;
  const up = sorted.filter((s) => (m.get(s) ?? m.center ?? 0) > (m.center ?? 0)).length;
  return (
    <section style={card} className="rise">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h2 style={h2}>Монети</h2>
        <span style={{ fontSize: 12, color: c.dim }}>
          <span style={{ color: c.up }}>▲ {up}</span> · <span style={{ color: c.down }}>▼ {sorted.length - up}</span> · скан о {time(data.at)}
        </span>
      </div>
      <div className="scroll-x">
        <Segmented options={(Object.keys(METRIC) as Metric[]).map((k) => [k, METRIC[k].name])} value={metric} onChange={setMetric} size="sm" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 6 }}>
        {sorted.map((s) => {
          const v = m.get(s);
          const active = s.symbol === selected;
          return (
            <button
              key={s.symbol}
              type="button"
              className="press"
              aria-pressed={active}
              onClick={() => setSelected(active ? null : s.symbol)}
              style={{
                border: `1px solid ${active ? c.ink : "transparent"}`,
                borderRadius: 12,
                padding: "8px 10px",
                background: heat(v, m.scale, m.center),
                color: c.ink,
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: 2,
                minHeight: 58,
                cursor: "pointer",
              }}
            >
              <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: 700, fontSize: 13 }}>
                {coin(s.symbol)}
                <span style={{ fontSize: 14, color: c.ink, opacity: 0.85 }} title="тренд 4h">{s.regime.trend ? TREND_ICON[s.regime.trend] : ""}</span>
              </span>
              <span style={{ ...num, fontSize: 14, fontWeight: 600 }}>{v === null ? "—" : m.fmt(v)}</span>
            </button>
          );
        })}
      </div>
      <p style={{ ...dim, fontSize: 12 }}>{m.hint} Стрілка в куті — тренд 4h. Торкнись монети, щоб побачити графік і деталі.</p>
      {sel && <CoinDetail key={sel.symbol} s={sel} />}
    </section>
  );
}

// ───────────────────────── Звіт ─────────────────────────

function ReportTeaser({ report, onOpen }: { report: ReportCard | null; onOpen: (id: number) => void }) {
  if (!report) {
    return (
      <section style={card}>
        <h2 style={h2}>Звіт</h2>
        <p style={dim}>Звітів ще немає. Перший з'явиться о 07:30 або 20:30 за Києвом.</p>
      </section>
    );
  }
  const icon = report.kind === "morning" ? "☀" : report.kind === "evening" ? "☾" : "▦";
  return (
    <button type="button" className="press rise" onClick={() => onOpen(report.id)} style={{ ...card, color: c.ink, textAlign: "left", font: "inherit", cursor: "pointer", position: "relative", overflow: "hidden" }}>
      <span aria-hidden style={{ position: "absolute", right: -20, top: -30, fontSize: 120, opacity: 0.05, lineHeight: 1 }}>{icon}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ width: 28, height: 28, borderRadius: 8, display: "grid", placeItems: "center", background: `${c.yellow}22`, color: c.yellow, fontSize: 15 }}>{icon}</span>
        <span style={label}>{KIND[report.kind] ?? report.kind} звіт · {time(report.created_at)}</span>
        <span style={{ marginLeft: "auto", color: c.blue, fontSize: 13, fontWeight: 600 }}>Відкрити →</span>
      </span>
      <span style={{ fontSize: 17, fontWeight: 700, lineHeight: 1.3 }}>{report.headline}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {report.theses.map((t, i) => (
          <span key={t} style={{ display: "flex", gap: 10, ...p }}>
            <span aria-hidden style={{ flex: "none", width: 20, height: 20, borderRadius: 10, background: c.line, color: c.dim, fontSize: 11, fontWeight: 700, display: "grid", placeItems: "center", marginTop: 1 }}>{i + 1}</span>
            <span style={{ color: "#C9CFD9" }}>{t}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

// ───────────────────────── Пульс системи ─────────────────────────

function SystemPulse({ status, error, reload }: { status: Status | null; error: string | null; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const run = status?.lastRun;
  const targets = Array.isArray(run?.detail) ? run.detail : null;
  const scan = run?.detail && !Array.isArray(run.detail) ? run.detail : null;
  const ok = run?.status === "ok";

  const probe = async () => {
    setBusy(true);
    try {
      await fetch("/api/probe", { method: "POST" });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  /** Скан іде кроками у фоні: перечитуємо стан кілька разів, поки цикл не завершиться. */
  const startScan = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/scan", { method: "POST" });
      if (res.status === 409) {
        setScanNote("Цикл уже триває, результат буде за хвилину.");
        return;
      }
      setScanNote("Скан запущено: він іде кроками, результат з'явиться за хвилину.");
      for (const delay of [8_000, 15_000, 30_000, 45_000]) {
        await new Promise((r) => setTimeout(r, delay));
        await reload();
      }
      setScanNote(null);
    } finally {
      setBusy(false);
    }
  };

  const budget = status?.spend.budgetUsd ?? null;
  const spendShare = status && budget ? status.spend.monthUsd / budget : null;
  const spendColor = spendShare === null ? c.blue : spendShare > 0.9 ? c.down : spendShare > 0.7 ? c.orange : c.violet;
  const reqShare = status?.cycle ? status.cycle.maxRequests / 50 : null;

  return (
    <section style={card}>
      <h2 style={h2}>Пульс системи</h2>
      {error && <p style={{ ...p, color: c.orange }}>Немає зв'язку з API: {error}</p>}
      {!error && !run && <p style={dim}>Запусків ще не було.</p>}
      {run && (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 10, borderRadius: 12, background: ok ? `${c.up}14` : `${c.orange}14`, border: `1px solid ${ok ? `${c.up}40` : `${c.orange}40`}` }}>
          <span aria-hidden style={{ flex: "none", width: 24, height: 24, borderRadius: 12, display: "grid", placeItems: "center", background: ok ? c.up : c.orange, color: c.bg, fontWeight: 800, fontSize: 13 }}>{ok ? "✓" : "!"}</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
            <span style={{ ...p, fontWeight: 600 }}>
              {run.kind === "scan" ? "Скан" : "Перевірка джерел"} о {time(run.started_at)}: {ok ? "успішно" : "помилка"}
            </span>
            {!ok && <span style={{ ...p, fontSize: 13, color: c.orange }}>{errorSummary(run.error)}</span>}
            {!ok && run.error && (
              <details style={{ fontSize: 12, color: c.dim }}>
                <summary style={{ cursor: "pointer", minHeight: 28, display: "flex", alignItems: "center" }}>Деталі помилки</summary>
                <p style={{ ...dim, fontSize: 12, marginTop: 6 }}>{run.error}</p>
              </details>
            )}
          </div>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, justifyItems: "center", textAlign: "center" }}>
        {scan && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <Ring value={scan.symbols ? scan.snapshots / scan.symbols : null} color={scan.snapshots === scan.symbols ? c.up : c.orange} label={`Скан: ${scan.snapshots} із ${scan.symbols} монет`}>
              <span style={{ ...num, fontSize: 16, fontWeight: 700 }}>{scan.snapshots}</span>
              <span style={{ fontSize: 10, color: c.dim }}>із {scan.symbols}</span>
            </Ring>
            <span style={{ fontSize: 11, color: c.dim }}>монет · {scan.source}</span>
          </div>
        )}
        {status && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <Ring value={spendShare} color={spendColor} label={`Витрати: $${status.spend.monthUsd.toFixed(2)}`}>
              <span style={{ ...num, fontSize: 14, fontWeight: 700 }}>${status.spend.monthUsd.toFixed(2)}</span>
              {budget !== null && <span style={{ fontSize: 10, color: c.dim }}>із ${budget}</span>}
            </Ring>
            <span style={{ fontSize: 11, color: c.dim }}>ШІ за місяць</span>
          </div>
        )}
        {status?.cycle && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <Ring value={reqShare} color={reqShare !== null && reqShare > 0.8 ? c.orange : c.blue} label={`До ${status.cycle.maxRequests} запитів на крок із 50`}>
              <span style={{ ...num, fontSize: 16, fontWeight: 700 }}>{status.cycle.maxRequests}</span>
              <span style={{ fontSize: 10, color: c.dim }}>із 50</span>
            </Ring>
            <span style={{ fontSize: 11, color: c.dim }}>
              запитів/крок{status.cycle.failed > 0 && <span style={{ color: c.orange }}> · збоїв {status.cycle.failed}</span>}
            </span>
          </div>
        )}
      </div>
      {status?.cycle && (
        <p style={{ ...dim, fontSize: 12, textAlign: "center" }}>
          Цикл о {time(status.cycle.at)}: {status.cycle.steps} кроків
        </p>
      )}
      {targets && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {targets.map((t) => (
            <div key={t.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: t.ok ? c.up : c.down }} />
              <span style={{ flex: 1, minWidth: 0 }}>{t.name}</span>
              <span style={{ ...num, color: t.ok ? c.dim : c.down }}>{t.ok ? "доступний" : "недоступний"} · {t.status ?? "—"}</span>
              <span style={{ ...num, width: 56, textAlign: "right", color: c.dim }}>{t.ms} мс</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="press" onClick={startScan} disabled={busy} style={{ ...primary, flex: 1, fontSize: 14 }}>
          {busy ? "Працюю…" : "⟳ Запустити скан"}
        </button>
        <button type="button" className="press" onClick={probe} disabled={busy} style={{ ...secondary, flex: 1, fontSize: 14 }}>
          Перевірити джерела
        </button>
      </div>
      {scanNote && <p style={dim}>{scanNote}</p>}
    </section>
  );
}

export function Today({ onOpenReport, onOpenSignal }: { onOpenReport: (id: number) => void; onOpenSignal: (id: number) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/status"));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = status?.lastRun;
  const scan = run?.detail && !Array.isArray(run.detail) ? run.detail : null;

  return (
    <>
      <BtcHero status={status} scan={scan} />
      <OpenSignals onOpen={onOpenSignal} lastScan={run?.kind === "scan" ? run.started_at : null} />
      <MarketGauges scan={scan} ctx={status?.context ?? null} />
      <CoinMap />
      <ReportTeaser report={status?.lastReport ?? null} onOpen={onOpenReport} />
      <SystemPulse status={status} error={error} reload={load} />
      <Push />
      <p style={{ ...dim, textAlign: "center", fontSize: 12 }}>Скан раз на 30 хв, звіти о 07:30 і 20:30. Система пропонує, рішення за тобою.</p>
    </>
  );
}
