/**
 * Візуальні примітиви застосунку: шкали, кільця, смужки, інтерактивний графік ціни.
 * Усе на SVG і стилях без бібліотек, щоб PWA лишався легким.
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { fmtPrice } from "./live";
import { api, arrow, c, num, tone } from "./ui";

export interface Candle { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume?: number }

/** Свічки через рушій (кеш у SQLite рушія, біржа докачує лише нові). */
export function useCandles(symbol: string | null, tf: "15m" | "1h" | "4h", limit: number) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    setCandles(null);
    setError(null);
    api<{ candles: Candle[] }>(`/api/candles/${symbol}?tf=${tf}&limit=${limit}`).then(
      (d) => alive && setCandles(d.candles),
      (e) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [symbol, tf, limit]);
  return { candles, error };
}

/** Зміна зі стрілкою: колір ніколи не єдиний носій напрямку. */
export function Delta({ value, suffix = "%", digits = 2, size = 13, bg = false }: { value: number | null | undefined; suffix?: string; digits?: number; size?: number; bg?: boolean }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span style={{ fontSize: size, color: c.dim }}>—</span>;
  const color = tone(value);
  return (
    <span
      style={{
        ...num,
        fontSize: size,
        fontWeight: 600,
        color,
        whiteSpace: "nowrap",
        ...(bg ? { background: `${color}1F`, padding: "3px 8px", borderRadius: 8 } : {}),
      }}
    >
      <span style={{ fontSize: size * 0.75, marginRight: 3 }}>{arrow(value)}</span>
      {Math.abs(value).toFixed(digits)}
      {suffix}
    </span>
  );
}

export function Pill({ children, color = c.dim, solid = false, style }: { children: ReactNode; color?: string; solid?: boolean; style?: CSSProperties }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1,
        padding: "5px 9px",
        borderRadius: 999,
        color: solid ? c.bg : color,
        background: solid ? color : `${color}1F`,
        border: `1px solid ${solid ? color : `${color}40`}`,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function LiveDot({ on = true }: { on?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 4,
        background: on ? c.up : c.faint,
        animation: on ? "pulse 1.8s infinite" : undefined,
      }}
    />
  );
}

