import { useEffect, useRef, useState } from "react";
import { fmtPrice } from "./live";
import { api, c, dim, num } from "./ui";

interface Candle { openTime: number; closeTime: number; open: number; high: number; low: number; close: number }

export interface ChartLevels {
  entryLow: number;
  entryHigh: number;
  stop: number;
  /** Ціль старих сетапів на 1h; null для трендового пробою, який веде вихід за каналом 4h. */
  tp1: number | null;
  tp2: number | null;
  /** мс UTC */
  createdAt: number;
}

const W = 360;
const H = 220;
const PAD = { left: 4, right: 62, top: 10, bottom: 18 };

/**
 * Свічки з входом, стопом і цілями. Малює SVG без бібліотек.
 * Трендовий пробій (без цілі) показується на 4h за ~10 днів, старі сетапи на 1h за 3 дні.
 */
export function SignalChart({ symbol, levels, live }: { symbol: string; levels: ChartLevels; live: number | null }) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const tf = levels.tp1 === null ? "4h" : "1h";
  useEffect(() => {
    api<{ candles: Candle[] }>(`/api/candles/${symbol}?tf=${tf}&limit=${tf === "4h" ? 60 : 72}`).then((d) => setCandles(d.candles), (e) => setError(String(e)));
  }, [symbol, tf]);

  if (error) return <p style={dim}>Графік недоступний: {error}</p>;
  if (!candles?.length) return <div className="skeleton" style={{ height: 220 }} aria-label="Завантажую графік" />;

  const prices = [
    ...candles.flatMap((k) => [k.high, k.low]),
    levels.stop, levels.entryLow, levels.entryHigh,
    ...(levels.tp1 !== null ? [levels.tp1] : []),
    ...(levels.tp2 !== null ? [levels.tp2] : []),
    ...(live !== null ? [live] : []),
  ];
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const span = max - min || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const y = (p: number) => PAD.top + ((max - p) / span) * plotH;
  const step = plotW / candles.length;
  const x = (i: number) => PAD.left + i * step + step / 2;
  const t0 = candles[0]!.openTime;
  const t1 = candles[candles.length - 1]!.closeTime;
  const createdX = levels.createdAt >= t0 && levels.createdAt <= t1 ? PAD.left + ((levels.createdAt - t0) / (t1 - t0)) * plotW : null;

  // Підписи рівнів праворуч розсуваються, щоб не налазили один на одного.
  const mid = (levels.entryLow + levels.entryHigh) / 2;
  const marks = [
    { price: levels.stop, color: c.down, label: `стоп ${fmtPrice(levels.stop)}` },
    ...(levels.tp1 !== null ? [{ price: levels.tp1, color: c.up, label: `ціль ${fmtPrice(levels.tp1)}` }] : []),
    ...(levels.tp2 !== null ? [{ price: levels.tp2, color: c.up, label: `ціль 2 ${fmtPrice(levels.tp2)}`, dash: "4 3" }] : []),
    { price: mid, color: c.blue, label: `вхід ${fmtPrice(mid)}`, dash: "1 3" },
    ...(live !== null ? [{ price: live, color: c.ink, label: fmtPrice(live), dash: "3 2" }] : []),
  ]
    .map((m) => ({ ...m, ly: y(m.price) }))
    .sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < marks.length; i++) marks[i]!.ly = Math.max(marks[i]!.ly, marks[i - 1]!.ly + 11);
  const overflow = marks.length ? marks[marks.length - 1]!.ly - (H - PAD.bottom) : 0;
  if (overflow > 0) for (const m of marks) m.ly -= overflow;

  const line = (m: (typeof marks)[number]) => (
    <g key={m.label}>
      <line x1={PAD.left} x2={W - PAD.right} y1={y(m.price)} y2={y(m.price)} stroke={m.color} strokeWidth={1} strokeDasharray={"dash" in m ? m.dash : undefined} />
      <text x={W - PAD.right + 4} y={m.ly + 3.5} fill={m.color} fontSize={10}>{m.label}</text>
    </g>
  );

  // Зони ризику й прибутку: від входу до стопа червоним, від входу в бік угоди зеленим.
  const long = levels.stop < mid;
  const riskTop = Math.min(y(mid), y(levels.stop));
  const rewardEdge = long ? PAD.top : H - PAD.bottom;
  const zoneX = createdX ?? PAD.left;
  const pick = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((clientX - rect.left) / rect.width) * W;
    setHover(Math.min(candles.length - 1, Math.max(0, Math.floor((px - PAD.left) / step))));
  };
  const hk = hover !== null ? candles[hover]! : null;

  return (
    <div>
      <div style={{ ...num, minHeight: 18, fontSize: 11, color: c.dim, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {hk ? (
          <>
            <span style={{ color: c.ink }}>{new Date(hk.openTime).toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
            <span>В {fmtPrice(hk.open)}</span>
            <span>М {fmtPrice(hk.high)}</span>
            <span>Н {fmtPrice(hk.low)}</span>
            <span style={{ color: hk.close >= hk.open ? c.up : c.down }}>З {fmtPrice(hk.close)}</span>
          </>
        ) : (
          <span>Торкнись свічки, щоб побачити ціни</span>
        )}
      </div>
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label={`Графік ${symbol} ${tf} з рівнями сигналу`}
      style={{ display: "block", touchAction: "pan-y" }}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerMove={(e) => (e.pointerType === "mouse" || e.buttons ? pick(e.clientX) : undefined)}
      onPointerLeave={() => setHover(null)}
    >
      <rect x={zoneX} width={Math.max(0, PAD.left + plotW - zoneX)} y={riskTop} height={Math.abs(y(levels.stop) - y(mid))} fill={c.down} opacity={0.1} />
      <rect x={zoneX} width={Math.max(0, PAD.left + plotW - zoneX)} y={Math.min(rewardEdge, y(mid))} height={Math.abs(y(mid) - rewardEdge)} fill={c.up} opacity={0.07} />
      <rect x={PAD.left} width={plotW} y={y(levels.entryHigh)} height={Math.max(1, y(levels.entryLow) - y(levels.entryHigh))} fill={c.blue} opacity={0.15} />
      {candles.map((k, i) => {
        const up = k.close >= k.open;
        const color = up ? c.up : c.down;
        const top = y(Math.max(k.open, k.close));
        return (
          <g key={k.openTime}>
            <line x1={x(i)} x2={x(i)} y1={y(k.high)} y2={y(k.low)} stroke={color} strokeWidth={1} />
            <rect x={x(i) - step * 0.35} width={step * 0.7} y={top} height={Math.max(0.8, y(Math.min(k.open, k.close)) - top)} fill={color} />
          </g>
        );
      })}
      {createdX !== null && <line x1={createdX} x2={createdX} y1={PAD.top} y2={H - PAD.bottom} stroke={c.dim} strokeDasharray="2 3" />}
      {marks.map(line)}
      <text x={PAD.left} y={H - 4} fill={c.dim} fontSize={10}>{new Date(t0).toLocaleDateString("uk-UA", { day: "numeric", month: "short" })}</text>
      <text x={W - PAD.right} y={H - 4} fill={c.dim} fontSize={10} textAnchor="end">{tf} · {candles.length} свічок</text>
      {hk && hover !== null && (
        <g pointerEvents="none">
          <rect x={x(hover) - step / 2} width={step} y={PAD.top} height={plotH} fill={c.ink} opacity={0.08} />
          <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke={c.ink} strokeOpacity={0.5} strokeDasharray="2 2" />
        </g>
      )}
    </svg>
    </div>
  );
}
