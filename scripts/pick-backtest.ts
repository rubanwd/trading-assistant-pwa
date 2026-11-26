/**
 * Бектест ідеї скану без моделі на історичних свічках Binance. Локально, не на Cloudflare:
 *   npm run backtest:pick                                   # 2023-11 — попередній місяць, обидва стилі
 *   npm run backtest:pick -- --from 2025-11 --to 2026-10 --horizon 12
 *
 * Щопів години знімки з закритих свічок (фандингу й відкритого інтересу в історії немає), той самий `rankPicks`
 * і `resolvePick`, що в рушії; береться найкращий за балом варіант із входом за ринком. Модель не викликається.
 * Знімки рахуються один раз на крок для обох стилів; повний період — кілька хвилин.
 */
import { parseArgs } from "node:util";
import { shiftMonth } from "../src/backtest/data";
import { loadSymbols, WATCHLIST } from "../src/backtest/load";
import { pickByMonth, pickSnapshots, pickSummary, simulatePicks, type PickBacktestConfig, type PickSummary } from "../src/backtest/pick";
import { PICK_STYLES } from "../src/worker/pick";

const HELP = `Бектест ідеї скану без моделі: стилі short і swing поруч.

  npm run backtest:pick -- [параметри]

  --from YYYY-MM     перший місяць (2023-11)
  --to YYYY-MM       останній місяць (попередній повний місяць)
  --split YYYY-MM    перший місяць тестового періоду (2025-07)
  --symbols A,B      монети (стартовий список із 15)
  --horizon N        горизонт ідеї, год (24)
  --min-stop N       стоп не ближче, % (1)
  --maker N          комісія maker, % (0.02)
  --taker N          комісія taker, % (0.05)
  --months           підсумок за кожен місяць
`;

const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v));

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string" }, to: { type: "string" }, split: { type: "string" }, symbols: { type: "string" }, horizon: { type: "string" },
      "min-stop": { type: "string" }, maker: { type: "string" }, taker: { type: "string" }, months: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  const to = values.to ?? shiftMonth(new Date().toISOString().slice(0, 7), -1);
  const from = values.from ?? "2023-11";
  const split = Date.parse(`${values.split ?? "2025-07"}-01T00:00:00Z`);
  const symbols = values.symbols ? values.symbols.split(",").map((s) => s.trim().toUpperCase()) : WATCHLIST;
  const data = await loadSymbols(symbols, from, to, (line) => process.stderr.write(line + "\n"));

  const start = Date.parse(`${from}-01T00:00:00Z`);
  const end = Date.parse(`${shiftMonth(to, 1)}-01T00:00:00Z`) - 3_600_000;
  const base = {
    from: start, to: end, stepMinutes: 30, leader: "BTCUSDT",
    horizonHours: num(values.horizon, 24), minStopPct: num(values["min-stop"], 1), makerPct: num(values.maker, 0.02), takerPct: num(values.taker, 0.05),
  };
  const configs: PickBacktestConfig[] = PICK_STYLES.map((style) => ({ ...base, style }));
  process.stderr.write(`Симуляція: ${data.length} монет, ${from} — ${to}, крок 30 хв\n`);
  const t0 = Date.now();
  const results = simulatePicks(pickSnapshots(data, start, end, 30), new Map(data.map((d) => [d.symbol, d["1h"]])), configs);
  process.stderr.write(`  готово за ${((Date.now() - t0) / 1000).toFixed(0)} с\n\n`);

  const line = (s: PickSummary) =>
    `${String(s.closed).padStart(6)} ідей · підтвердились ${((s.winRate ?? 0) * 100).toFixed(0)}% · середнє ${fmt(s.avgR)}R · разом ${s.totalR}R · просадка ${s.maxDrawdownR}R · лонги ${s.longs} (${fmt(s.longAvgR)}R) · шорти ${s.shorts} (${fmt(s.shortAvgR)}R)`;
  for (const [i, style] of PICK_STYLES.entries()) {
    const tr = results[i]!;
    console.log(`Стиль ${style}`);
    console.log(`  усе     ${line(pickSummary(tr))}`);
    console.log(`  навч.   ${line(pickSummary(tr.filter((x) => x.createdAt < split)))}`);
    console.log(`  тест    ${line(pickSummary(tr.filter((x) => x.createdAt >= split)))}`);
    console.log();
  }
  if (values.months) {
    const rows = PICK_STYLES.map((_, i) => new Map(pickByMonth(results[i]!).map((r) => [r.month, r])));
    console.log(`місяць    ${PICK_STYLES.map((s) => `${s.padEnd(8)} лонгів`.padEnd(20)).join("")}`);
    for (const month of [...rows[0]!.keys()]) {
      console.log(`${month}   ${rows.map((m) => { const r = m.get(month); return r ? `${fmt(r.avgR).padEnd(8)} ${(r.longShare * 100).toFixed(0)}%`.padEnd(20) : "".padEnd(20); }).join("")}`);
    }
  }
}

const fmt = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(3)}`);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