/** Перемикач-сегменти. */
export function Segmented<T extends string>({ options, value, onChange, size = "md" }: { options: [T, string][]; value: T; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div role="tablist" style={{ display: "flex", gap: 2, padding: 3, borderRadius: 12, background: c.bg, border: `1px solid ${c.line}`, minWidth: 0 }}>
      {options.map(([k, label]) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={value === k}
          onClick={() => onChange(k)}
          className="press"
          style={{
            flex: 1,
            minHeight: size === "sm" ? 30 : 36,
            border: 0,
            borderRadius: 9,
            padding: "0 10px",
            background: value === k ? c.card2 : "transparent",
            boxShadow: value === k ? `0 0 0 1px ${c.line}, 0 2px 8px rgba(0,0,0,0.35)` : undefined,
            color: value === k ? c.ink : c.dim,
            font: `600 ${size === "sm" ? 12 : 13}px Inter, system-ui, sans-serif`,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%", style }: { height?: number; width?: number | string; style?: CSSProperties }) {
  return <div className="skeleton" aria-hidden style={{ height, width, ...style }} />;
}

const polar = (cx: number, cy: number, r: number, v: number) => {
  const a = Math.PI * (1 - v);
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)] as const;
};
const arcPath = (cx: number, cy: number, r: number, from: number, to: number) => {
  const [x1, y1] = polar(cx, cy, r, from);
  const [x2, y2] = polar(cx, cy, r, to);
  return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`;
};

/** Шкала від «погано» до «добре» для спідометра: червоний → помаранчевий → жовтий → зелений. */
export const GAUGE_ZONES = [c.down, c.orange, c.yellow, "#8FD14F", c.up];

/**
 * Півкруглий спідометр зі стрілкою. value 0..1; null показує порожню шкалу.
 * zones: кольори рівних секторів зліва направо.
 */
export function Gauge({ value, display, caption, zones = GAUGE_ZONES, size = 150 }: { value: number | null; display: string; caption: string; zones?: string[]; size?: number }) {
  const W = 120;
  const cx = 60;
  const cy = 60;
  const r = 48;
  const gap = 0.012;
  const v = value === null ? null : Math.min(1, Math.max(0, value));
  const [tipX, tipY] = v === null ? [cx, cy] : polar(cx, cy, r - 14, v);
  const zone = v === null ? c.dim : zones[Math.min(zones.length - 1, Math.floor(v * zones.length))]!;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 0, flex: 1 }}>
      <svg viewBox={`0 0 ${W} 70`} width="100%" style={{ maxWidth: size, display: "block", overflow: "visible" }} role="img" aria-label={`${caption}: ${display}`}>
        {zones.map((color, i) => (
          <path
            key={color}
            d={arcPath(cx, cy, r, i / zones.length + (i ? gap : 0), (i + 1) / zones.length - (i < zones.length - 1 ? gap : 0))}
            stroke={color}
            strokeOpacity={v === null ? 0.25 : 0.85}
            strokeWidth={9}
            fill="none"
            strokeLinecap={i === 0 || i === zones.length - 1 ? "round" : "butt"}
          />
        ))}
        {v !== null && (
          <g style={{ transition: "transform 0.6s" }}>
            <line x1={cx} y1={cy} x2={tipX} y2={tipY} stroke={c.ink} strokeWidth={2.5} strokeLinecap="round" />
            <circle cx={cx} cy={cy} r={5} fill={c.ink} />
            <circle cx={cx} cy={cy} r={2} fill={c.bg} />
          </g>
        )}
      </svg>
      <span style={{ ...num, fontSize: 20, fontWeight: 700, color: zone, marginTop: 2 }}>{display}</span>
      <span style={{ fontSize: 12, color: c.dim, textAlign: "center" }}>{caption}</span>
    </div>
  );
}

/** Кільце прогресу з довільним вмістом у центрі. */
export function Ring({ value, size = 72, stroke = 7, color = c.blue, track = c.line, children, label }: { value: number | null; size?: number; stroke?: number; color?: string; track?: string; children?: ReactNode; label?: string }) {
  const r = (size - stroke) / 2;
  const len = 2 * Math.PI * r;
  const v = value === null ? 0 : Math.min(1, Math.max(0, value));
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }} role={label ? "img" : undefined} aria-label={label}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)", display: "block" }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${len * v} ${len}`}
          style={{ transition: "stroke-dasharray 0.8s ease" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", lineHeight: 1.1 }}>{children}</div>
    </div>
  );
}

/** Горизонтальна смужка 0..1 з необов'язковою риской-орієнтиром. */
export function Meter({ value, marker, color = c.blue, height = 6, zones }: { value: number | null; marker?: number | null; color?: string; height?: number; zones?: string[] }) {
  const v = value === null ? 0 : Math.min(1, Math.max(0, value));
  return (
    <div style={{ position: "relative", height, borderRadius: height / 2, background: zones ? `linear-gradient(90deg, ${zones.map((z) => `${z}33`).join(", ")})` : c.line, flex: "1 0 auto", minWidth: 0 }} aria-hidden>
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${v * 100}%`, borderRadius: height / 2, background: color, transition: "width 0.6s ease" }} />
      {marker !== undefined && marker !== null && (
        <div style={{ position: "absolute", left: `calc(${Math.min(1, Math.max(0, marker)) * 100}% - 1px)`, top: -3, width: 2, height: height + 6, borderRadius: 1, background: c.ink }} />
      )}
    </div>
  );
}

/** Шкала з бігунком: позиція значення між min і max (наприклад RSI 0..100 із зонами 30/70). */
export function Slider({ value, min, max, zones, ticks }: { value: number | null; min: number; max: number; zones: { to: number; color: string }[]; ticks?: number[] }) {
  const pos = (x: number) => ((x - min) / (max - min)) * 100;
  const v = value === null ? null : Math.min(max, Math.max(min, value));
  let from = min;
  return (
    <div style={{ position: "relative", height: ticks?.length ? 28 : 18, flex: "1 0 auto", minWidth: 0 }} aria-hidden>
      <div style={{ position: "absolute", left: 0, right: 0, top: 7, height: 4, borderRadius: 2, overflow: "hidden", display: "flex", gap: 2 }}>
        {zones.map((z) => {
          const w = pos(z.to) - pos(from);
          from = z.to;
          return <div key={z.to} style={{ width: `${w}%`, background: z.color, opacity: 0.55 }} />;
        })}
      </div>
      {ticks?.map((t) => (
        <span key={t} style={{ position: "absolute", left: `${pos(t)}%`, top: 16, transform: "translateX(-50%)", fontSize: 10, lineHeight: 1, color: c.faint }}>{t}</span>
      ))}
      {v !== null && (
        <div style={{ position: "absolute", left: `calc(${pos(v)}% - 6px)`, top: 3, width: 12, height: 12, borderRadius: 6, background: c.ink, border: `2px solid ${c.bg}`, boxShadow: "0 1px 4px rgba(0,0,0,0.5)", transition: "left 0.6s ease" }} />
      )}
    </div>
  );
}

/** Міні-графік лінією для плиток. */
export function Spark({ values, color, width = 80, height = 28 }: { values: number[]; color?: string; width?: number; height?: number }) {
  const id = useId();
  if (values.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, 2 + (1 - (v - min) / span) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const col = color ?? tone(values[values.length - 1]! - values[0]!);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: "block" }}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={col} stopOpacity={0.35} />
          <stop offset="1" stopColor={col} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${width} ${height} L0 ${height} Z`} fill={`url(#${id})`} />
      <path d={line} stroke={col} strokeWidth={1.5} fill="none" strokeLinejoin="round" />
    </svg>
  );
}

const fmtWhen = (ms: number, withDay: boolean) =>
  new Date(ms).toLocaleString("uk-UA", withDay ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });

/**
 * Інтерактивний графік ціни (площа): палець або курсор показує ціну, час і зміну від початку періоду.
 * Вертикальна прокрутка сторінки працює: графік ловить лише горизонтальні жести.
 */
export function PriceChart({ candles, live, height = 170, levels = [] }: { candles: Candle[]; live: number | null; height?: number; levels?: { price: number; color: string; label: string }[] }) {
  const id = useId();
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 360;
  const H = height;
  const PAD = { top: 16, bottom: 30, right: 4 };
  const closes = candles.map((k) => k.close);
  if (live !== null && closes.length) closes[closes.length - 1] = live;
  const lows = candles.map((k) => k.low);
  const highs = candles.map((k) => k.high);
  const all = [...lows, ...highs, ...closes, ...levels.map((l) => l.price)];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const y = (p: number) => PAD.top + ((max - p) / span) * (H - PAD.top - PAD.bottom);
  const x = (i: number) => (i / Math.max(1, closes.length - 1)) * (W - PAD.right);
  const first = closes[0] ?? 0;
  const lastV = closes[closes.length - 1] ?? 0;
  const col = lastV >= first ? c.up : c.down;
  const line = closes.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const hiIdx = highs.indexOf(Math.max(...highs));
  const loIdx = lows.indexOf(Math.min(...lows));
  const multiDay = candles.length > 1 && candles[candles.length - 1]!.closeTime - candles[0]!.openTime > 36 * 3_600_000;

  const pick = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || closes.length < 2) return;
    const rel = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setHover(Math.round(rel * (closes.length - 1)));
  };
  const h = hover !== null ? { i: hover, v: closes[hover]!, k: candles[hover]! } : null;
  const hx = h ? x(h.i) : 0;

  return (
    <div style={{ position: "relative" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", minHeight: 20, fontSize: 12, color: c.dim, gap: 8 }}>
        {h ? (
          <>
            <span style={{ ...num, color: c.ink, fontWeight: 600 }}>{fmtPrice(h.v)}</span>
            <Delta value={first ? ((h.v - first) / first) * 100 : null} size={12} />
            <span style={{ marginLeft: "auto" }}>{fmtWhen(h.k.closeTime, multiDay)}</span>
          </>
        ) : (
          <>
            <span>макс <span style={{ ...num, color: c.ink }}>{fmtPrice(max)}</span></span>
            <span>мін <span style={{ ...num, color: c.ink }}>{fmtPrice(min)}</span></span>
            <span style={{ marginLeft: "auto", color: c.faint }}>торкнись графіка</span>
          </>
        )}
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ display: "block", touchAction: "pan-y", cursor: "crosshair" }}
        role="img"
        aria-label={`Графік ціни: від ${fmtPrice(first)} до ${fmtPrice(lastV)}`}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerMove={(e) => (e.pointerType === "mouse" || e.buttons ? pick(e.clientX) : undefined)}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => e.pointerType !== "mouse" && setTimeout(() => setHover(null), 1600)}
      >
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={col} stopOpacity={0.32} />
            <stop offset="1" stopColor={col} stopOpacity={0} />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={PAD.top + f * (H - PAD.top - PAD.bottom)} y2={PAD.top + f * (H - PAD.top - PAD.bottom)} stroke={c.line} strokeDasharray="2 4" />
        ))}
        <line x1={0} x2={W} y1={y(first)} y2={y(first)} stroke={c.faint} strokeDasharray="1 3" />
        {levels.map((l) => (
          <g key={l.label}>
            <line x1={0} x2={W} y1={y(l.price)} y2={y(l.price)} stroke={l.color} strokeDasharray="5 4" strokeOpacity={0.8} />
            <text x={4} y={y(l.price) - 4} fill={l.color} fontSize={10}>{l.label}</text>
          </g>
        ))}
        <path d={`${line} L${x(closes.length - 1)} ${H - PAD.bottom} L0 ${H - PAD.bottom} Z`} fill={`url(#${id})`} />
        <path d={line} stroke={col} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        {!h && (
          <>
            <text x={Math.min(W - 40, Math.max(30, x(hiIdx)))} y={y(highs[hiIdx]!) - 4} fill={c.dim} fontSize={9} textAnchor="middle">▲ {fmtPrice(highs[hiIdx]!)}</text>
            <text x={Math.min(W - 40, Math.max(30, x(loIdx)))} y={y(lows[loIdx]!) + 11} fill={c.dim} fontSize={9} textAnchor="middle">▼ {fmtPrice(lows[loIdx]!)}</text>
          </>
        )}
        <circle cx={x(closes.length - 1)} cy={y(lastV)} r={6} fill={col} opacity={0.25} />
        <circle cx={x(closes.length - 1)} cy={y(lastV)} r={3.5} fill={col} stroke={c.card} strokeWidth={1.5} />
        {h && (
          <g>
            <line x1={hx} x2={hx} y1={PAD.top - 6} y2={H - PAD.bottom} stroke={c.ink} strokeOpacity={0.5} />
            <line x1={0} x2={W} y1={y(h.v)} y2={y(h.v)} stroke={c.ink} strokeOpacity={0.25} strokeDasharray="3 3" />
            <circle cx={hx} cy={y(h.v)} r={5} fill={col} stroke={c.ink} strokeWidth={2} />
          </g>
        )}
        <text x={0} y={H - 4} fill={c.faint} fontSize={10}>{candles[0] ? fmtWhen(candles[0].openTime, true) : ""}</text>
        <text x={W - PAD.right} y={H - 4} fill={c.faint} fontSize={10} textAnchor="end">зараз</text>
      </svg>
    </div>
  );
}

/** Рядок «назва — значення». */
export function Stat({ label, value, color, sub }: { label: string; value: ReactNode; color?: string; sub?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 11, color: c.faint, fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase" }}>{label}</span>
      <span style={{ ...num, fontSize: 17, fontWeight: 700, color: color ?? c.ink }}>{value}</span>
      {sub && <span style={{ fontSize: 11, color: c.dim }}>{sub}</span>}
    </div>
  );
}
