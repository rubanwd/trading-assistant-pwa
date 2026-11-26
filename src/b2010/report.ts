/** Підсумок бектесту: окремо ціновий результат, прослизання, комісії й фандинг — без подвійного списання. */
import { dec, dsum, ZERO, type Dec } from "./decimal";
import type { BacktestResult, BtTrade } from "./backtest";
import { isoDay } from "./strategy";

export interface SideStats {
  trades: number;
  wins: number;
  net: Dec;
}

export interface Summary {
  from: string;
  to: string;
  start: Dec;
  end: Dec;
  pnl: Dec;
  pnlPct: Dec;
  /** Складники pnl: price − slippage − fees + funding + (нереалізоване в price/slippage/fees). */
  price: Dec;
  slippage: Dec;
  fees: Dec;
  funding: Dec;
  fundingPaid: Dec;
  fundingReceived: Dec;
  ambiguousFunding: number;
  ambiguousSkipped: Dec;
  /** Нарахування, для яких не було ціни маркування: оцінено за торговою ціною. */
  markFallback: number;
  hourlyMissingDays: number;
  maxDrawdown: Dec;
  maxDrawdownPct: Dec;
  drawdownPeak: string | null;
  drawdownTrough: string | null;
  trades: number;
  wins: number;
  winRate: Dec;
  avgWin: Dec;
  avgLoss: Dec;
  avgR: Dec;
  maxLossStreak: number;
  long: SideStats;
  short: SideStats;
  signals: number;
  entered: number;
  skipped: Record<string, number>;
  open: { side: string; qty: Dec; entry: Dec; stop: Dec; lastClose: Dec; unrealized: Dec; since: string } | null;
  spot: { end: Dec; pnl: Dec; pnlPct: Dec; source: string } | null;
  warnings: string[];
}

const pct = (a: Dec, b: Dec) => (b.isZero() ? ZERO : a.div(b).mul(100));

