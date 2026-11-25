/**
 * Бектест бота High Value Tube на історичних свічках. Локально, не на Cloudflare:
 *   npm run backtest:tube -- --from 2023-11 --to 2026-10
 *   npm run backtest:tube -- --grid --train-to 2025-10       # підбір параметрів на навчальному періоді, перевірка на решті
 *
 * Свічки 15m, 1h і 4h з публічного архіву data.binance.vision (кеш у .backtest/cache). Рушій бере дані Bybit;
 * для монет топ-20 свічки двох бірж майже однакові, а архів Bybit зі свічками недоступний без API.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TUBE_BIAS_SIDES, TUBE_DEFAULTS, TUBE_FALLBACK, type TubeBiasSide, type TubeConfig } from "../src/shared/bots";
import { shiftMonth } from "../src/backtest/data";
import { loadSymbols, ROOT } from "../src/backtest/load";
import { formatTubeReport, simulateTube, tubeHours, tubeReport, tubeSummary, tubeTradesCsv, type TubeBacktestConfig, type TubeHour } from "../src/backtest/tube";
import type { RankBy } from "../src/worker/bots/tube";
import type { Candle } from "../src/worker/market/types";


const HELP = `Бектест бота High Value Tube.

  npm run backtest:tube -- [параметри]

  --from YYYY-MM     перший місяць (2023-11)
  --to YYYY-MM       останній місяць (попередній повний місяць)
  --symbols A,B      монети (топ-20 на листопад 2026, TUBE_FALLBACK: список сьогоднішній,
                     тож бектест має зсув на користь монет, які дожили до топу)
  --pick N           монет щогодини (${TUBE_DEFAULTS.pickN})
  --entry N          відстань дальньої лімітки, ATR 1h (${TUBE_DEFAULTS.entryAtr})
  --ratio N          ближча лімітка в N разів ближче (${TUBE_DEFAULTS.biasRatio})
  --bias S           counter | trend | off: що ближче в бичачому/ведмежому ринку (${TUBE_DEFAULTS.biasSide})
  --stop N           стоп за входом, ATR 1h (${TUBE_DEFAULTS.stopAtr})
  --target N         тейк, R (${TUBE_DEFAULTS.targetR})
  --min-stop N       стоп не ближче, % (${TUBE_DEFAULTS.minStopPct})
  --hold N           найдовше тримати, год (${TUBE_DEFAULTS.maxHoldHours})
  --max-pos N        позицій разом з ордерами (${TUBE_DEFAULTS.maxPositions})
  --rank S           move | atr | volume: як вибирати монети (move)
  --anchor S         price | ema: від чого відкладати лімітки (price)
  --maker N --taker N --slippage N   комісії й проковзування, % (0.02, 0.05, 0)
  --grid             підбір параметрів на --from..--train-to і перевірка найкращих на решті періоду
  --train-to YYYY-MM кінець навчального періоду для --grid (2025-10)
  --out DIR          куди писати звіт (.backtest/out/tube_<from>_<to>)
`;

const num = (v: string | undefined, fallback: number) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`не число: ${v}`);
  return n;
};

const monthStart = (m: string) => Date.parse(`${m}-01T00:00:00Z`);

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string" }, to: { type: "string" }, symbols: { type: "string" }, pick: { type: "string" },
      entry: { type: "string" }, ratio: { type: "string" }, bias: { type: "string" }, stop: { type: "string" }, target: { type: "string" },
      "min-stop": { type: "string" }, hold: { type: "string" }, "max-pos": { type: "string" }, rank: { type: "string" }, anchor: { type: "string" },
      maker: { type: "string" }, taker: { type: "string" }, slippage: { type: "string" }, grid: { type: "boolean" }, "train-to": { type: "string" },
      out: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  const to = values.to ?? shiftMonth(new Date().toISOString().slice(0, 7), -1);
  const from = values.from ?? "2023-11";
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) throw new Error("--from і --to у форматі YYYY-MM, from не пізніше to");
  const symbols = values.symbols ? values.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : TUBE_FALLBACK;
  const bias = (values.bias ?? TUBE_DEFAULTS.biasSide) as TubeBiasSide;
  if (!TUBE_BIAS_SIDES.includes(bias)) throw new Error("--bias: counter, trend або off");
  const rankBy = (values.rank ?? "move") as RankBy;
  const anchor = (values.anchor ?? "price") as "price" | "ema";

  const cfg: TubeConfig = {
    topN: symbols.length,
    pickN: num(values.pick, TUBE_DEFAULTS.pickN),
    entryAtr: num(values.entry, TUBE_DEFAULTS.entryAtr),
    biasRatio: num(values.ratio, TUBE_DEFAULTS.biasRatio),
    biasSide: bias,
    stopAtr: num(values.stop, TUBE_DEFAULTS.stopAtr),
    targetR: num(values.target, TUBE_DEFAULTS.targetR),
    minStopPct: num(values["min-stop"], TUBE_DEFAULTS.minStopPct),
    maxHoldHours: num(values.hold, TUBE_DEFAULTS.maxHoldHours),
    maxPositions: num(values["max-pos"], TUBE_DEFAULTS.maxPositions),
  };
  const fees = { makerPct: num(values.maker, 0.02), takerPct: num(values.taker, 0.05) };
  const slippagePct = num(values.slippage, 0);

  const data = await loadSymbols(symbols, from, to, (l) => process.stderr.write(l + "\n"), ["15m", "1h", "4h"]);
  const start = monthStart(from);
  const end = monthStart(shiftMonth(to, 1)) - 3_600_000;
  process.stderr.write(`Ознаки: ${data.length} монет, ${from} — ${to}\n`);
  const t0 = Date.now();
  const hours = tubeHours(data, start, end);
  const m15 = new Map<string, Candle[]>(data.map((d) => [d.symbol, d["15m"]]));
  process.stderr.write(`  ${hours.length} циклів за ${((Date.now() - t0) / 1000).toFixed(1)} с\n`);

  const out = values.out ?? join(ROOT, "out", `tube_${from}_${to}`);
  await mkdir(out, { recursive: true });

  if (values.grid) return grid(hours, m15, { from, to, trainTo: values["train-to"] ?? "2025-10", fees, slippagePct, cfg, rankBy, anchor, out });

  const bt: TubeBacktestConfig = { cfg, fees, slippagePct, rankBy, anchor };
  const orders = simulateTube(hours, m15, bt);
  const report = tubeReport(orders, start, end);
  const text = formatTubeReport(report, { from, to, symbols: data.length, cfg, extra: `рейтинг ${rankBy} · від ${anchor}` });
  console.log(text);
  await Promise.all([
    writeFile(join(out, "report.txt"), text + "\n"),
    writeFile(join(out, "report.json"), JSON.stringify({ from, to, symbols: data.map((d) => d.symbol), cfg, fees, slippagePct, rankBy, anchor, ...report }, null, 2)),
    writeFile(join(out, "trades.csv"), tubeTradesCsv(orders)),
  ]);
  console.log(`\nЗвіт і угоди: ${out}`);
}

/**
 * Сітка параметрів: кожна комбінація на навчальному періоді, потім найкращі за середнім R (не менше 500 угод)
 * перевіряються на тестовому періоді, якого підбір не бачив.
 */
