/**
 * Бектест бота Channel 20/10 на історичних свічках. Локально, не на Cloudflare:
 *   npm run backtest:channel
 *   npm run backtest:channel -- --from 2020-01 --to 2026-10 --test-from 2025-11
 *
 * Свічки 1d і 1h та ставки фандингу BTCUSDT perp з публічного архіву data.binance.vision (кеш у .backtest/cache).
 * Рушій бере дані Bybit; для BTCUSDT свічки двох бірж майже однакові, а архів Bybit без API недоступний.
 * Результат — у R після комісій, проковзування й фандингу: без прив'язки до розміру депозиту.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CHANNEL_DEFAULTS } from "../src/shared/bots";
import { channelSummary, channelTradesCsv, formatChannelLine, simulateChannel, type ChannelBacktestConfig, type ChannelBtTrade } from "../src/backtest/channel";
import { months, shiftMonth } from "../src/backtest/data";
import { loadSymbols, ROOT } from "../src/backtest/load";
import { fundingMonth } from "../src/research/load";
import { mergeByTime } from "../src/research/data";

const HELP = `Бектест Channel 20/10: денний пробій каналу, стоп за коротшим каналом, без тейка, одна позиція.

  npm run backtest:channel -- [параметри]

  --symbol S         контракт (${CHANNEL_DEFAULTS.symbol})
  --from YYYY-MM     перший місяць сигналів (2020-01; попередні свічки — розігрів каналів)
  --to YYYY-MM       останній місяць (попередній повний місяць)
  --test-from YYYY-MM початок тестового періоду (останні 12 повних місяців); параметри за ним не підбираються
  --entry N          канал входу, діб (${CHANNEL_DEFAULTS.entryDays})
  --exit N           канал стопа, діб (${CHANNEL_DEFAULTS.exitDays})
  --taker N          комісія taker, % за сторону (0.055, Bybit)
  --slippage N       несприятливе проковзування, % за сторону (0.05; окремо показується подвійне)
  --out DIR          куди писати звіт (.backtest/out/channel_<from>_<to>)
`;

const num = (v: string | undefined, fallback: number) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`не число: ${v}`);
  return n;
};
const monthStart = (m: string) => Date.parse(`${m}-01T00:00:00Z`);
const DAY = 86_400_000;

async function main() {
  const { values } = parseArgs({
    options: {
      symbol: { type: "string" }, from: { type: "string" }, to: { type: "string" }, "test-from": { type: "string" }, entry: { type: "string" }, exit: { type: "string" },
      taker: { type: "string" }, slippage: { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  const symbol = (values.symbol ?? CHANNEL_DEFAULTS.symbol).toUpperCase();
  const to = values.to ?? shiftMonth(new Date().toISOString().slice(0, 7), -1);
  const from = values.from ?? "2020-01";
  const testFrom = values["test-from"] ?? shiftMonth(to, -11);
  if (![from, to, testFrom].every((m) => /^\d{4}-\d{2}$/.test(m)) || from > to || testFrom < from || testFrom > to) throw new Error("--from, --to, --test-from у форматі YYYY-MM, from ≤ test-from ≤ to");
  const cfg = { entryDays: num(values.entry, CHANNEL_DEFAULTS.entryDays), exitDays: num(values.exit, CHANNEL_DEFAULTS.exitDays) };
  const fees = { makerPct: 0.02, takerPct: num(values.taker, 0.055) };
  const slippagePct = num(values.slippage, 0.05);

  const log = (l: string) => process.stderr.write(l + "\n");
  // Місяць розігріву: канал входу бере 20 попередніх діб.
  const [data] = await loadSymbols([symbol], shiftMonth(from, -1), to, log, ["1h", "1d"]);
  if (!data) throw new Error(`${symbol}: немає свічок в архіві`);
  const fundingParts = [];
  for (const m of months(shiftMonth(from, -1), to)) fundingParts.push(await fundingMonth(symbol, m));
  const funding = mergeByTime(fundingParts).map((f) => ({ at: f.at, rate: f.rate }));
  const end = monthStart(shiftMonth(to, 1));
  const daily = data["1d"].filter((c) => c.openTime < end);
  const hourly = data["1h"].filter((c) => c.openTime < end);
  const start = monthStart(from);
  const split = monthStart(testFrom);

  // Перевірка даних: пропуски денних і годинних свічок, фандинг.
  const gaps = (xs: { openTime: number }[], step: number) => xs.slice(1).filter((c, i) => c.openTime - xs[i]!.openTime !== step).length;
  const lines: string[] = [];
  const out = (s = "") => {
    console.log(s);
    lines.push(s);
  };
  out(`Channel 20/10 · ${symbol} · бектест ${from} — ${to} · тест з ${testFrom}`);
  out(`Канал входу ${cfg.entryDays} діб, стоп ${cfg.exitDays} діб · taker ${fees.takerPct}% · проковзування ${slippagePct}% за сторону · фандинг Binance`);
  out(`Дані: ${daily.length} денних свічок (пропусків ${gaps(daily, DAY)}), ${hourly.length} годинних (пропусків ${gaps(hourly, 3_600_000)}), ${funding.length} нарахувань фандингу`);
  out("");

  const run = (slip: number, f: number, t: number) => simulateChannel(daily, hourly, funding, f, t, { cfg, fees, slippagePct: slip } satisfies ChannelBacktestConfig);
  const days = (f: number, t: number) => (t - f) / DAY;
  const block = (title: string, f: number, t: number) => {
    const base = run(slippagePct, f, t);
    const dbl = run(slippagePct * 2, f, t);
    const s = channelSummary(base.trades, days(f, t));
    const s2 = channelSummary(dbl.trades, days(f, t));
    const side = (x: "long" | "short") => channelSummary(base.trades.filter((tr) => tr.side === x), days(f, t));
    out(`== ${title}: ${new Date(f).toISOString().slice(0, 10)} — ${new Date(t - 1).toISOString().slice(0, 10)} ==`);
    out(formatChannelLine("Усі", s));
    out(formatChannelLine("Лонг", side("long")));
    out(formatChannelLine("Шорт", side("short")));
    out(formatChannelLine(`Проковзування ×2 (${slippagePct * 2}%)`, s2));
    out(`  угод на добу ${s.perDay} · середня тривалість ${s.avgHoldDays ?? "—"} діб · середній прибуток ${s.avgWinR ?? "—"}R, збиток ${s.avgLossR ?? "—"}R · комісії ${s.avgFeeR ?? "—"}R, фандинг ${s.avgFundingR ?? "—"}R на угоду · вихід через геп ${s.gaps}`);
    const st = base.stats;
    out(`  сигналів ${st.signals} · входів ${st.entered} · за відкритої позиції ${st.ignored} · ціна вже за стопом ${st.beyondStop} · на кінці періоду ${st.periodEnd}`);
    const open = base.trades.find((tr) => tr.netR === null);
    if (open) out(`  відкрита на кінець даних: ${open.side} з ${new Date(open.filledAt).toISOString().slice(0, 10)} за ${open.entry.toFixed(1)}, стоп ${open.stop}, зараз ${open.openR}R`);
    const first = daily.find((c) => c.openTime >= f);
    const last = [...daily].reverse().find((c) => c.openTime < t);
    if (first && last) out(`  для порівняння: ${symbol} за період ${(((last.close - first.open) / first.open) * 100).toFixed(1)}%`);
    out("");
    return { title, summary: s, long: side("long"), short: side("short"), doubleSlippage: s2, stats: st, trades: base.trades };
  };
  const full = block("Увесь період", start, end);
  const train = block("Навчання", start, split);
  const test = block("Тест (останні 12 повних місяців)", split, end);
  const byYear: Record<string, ReturnType<typeof channelSummary>> = {};
  for (const y of [...new Set(full.trades.map((t) => new Date(t.filledAt).getUTCFullYear()))]) {
    const ts: ChannelBtTrade[] = full.trades.filter((t) => new Date(t.filledAt).getUTCFullYear() === y);
    byYear[y] = channelSummary(ts, 365);
  }
  out("Роки:");
  for (const [y, s] of Object.entries(byYear)) out(formatChannelLine(y, s));

  const dir = values.out ?? join(ROOT, "out", `channel_${from}_${to}`);
  await mkdir(dir, { recursive: true });
  const strip = (b: ReturnType<typeof block>) => ({ ...b, trades: undefined });
  await Promise.all([
    writeFile(join(dir, "report.txt"), lines.join("\n") + "\n"),
    writeFile(join(dir, "report.json"), JSON.stringify({ symbol, from, to, testFrom, cfg, fees, slippagePct, full: strip(full), train: strip(train), test: strip(test), byYear }, null, 2)),
    writeFile(join(dir, "trades.csv"), channelTradesCsv(full.trades)),
  ]);
  console.log(`\nЗвіт і угоди: ${dir}`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? (e.stack ?? e.message) : e));
  process.exit(1);
});