export function summarize(r: BacktestResult): Summary {
  const closed = r.trades.filter((t) => t.exitTime !== null);
  const start = r.config.balance;
  const end = r.equity.length ? r.equity[r.equity.length - 1].equity : start;
  const open = r.open;
  const openPrice = open ? open.qty.mul(open.lastClose.sub(open.entryBase)).mul(open.side === "long" ? 1 : -1) : ZERO;
  const price = dsum(closed.map((t) => t.priceResult)).add(openPrice);
  const slippage = dsum(r.trades.map((t) => t.slippage));
  const fees = dsum(r.trades.map((t) => t.entryFee.add(t.exitFee)));
  const applied = r.funding.filter((f) => f.applied);
  const funding = dsum(applied.map((f) => f.amount));
  const fundingPaid = dsum(applied.filter((f) => f.amount.lt(0)).map((f) => f.amount.neg()));
  const fundingReceived = dsum(applied.filter((f) => f.amount.gt(0)).map((f) => f.amount));
  const ambiguous = r.funding.filter((f) => f.ambiguous);

  let peak = start;
  let peakDay: number | null = null;
  let maxDd = ZERO;
  let maxDdPct = ZERO;
  let ddPeak: number | null = null;
  let ddTrough: number | null = null;
  for (const p of r.equity) {
    if (p.equity.gt(peak)) {
      peak = p.equity;
      peakDay = p.day;
    }
    const dd = peak.sub(p.equity);
    if (dd.gt(maxDd)) {
      maxDd = dd;
      maxDdPct = pct(dd, peak);
      ddPeak = peakDay;
      ddTrough = p.day;
    }
  }

  const wins = closed.filter((t) => t.net.gt(0));
  const losses = closed.filter((t) => t.net.lt(0));
  let streak = 0;
  let maxStreak = 0;
  for (const t of closed) {
    streak = t.net.lt(0) ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const sideStats = (side: string): SideStats => {
    const ts = closed.filter((t) => t.side === side);
    return { trades: ts.length, wins: ts.filter((t) => t.net.gt(0)).length, net: dsum(ts.map((t) => t.net)) };
  };
  const skipped: Record<string, number> = {};
  for (const s of r.signals) if (s.status !== "entered") skipped[s.reason ?? "unknown"] = (skipped[s.reason ?? "unknown"] ?? 0) + 1;
  const avg = (xs: Dec[]) => (xs.length ? dsum(xs).div(xs.length) : ZERO);

  return {
    from: isoDay(r.config.from),
    to: isoDay(r.config.to),
    start,
    end,
    pnl: end.sub(start),
    pnlPct: pct(end.sub(start), start),
    price,
    slippage,
    fees,
    funding,
    fundingPaid,
    fundingReceived,
    ambiguousFunding: ambiguous.length,
    ambiguousSkipped: dsum(ambiguous.filter((f) => !f.applied).map((f) => f.amount)),
    markFallback: r.funding.filter((f) => f.markSource !== "mark").length,
    hourlyMissingDays: r.hourlyMissingDays.length,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    drawdownPeak: ddPeak === null ? (maxDd.gt(0) ? "старт" : null) : isoDay(ddPeak),
    drawdownTrough: ddTrough === null ? null : isoDay(ddTrough),
    trades: closed.length,
    wins: wins.length,
    winRate: closed.length ? dec(wins.length).div(closed.length).mul(100) : ZERO,
    avgWin: avg(wins.map((t) => t.net)),
    avgLoss: avg(losses.map((t) => t.net)),
    avgR: avg(closed.map((t) => (t.plannedRisk.isZero() ? ZERO : t.net.div(t.plannedRisk)))),
    maxLossStreak: maxStreak,
    long: sideStats("long"),
    short: sideStats("short"),
    signals: r.signals.length,
    entered: r.signals.filter((s) => s.status === "entered").length,
    skipped,
    open: open
      ? { side: open.side, qty: open.qty, entry: open.entryPrice, stop: open.stop, lastClose: open.lastClose, unrealized: open.unrealized, since: isoDay(open.entryTime) }
      : null,
    spot: r.spot ? { end: r.spot.end, pnl: r.spot.end.sub(start), pnlPct: pct(r.spot.end.sub(start), start), source: r.spot.source } : null,
    warnings: r.warnings,
  };
}

export const SKIP_LABELS: Record<string, string> = {
  qty_below_min: "кількість після округлення вниз менша за minOrderQty/qtyStep",
  notional_below_min: "номінал менший за minNotionalValue",
  no_margin: "немає маржі",
  invalid_stop: "стоп не з того боку від входу",
  price_beyond_stop: "ціна на старті доби вже за стопом",
  position_open: "відкрита позиція (сигнал проігноровано)",
  period_end: "сигнал на останній добі тесту",
  expired: "вікно входу минуло",
  instrument_not_trading: "контракт не торгується",
  blocked: "входи заблоковано до звірки",
  order_rejected: "біржа відхилила ордер",
  not_filled: "ордер не виконано",
  preflight: "перевірка акаунта не пройдена",
  insufficient_history: "замало денних свічок",
};

const usd = (x: Dec) => `${x.gte(0) ? "" : "−"}${x.abs().toFixed(2)}`;
const p2 = (x: Dec) => `${x.gte(0) ? "+" : "−"}${x.abs().toFixed(2)}%`;

export function formatSummary(title: string, s: Summary): string {
  const L: string[] = [];
  L.push(`== ${title}: ${s.from} — ${s.to} ==`);
  L.push(`Капітал: ${usd(s.start)} → ${usd(s.end)} USDT, результат ${usd(s.pnl)} USDT (${p2(s.pnlPct)})`);
  L.push(
    `  складники: ціновий ${usd(s.price)} − прослизання ${usd(s.slippage)} − комісії ${usd(s.fees)} + фандинг ${usd(s.funding)} = ${usd(s.price.sub(s.slippage).sub(s.fees).add(s.funding))}`,
  );
  L.push(`  фандинг: сплачено ${usd(s.fundingPaid)}, отримано ${usd(s.fundingReceived)}`);
  if (s.ambiguousFunding)
    L.push(`  неоднозначних нарахувань (стоп і фандинг в одній годині): ${s.ambiguousFunding}; консервативно не враховано доходу ${usd(s.ambiguousSkipped)} USDT`);
  if (s.markFallback) L.push(`  нарахувань без ціни маркування (оцінено за торговою ціною): ${s.markFallback}`);
  if (s.hourlyMissingDays) L.push(`  діб зі стопом без годинних свічок: ${s.hourlyMissingDays} (фандинг цих діб — консервативно)`);
  L.push(
    `Макс. просадка за денною equity: ${usd(s.maxDrawdown)} USDT (${s.maxDrawdownPct.toFixed(2)}%)${s.drawdownTrough ? `, ${s.drawdownPeak} → ${s.drawdownTrough}` : ""}`,
  );
  L.push(
    `Угод закрито: ${s.trades}, прибуткових ${s.wins} (${s.winRate.toFixed(1)}%), середній прибуток ${usd(s.avgWin)}, середній збиток ${usd(s.avgLoss)} USDT, середнє ${s.avgR.toFixed(2)}R, найдовша серія збитків ${s.maxLossStreak}`,
  );
  L.push(`  лонг: ${s.long.trades} угод, ${s.long.wins} у плюсі, разом ${usd(s.long.net)} USDT`);
  L.push(`  шорт: ${s.short.trades} угод, ${s.short.wins} у плюсі, разом ${usd(s.short.net)} USDT`);
  L.push(`Сигналів: ${s.signals}, виконано входів: ${s.entered}`);
  for (const [reason, n] of Object.entries(s.skipped).sort((a, b) => b[1] - a[1])) L.push(`  пропуск «${SKIP_LABELS[reason] ?? reason}» (${reason}): ${n}`);
  if (s.spot)
    L.push(`Купівля BTC на споті на ${usd(s.start)} USDT: ${usd(s.spot.end)} USDT (${p2(s.spot.pnlPct)})${s.spot.source === "perp" ? " — за цінами perp" : ""}`);
  if (s.open)
    L.push(
      `Відкрита позиція на кінець: ${s.open.side} ${s.open.qty} BTC з ${s.open.since} за ${s.open.entry.toFixed(1)}, стоп ${s.open.stop}, Close ${s.open.lastClose}, нереалізовано ${usd(s.open.unrealized)} USDT (без комісії виходу)`,
    );
  else L.push("Відкритої позиції на кінець немає.");
  for (const w of s.warnings) L.push(`Увага: ${w}`);
  return L.join("\n");
}

const iso = (ts: number | null) => (ts === null ? "" : new Date(ts).toISOString());

export function tradesCsv(trades: BtTrade[]): string {
  const head = "id,side,signal_day,entry_time,entry_base,entry_price,qty,initial_stop,final_stop,exit_time,exit_base,exit_price,exit_reason,price_result,slippage,entry_fee,exit_fee,funding,net,planned_risk,r";
  const rows = trades.map((t) =>
    [
      t.id,
      t.side,
      isoDay(t.signalDay),
      iso(t.entryTime),
      t.entryBase,
      t.entryPrice.toFixed(4),
      t.qty,
      t.initialStop,
      t.stop,
      iso(t.exitTime),
      t.exitBase ?? "",
      t.exitPrice?.toFixed(4) ?? "",
      t.exitReason ?? "open",
      t.priceResult.toFixed(4),
      t.slippage.toFixed(4),
      t.entryFee.toFixed(4),
      t.exitFee.toFixed(4),
      t.funding.toFixed(4),
      t.exitTime === null ? "" : t.net.toFixed(4),
      t.plannedRisk.toFixed(4),
      t.exitTime === null || t.plannedRisk.isZero() ? "" : t.net.div(t.plannedRisk).toFixed(3),
    ].join(","),
  );
  return [head, ...rows].join("\n") + "\n";
}

export function signalsCsv(r: BacktestResult): string {
  const head = "day,side,close,upper20,lower20,status,reason,message";
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [head, ...r.signals.map((s) => [isoDay(s.day), s.side, s.close, s.upper, s.lower, s.status, s.reason ?? "", esc(s.message ?? "")].join(","))].join("\n") + "\n";
}

export const equityCsv = (r: BacktestResult) => ["day,equity", ...r.equity.map((p) => `${isoDay(p.day)},${p.equity.toFixed(4)}`)].join("\n") + "\n";
