import { useEffect, useState } from "react";
import { fmtPrice } from "./live";
import { api, c, dim } from "./ui";

interface Candle { openTime: number; closeTime: number; open: number; high: number; low: number; close: number }

export interface ChartLevels {
  entryLow: number;
  entryHigh: number;
  stop: number;
  tp1: number;
  tp2: number | null;
  /** мс UTC */
  createdAt: number;
}

const W = 360;
const H = 220;
const PAD = { left: 4, right: 62, top: 10, bottom: 18 };

/** Свічки 1h із зоною входу, стопом і цілями. Малює SVG без бібліотек. */
export function SignalChart({ symbol, levels, live }: { symbol: string; levels: ChartLevels; live: number | null }) {
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ candles: Candle[] }>(`/api/candles/${symbol}?tf=1h&limit=72`).then((d) => setCandles(d.candles), (e) => setError(String(e)));
  }, [symbol]);

  if (error) return <p style={dim}>Графік недоступний: {error}</p>;
  if (!candles?.length) return <p style={dim}>Завантажую графік…</p>;

  const prices = [
    ...candles.flatMap((k) => [k.high, k.low]),
    levels.stop, levels.tp1, levels.entryLow, levels.entryHigh,
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
    { price: levels.stop, color: c.orange, label: `стоп ${fmtPrice(levels.stop)}` },
    { price: levels.tp1, color: c.blue, label: `ціль ${fmtPrice(levels.tp1)}` },
    ...(levels.tp2 !== null ? [{ price: levels.tp2, color: c.blue, label: `ціль 2 ${fmtPrice(levels.tp2)}`, dash: "4 3" }] : []),
    { price: mid, color: c.dim, label: `вхід ${fmtPrice(mid)}`, dash: "1 3" },
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

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Графік ${symbol} 1h з рівнями сигналу`} style={{ display: "block" }}>
      <rect x={PAD.left} width={plotW} y={y(levels.entryHigh)} height={Math.max(1, y(levels.entryLow) - y(levels.entryHigh))} fill={c.blue} opacity={0.15} />
      {candles.map((k, i) => {
        const up = k.close >= k.open;
        const color = up ? c.blue : c.orange;
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
      <text x={W - PAD.right} y={H - 4} fill={c.dim} fontSize={10} textAnchor="end">1h · {candles.length} свічок</text>
    </svg>
  );
}
