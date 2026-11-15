/**
 * Бектест детекторів, фільтра і супроводу на історичних свічках Binance.
 * Запускається локально, не на Cloudflare: npm run backtest -- --from 2025-11 --to 2026-10
 *
 * Свічки завантажуються з публічного архіву data.binance.vision і кешуються в .backtest/cache.
 * Звіт друкується в консоль і пишеться в .backtest/out (report.txt, report.json, trades.csv).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { shiftMonth } from "../src/backtest/data";
import { loadSymbols, ROOT, WATCHLIST } from "../src/backtest/load";
import { buildReport, formatReport, tradesCsv } from "../src/backtest/report";
import { backtest, DEFAULT_CONFIG } from "../src/backtest/simulate";

const HELP = `Бектест коду без моделі.

  npm run backtest -- [параметри]

  --from YYYY-MM        перший місяць (типово 12 місяців тому)
  --to YYYY-MM          останній місяць (типово попередній повний місяць)
  --symbols A,B         монети (типово стартовий список із 15)
  --min-rr N            мінімальний R:R (${DEFAULT_CONFIG.minRr})
  --min-stop N          стоп не ближче, % від входу (${DEFAULT_CONFIG.minStopPct})
  --max-active N        відкритих сигналів не більше (${DEFAULT_CONFIG.maxActive})
  --cooldown N          пауза для того самого сетапу по монеті, год (${DEFAULT_CONFIG.cooldownHours})
  --per-scan N          кандидатів за скан (${DEFAULT_CONFIG.maxCandidatesPerScan})
  --ttl N               сигнал чекає входу, год (${DEFAULT_CONFIG.ttlHours})
  --max-hold N          найдовше тримати позицію, год (${DEFAULT_CONFIG.maxHoldHours})
  --maker N             комісія maker, %: вхід і цілі (${DEFAULT_CONFIG.makerPct})
  --taker N             комісія taker, %: стоп, беззбиток, закриття за часом (${DEFAULT_CONFIG.takerPct})
  --out DIR             куди писати звіт (.backtest/out/<from>_<to>)
`;

const num = (v: string | undefined, fallback: number) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`не число: ${v}`);
  return n;
};

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string" }, to: { type: "string" }, symbols: { type: "string" },
      "min-rr": { type: "string" }, "min-stop": { type: "string" }, "max-active": { type: "string" }, cooldown: { type: "string" },
      "per-scan": { type: "string" }, ttl: { type: "string" }, "max-hold": { type: "string" },
      maker: { type: "string" }, taker: { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);

  const current = new Date().toISOString().slice(0, 7);
  const to = values.to ?? shiftMonth(current, -1);
  const from = values.from ?? shiftMonth(to, -11);
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) throw new Error("--from і --to у форматі YYYY-MM, from не пізніше to");
  const symbols = values.symbols ? values.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : WATCHLIST;

  const data = await loadSymbols(symbols, from, to, (line) => process.stderr.write(line + "\n"));

  const start = Date.parse(`${from}-01T00:00:00Z`);
  const end = Date.parse(`${shiftMonth(to, 1)}-01T00:00:00Z`) - 3_600_000;
  const config = {
    from: start,
    to: end,
    minRr: num(values["min-rr"], DEFAULT_CONFIG.minRr),
    minStopPct: num(values["min-stop"], DEFAULT_CONFIG.minStopPct),
    maxActive: num(values["max-active"], DEFAULT_CONFIG.maxActive),
    cooldownHours: num(values.cooldown, DEFAULT_CONFIG.cooldownHours),
    maxCandidatesPerScan: num(values["per-scan"], DEFAULT_CONFIG.maxCandidatesPerScan),
    ttlHours: num(values.ttl, DEFAULT_CONFIG.ttlHours),
    maxHoldHours: num(values["max-hold"], DEFAULT_CONFIG.maxHoldHours),
    makerPct: num(values.maker, DEFAULT_CONFIG.makerPct),
    takerPct: num(values.taker, DEFAULT_CONFIG.takerPct),
  };
  process.stderr.write(`Симуляція: ${data.length} монет, ${from} — ${to}\n`);
  const t0 = Date.now();
  const result = backtest(data, config);
  process.stderr.write(`  готово за ${((Date.now() - t0) / 1000).toFixed(1)} с\n\n`);

  const report = buildReport(result);
  const text = formatReport(report, { from, to, symbols: data.length });
  console.log(text);

  const out = values.out ?? join(ROOT, "out", `${from}_${to}`);
  await mkdir(out, { recursive: true });
  const { from: _f, to: _t, ...settings } = config;
  await Promise.all([
    writeFile(join(out, "report.txt"), text + "\n"),
    writeFile(join(out, "report.json"), JSON.stringify({ from, to, symbols: data.map((d) => d.symbol), settings, ...report }, null, 2)),
    writeFile(join(out, "trades.csv"), tradesCsv(result.trades)),
  ]);
  console.log(`\nЗвіт і угоди: ${out}`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