async function grid(
  hours: TubeHour[],
  m15: Map<string, Candle[]>,
  o: { from: string; to: string; trainTo: string; fees: TubeBacktestConfig["fees"]; slippagePct: number; cfg: TubeConfig; rankBy: RankBy; anchor: "price" | "ema"; out: string },
) {
  const split = monthStart(shiftMonth(o.trainTo, 1));
  const train = hours.filter((h) => h.t < split);
  const test = hours.filter((h) => h.t >= split);
  const rows: { cfg: TubeConfig; train: ReturnType<typeof tubeSummary>; test: ReturnType<typeof tubeSummary> | null }[] = [];
  const combos: TubeConfig[] = [];
  for (const entryAtr of [1, 1.5, 2, 2.5, 3])
    for (const stopAtr of [1, 1.5, 2, 3])
      for (const targetR of [0.5, 0.75, 1, 1.5])
        for (const maxHoldHours of [6, 12, 24])
          for (const biasSide of TUBE_BIAS_SIDES) combos.push({ ...o.cfg, entryAtr, stopAtr, targetR, maxHoldHours, biasSide });
  const t0 = Date.now();
  for (const [i, cfg] of combos.entries()) {
    const bt: TubeBacktestConfig = { cfg, fees: o.fees, slippagePct: o.slippagePct, rankBy: o.rankBy, anchor: o.anchor };
    rows.push({ cfg, train: tubeSummary(simulateTube(train, m15, bt).filter((x) => x.filledAt !== null), false), test: null });
    if ((i + 1) % 60 === 0) process.stderr.write(`  ${i + 1}/${combos.length} за ${((Date.now() - t0) / 1000).toFixed(0)} с\n`);
  }
  const ranked = rows.filter((r) => r.train.trades >= 500 && r.train.avgR !== null).sort((a, b) => b.train.avgR! - a.train.avgR!);
  for (const r of ranked.slice(0, 15)) {
    const bt: TubeBacktestConfig = { cfg: r.cfg, fees: o.fees, slippagePct: o.slippagePct, rankBy: o.rankBy, anchor: o.anchor };
    r.test = tubeSummary(simulateTube(test, m15, bt).filter((x) => x.filledAt !== null));
  }
  const fmt = (s: ReturnType<typeof tubeSummary> | null) =>
    s ? `${String(s.trades).padStart(5)} угод · ${s.winRate === null ? "—" : Math.round(s.winRate * 100) + "%"} · ${s.avgR === null ? "—" : s.avgR.toFixed(3)}R · ${s.totalR.toFixed(0)}R · DD ${s.maxDrawdownR}R` : "—";
  const name = (c: TubeConfig) => `вхід ${c.entryAtr} · стоп ${c.stopAtr} · тейк ${c.targetR}R · ${c.maxHoldHours} год · ${c.biasSide}`;
  const lines = [
    `Сітка: ${combos.length} комбінацій · навчання ${o.from} — ${o.trainTo} (${train.length} циклів) · тест ${shiftMonth(o.trainTo, 1)} — ${o.to} (${test.length} циклів)`,
    `Рейтинг ${o.rankBy}, від ${o.anchor}`,
    "",
    "Найкращі на навчанні → тест:",
    ...ranked.slice(0, 15).map((r) => `  ${name(r.cfg).padEnd(48)} | ${fmt(r.train)} | тест ${fmt(r.test)}`),
    "",
    "Найгірші на навчанні:",
    ...ranked.slice(-5).map((r) => `  ${name(r.cfg).padEnd(48)} | ${fmt(r.train)}`),
    "",
    `Частка комбінацій із середнім R > 0 на навчанні: ${Math.round((ranked.filter((r) => r.train.avgR! > 0).length / Math.max(1, ranked.length)) * 100)}%`,
  ];
  console.log(lines.join("\n"));
  await writeFile(join(o.out, "grid.json"), JSON.stringify(rows, null, 2));
  await writeFile(join(o.out, "grid.txt"), lines.join("\n") + "\n");
  console.log(`\nСітка: ${o.out}`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.stack ?? e.message : e));
  process.exit(1);
});
