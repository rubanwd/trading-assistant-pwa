/**
 * Бектест бота «Імпульс між монетами» (крос-секційний моментум). Локально, не на Cloudflare:
 *   npm run backtest:momentum
 *   npm run backtest:momentum -- --from 2021-01 --to 2026-10 --test-from 2025-11 --lookback 28 --legs 4
 *
 * Денні свічки й фандинг ф'ючерсів з публічного архіву data.binance.vision (кеш у .backtest/cache).
 * Результат — у % капіталу бота після комісій, проковзування й фандингу.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MOMENTUM_DEFAULTS } from "../src/shared/bots";
import { formatMomentumLine, momentumSummary, momentumWeeksCsv, simulateMomentum, type MomentumSeries, type MomentumWeek } from "../src/backtest/momentum";
import { shiftMonth } from "../src/backtest/data";
import { ROOT } from "../src/backtest/load";
import { loadBroad } from "../src/backtest/universe";
import type { MomentumConfig, MomentumWeighting } from "../src/worker/bots/momentum";

const HELP = `Бектест «Імпульс між монетами»: щотижня лонг найсильніших і шорт найслабших монет списку.

  npm run backtest:momentum -- [параметри]

  --from YYYY-MM      перший місяць (2021-01)
  --to YYYY-MM        останній місяць (попередній повний місяць)
  --test-from YYYY-MM початок тестового періоду (останні 12 повних місяців)
  --top N             монет у списку (${MOMENTUM_DEFAULTS.topN})
  --lookback N        імпульс за N діб (${MOMENTUM_DEFAULTS.lookbackDays})
  --legs N            монет у кожній стороні (${MOMENTUM_DEFAULTS.legs})
  --weighting S       equal | vol (${MOMENTUM_DEFAULTS.weighting})
  --taker N           комісія taker, % (0.055, Bybit)
  --slippage N        проковзування, % (0.05)
  --grid              сітка параметрів на навчальному періоді (тест показується лише для стартових і найкращих)
  --out DIR           куди писати звіт
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
      from: { type: "string" }, to: { type: "string" }, "test-from": { type: "string" }, top: { type: "string" }, lookback: { type: "string" },
      legs: { type: "string" }, weighting: { type: "string" }, taker: { type: "string" }, slippage: { type: "string" }, grid: { type: "boolean" },
      out: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  const to = values.to ?? shiftMonth(new Date().toISOString().slice(0, 7), -1);
  const from = values.from ?? "2021-01";
  const testFrom = values["test-from"] ?? shiftMonth(to, -11);
  if (![from, to, testFrom].every((m) => /^\d{4}-\d{2}$/.test(m)) || from > to || testFrom < from || testFrom > to) throw new Error("--from, --to, --test-from у форматі YYYY-MM, from ≤ test-from ≤ to");
  const weighting = (values.weighting ?? MOMENTUM_DEFAULTS.weighting) as MomentumWeighting;
  if (weighting !== "equal" && weighting !== "vol") throw new Error("--weighting equal | vol");
  const cfg: MomentumConfig = {
    ...MOMENTUM_DEFAULTS,
    topN: num(values.top, MOMENTUM_DEFAULTS.topN),
    lookbackDays: num(values.lookback, MOMENTUM_DEFAULTS.lookbackDays),
    legs: num(values.legs, MOMENTUM_DEFAULTS.legs),
    weighting,
  };
  const takerPct = num(values.taker, 0.055);
  const slippagePct = num(values.slippage, 0.05);
  const log = (l: string) => process.stderr.write(l + "\n");

  const series: MomentumSeries[] = await loadBroad(from, to, log);

  const start = monthStart(from);
  const split = monthStart(testFrom);
  const end = monthStart(shiftMonth(to, 1));
  const lines: string[] = [];
  const out = (s = "") => {
    console.log(s);
    lines.push(s);
  };
  const run = (c: MomentumConfig, f: number, t: number, slip = slippagePct) => simulateMomentum(series, f, t, { cfg: c, takerPct, slippagePct: slip, volumeDays: 30 });
  const btc = series.find((s) => s.symbol === "BTCUSDT")!.daily;
  const hold = (f: number, t: number) => {
    const a = btc.find((c) => c.openTime >= f);
    const b = [...btc].reverse().find((c) => c.openTime < t);
    return a && b ? ((b.close / a.open - 1) * 100).toFixed(1) : "—";
  };

  out(`Імпульс між монетами · бектест ${from} — ${to} · тест з ${testFrom}`);
  out(`Список: топ-${cfg.topN} за обігом 30 діб із ${series.length} монет · імпульс ${cfg.lookbackDays} діб · ${cfg.legs} лонг + ${cfg.legs} шорт · частки ${cfg.weighting} · taker ${takerPct}% + проковзування ${slippagePct}% на обіг`);
  out("Результат у % капіталу бота (валова експозиція 1×, лонги й шорти по 50%), тижні додаються без реінвестування.");
  out("");

  const block = (title: string, f: number, t: number) => {
    const weeks = run(cfg, f, t);
    const s = momentumSummary(weeks);
    out(`== ${title}: ${new Date(f).toISOString().slice(0, 10)} — ${new Date(t - 1).toISOString().slice(0, 10)} · BTC за період ${hold(f, t)}% ==`);
    out(formatMomentumLine("Стартові параметри", s));
    out(formatMomentumLine(`Проковзування ×2`, momentumSummary(run(cfg, f, t, slippagePct * 2))));
    out(`  найгірший тиждень ${s.worstWeekPct}%, найкращий ${s.bestWeekPct}% · середній обіг ${s.avgTurnover} капіталу на тиждень`);
    out("");
    return { title, summary: s, weeks };
  };
  const full = block("Увесь період", start, end);
  const train = block("Навчання", start, split);
  const test = block("Тест (останні 12 повних місяців)", split, end);

  out("Роки (стартові параметри):");
  const years = [...new Set(full.weeks.map((w) => new Date(w.t).getUTCFullYear()))];
  for (const y of years) {
    const ws: MomentumWeek[] = full.weeks.filter((w) => new Date(w.t).getUTCFullYear() === y);
    out(formatMomentumLine(String(y), momentumSummary(ws)) + ` · BTC ${hold(Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1))}%`);
  }
  out("");

  const grid: { cfg: MomentumConfig; train: ReturnType<typeof momentumSummary> }[] = [];
  if (values.grid) {
    out("Сітка на навчальному періоді (тест не дивився):");
    for (const lookbackDays of [7, 14, 28, 56])
      for (const legs of [3, 4, 5])
        for (const w of ["equal", "vol"] as const) {
          const c = { ...cfg, lookbackDays, legs, weighting: w };
          const s = momentumSummary(run(c, start, split));
          grid.push({ cfg: c, train: s });
          out(formatMomentumLine(`${lookbackDays}д · ${legs}+${legs} · ${w}`, s));
        }
    const best = [...grid].sort((a, b) => (b.train.sharpe ?? -99) - (a.train.sharpe ?? -99)).slice(0, 3);
    out("");
    out("Три найкращі за Шарпом на навчанні — на тесті:");
    for (const b of best) out(formatMomentumLine(`${b.cfg.lookbackDays}д · ${b.cfg.legs}+${b.cfg.legs} · ${b.cfg.weighting}`, momentumSummary(run(b.cfg, split, end))));
    out("");
  }

  const dir = values.out ?? join(ROOT, "out", `momentum_${from}_${to}`);
  await mkdir(dir, { recursive: true });
  const strip = (b: ReturnType<typeof block>) => ({ title: b.title, summary: b.summary });
  await Promise.all([
    writeFile(join(dir, "report.txt"), lines.join("\n") + "\n"),
    writeFile(join(dir, "report.json"), JSON.stringify({ from, to, testFrom, cfg, takerPct, slippagePct, full: strip(full), train: strip(train), test: strip(test), grid }, null, 2)),
    writeFile(join(dir, "weeks.csv"), momentumWeeksCsv(full.weeks)),
  ]);
  console.log(`\nЗвіт і тижні: ${dir}`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? (e.stack ?? e.message) : e));
  process.exit(1);
});
