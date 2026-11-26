import type { ChannelConfig } from "../shared/bots";
import type { Fees, Side } from "../shared/risk";
import {
  advanceChannel,
  channelFeeR,
  channelFunding,
  channelR,
  channelSignal,
  channelStop,
  openTrack,
  stopReached,
  type ChannelExit,
  type FundingEvent,
} from "../worker/bots/channel";
import type { Candle } from "../worker/market/types";
import { bootstrapMeanCi, maxDrawdown } from "./report";

/**
 * Бектест Channel 20/10: ті самі сигнал, стоп, перерахунок стопа, вихід і фандинг, що й у рушії (src/worker/bots/channel.ts).
 * Рішення на закритті доби t бачить лише завершені свічки до t. Вхід — за Open доби t+1 з несприятливим проковзуванням
 * (рушій входить за Open першої свічки 15m після свого циклу о 00:03). Стоп перевіряється за свічками 1h; новий стоп після
 * закриття доби діє лише з наступної доби; геп за стопом — вихід за Open. Комісія taker на вході й виході, фандинг за
 * історичними ставками в моменти нарахування; нарахування в годину виходу — лише як витрата.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface ChannelBacktestConfig {
  cfg: Pick<ChannelConfig, "entryDays" | "exitDays">;
  fees: Fees;
  /** Несприятливе проковзування на кожному виконанні, %. */
  slippagePct: number;
}

export interface ChannelBtTrade {
  side: Side;
  signalDay: number;
  /** Ціна закриття доби сигналу й межі каналу. */
  close: number;
  upper: number;
  lower: number;
  filledAt: number;
  entry: number;
  initialStop: number;
  stop: number;
  exit: ChannelExit | null;
  exitPrice: number | null;
  resultR: number | null;
  feeR: number | null;
  fundingR: number | null;
  fundingAmbiguous: number;
  netR: number | null;
  /** Для позиції, відкритої на кінець даних: R за останнім закриттям. */
  openR: number | null;
}

export interface ChannelSignalStats {
  signals: number;
  entered: number;
  /** Сигнал за відкритої позиції. */
  ignored: number;
  /** Ціна на старті доби вже за стопом. */
  beyondStop: number;
  /** Сигнал на останній добі періоду: вхід припав би на добу після кінця. */
  periodEnd: number;
}

function firstIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(arr[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Угоди за сигналами на закриттях діб у [from, to). Позиції, відкриті до to, супроводжуються до кінця даних. */
export function simulateChannel(
  daily: Candle[],
  hourly: Candle[],
  funding: FundingEvent[],
  from: number,
  to: number,
  bt: ChannelBacktestConfig,
): { trades: ChannelBtTrade[]; stats: ChannelSignalStats } {
  const { entryDays, exitDays } = bt.cfg;
  const slip = bt.slippagePct / 100;
  const end = Math.max(hourly.length ? hourly[hourly.length - 1]!.closeTime + 1 : 0, daily.length ? daily[daily.length - 1]!.closeTime + 1 : 0);
  const hourOpen = new Map(hourly.map((c) => [c.openTime, c.open]));
  const priceAt = (at: number) => hourOpen.get(at) ?? daily[firstIndex(daily, (c) => c.closeTime >= at)]?.open ?? 0;
  const trades: ChannelBtTrade[] = [];
  const stats: ChannelSignalStats = { signals: 0, entered: 0, ignored: 0, beyondStop: 0, periodEnd: 0 };
  let busyUntil = -Infinity;
  for (let i = Math.max(entryDays, firstIndex(daily, (c) => c.openTime >= from)); i < daily.length && daily[i]!.openTime < to; i++) {
    const t = daily[i]!;
    const s = channelSignal(daily.slice(i - entryDays, i + 1), entryDays);
    if (!s?.side) continue;
    stats.signals++;
    // Позиція, що закрилась до закриття t, сигналу не заважає; відкрита на закритті — так.
    if (busyUntil >= t.closeTime) {
      stats.ignored++;
      continue;
    }
    const next = daily[i + 1];
    if (!next || next.openTime !== t.openTime + DAY || next.openTime >= to) {
      stats.periodEnd++;
      continue;
    }
    const side = s.side;
    const stop = channelStop(daily.slice(Math.max(0, i + 1 - exitDays), i + 1), side, exitDays);
    if (stop === null || stopReached(side, stop, next.open)) {
      stats.beyondStop++;
      continue;
    }
    stats.entered++;
    const entry = next.open * (side === "long" ? 1 + slip : 1 - slip);
    const track = openTrack(side, entry, stop, next.openTime, t.openTime);
    const adv = advanceChannel(track, daily, hourly, end, exitDays);
    const trade: ChannelBtTrade = {
      side, signalDay: t.openTime, close: s.close, upper: s.upper, lower: s.lower, filledAt: next.openTime, entry, initialStop: stop, stop: adv.track.stop,
      exit: adv.exit, exitPrice: null, resultR: null, feeR: null, fundingR: null, fundingAmbiguous: 0, netR: null, openR: null,
    };
    if (adv.exit) {
      const exitPrice = adv.exit.price * (side === "long" ? 1 - slip : 1 + slip);
      const f = channelFunding(adv.track, funding, next.openTime, adv.exit, end, priceAt);
      trade.exitPrice = exitPrice;
      trade.resultR = channelR(adv.track, exitPrice);
      trade.feeR = channelFeeR(adv.track, exitPrice, bt.fees);
      trade.fundingR = f.r;
      trade.fundingAmbiguous = f.ambiguous;
      trade.netR = Number((trade.resultR - trade.feeR + f.r).toFixed(4));
      busyUntil = adv.exit.to;
    } else {
      const last = hourly.length ? hourly[hourly.length - 1]!.close : daily[daily.length - 1]!.close;
      trade.openR = channelR(adv.track, last);
      busyUntil = Infinity;
    }
    trades.push(trade);
  }
  return { trades, stats };
}

export interface ChannelSummary {
  trades: number;
  perDay: number;
  wins: number;
  winRate: number | null;
  avgR: number | null;
  avgRCi: [number, number] | null;
  totalR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  maxLossStreak: number;
  avgWinR: number | null;
  avgLossR: number | null;
  /** Середня тривалість угоди, діб. */
  avgHoldDays: number | null;
  avgFeeR: number | null;
  avgFundingR: number | null;
  gaps: number;
}

const r3 = (v: number) => Number(v.toFixed(3));

export function channelSummary(trades: ChannelBtTrade[], days: number): ChannelSummary {
  const closed = trades.filter((t) => t.netR !== null).sort((a, b) => a.exit!.to - b.exit!.to);
  const rs = closed.map((t) => t.netR!);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const total = rs.reduce((s, r) => s + r, 0);
  let streak = 0;
  let maxStreak = 0;
  for (const r of rs) {
    streak = r < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const avg = (xs: number[]) => (xs.length ? r3(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
  return {
    trades: rs.length,
    perDay: Number((rs.length / Math.max(1, days)).toFixed(3)),
    wins: wins.length,
    winRate: rs.length ? r3(wins.length / rs.length) : null,
    avgR: avg(rs),
    avgRCi: bootstrapMeanCi(rs),
    totalR: Number(total.toFixed(2)),
    profitFactor: losses.length ? Number((wins.reduce((s, r) => s + r, 0) / -losses.reduce((s, r) => s + r, 0)).toFixed(2)) : null,
    maxDrawdownR: maxDrawdown(rs),
    maxLossStreak: maxStreak,
    avgWinR: avg(wins),
    avgLossR: avg(losses),
    avgHoldDays: closed.length ? Number((closed.reduce((s, t) => s + (t.exit!.to - t.filledAt), 0) / closed.length / DAY).toFixed(1)) : null,
    avgFeeR: avg(closed.map((t) => t.feeR!)),
    avgFundingR: avg(closed.map((t) => t.fundingR!)),
    gaps: closed.filter((t) => t.exit!.gap).length,
  };
}

const fmtR = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(3)}R`);
const fmtPct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

export function formatChannelLine(name: string, s: ChannelSummary): string {
  const ci = s.avgRCi ? ` [${s.avgRCi[0]} … ${s.avgRCi[1]}]` : "";
  return `  ${name.padEnd(24)} угод ${String(s.trades).padStart(4)} · у плюсі ${fmtPct(s.winRate).padStart(4)} · середнє ${fmtR(s.avgR)}${ci} · разом ${s.totalR.toFixed(1)}R · PF ${s.profitFactor ?? "—"} · просадка ${s.maxDrawdownR}R · серія збитків ${s.maxLossStreak}`;
}

export function channelTradesCsv(trades: ChannelBtTrade[]): string {
  const iso = (t: number | null | undefined) => (t === null || t === undefined ? "" : new Date(t).toISOString());
  const head = "signal_day,side,close,upper,lower,filled_at,entry,initial_stop,final_stop,exit_from,exit_to,exit_price,gap,result_r,fee_r,funding_r,net_r,open_r";
  return (
    [
      head,
      ...trades.map((t) =>
        [
          iso(t.signalDay).slice(0, 10), t.side, t.close, t.upper, t.lower, iso(t.filledAt), t.entry.toFixed(2), t.initialStop, t.stop, iso(t.exit?.from), iso(t.exit?.to),
          t.exitPrice?.toFixed(2) ?? "", t.exit ? (t.exit.gap ? 1 : 0) : "", t.resultR ?? "", t.feeR ?? "", t.fundingR ?? "", t.netR ?? "", t.openR ?? "",
        ].join(","),
      ),
    ].join("\n") + "\n"
  );
}
