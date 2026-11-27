/**
 * Бектест бота «Фандинг-кері» (спот у лонг + шорт контракту, дохід — фандинг). Локально, не на Cloudflare:
 *   npm run backtest:carry
 *   npm run backtest:carry -- --entry 20 --exit 5 --lookback 3 --max-pos 5 --grid
 *
 * Денні свічки (для списку монет) і фандинг ф'ючерсів з публічного архіву data.binance.vision (кеш у .backtest/cache).
 * Результат — у % капіталу бота після комісій обох ніг і проковзування.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CARRY_DEFAULTS, type CarryConfig } from "../src/shared/bots";
import { carrySummary, carryTradesCsv, formatCarryLine, simulateCarry, type CarryFees } from "../src/backtest/carry";
import { shiftMonth } from "../src/backtest/data";
import { ROOT } from "../src/backtest/load";
import { loadBroad } from "../src/backtest/universe";

const HELP = `Бектест «Фандинг-кері»: купівля споту й шорт контракту на монетах із високим фандингом.

  npm run backtest:carry -- [параметри]

  --from YYYY-MM      перший місяць (2021-01)
  --to YYYY-MM        останній місяць (попередній повний місяць)
  --test-from YYYY-MM початок тестового періоду (останні 12 повних місяців)
  --top N             монет у списку (${CARRY_DEFAULTS.topN})
  --lookback N        середній фандинг за N діб (${CARRY_DEFAULTS.lookbackDays})
  --entry N           вхід від N% річних (${CARRY_DEFAULTS.entryApr})
  --exit N            вихід нижче N% річних (${CARRY_DEFAULTS.exitApr})
  --max-pos N         позицій одночасно (${CARRY_DEFAULTS.maxPositions})
  --spot N            комісія taker споту, % (0.1, Bybit)
  --taker N           комісія taker контракту, % (0.055, Bybit)
  --slippage N        проковзування на кожній нозі, % (0.05)
  --grid              сітка параметрів на навчальному періоді
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
      entry: { type: "string" }, exit: { type: "string" }, "max-pos": { type: "string" }, spot: { type: "string" }, taker: { type: "string" },
      slippage: { type: "string" }, grid: { type: "boolean" }, out: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  const to = values.to ?? shiftMonth(new Date().toISOString().slice(0, 7), -1);
  const from = values.from ?? "2021-01";
  const testFrom = values["test-from"] ?? shiftMonth(to, -11);
  if (![from, to, testFrom].every((m) => /^\d{4}-\d{2}$/.test(m)) || from > to || testFrom < from || testFrom > to) throw new Error("--from, --to, --test-from у форматі YYYY-MM, from ≤ test-from ≤ to");
  const cfg: CarryConfig = {
    topN: num(values.top, CARRY_DEFAULTS.topN),
    lookbackDays: num(values.lookback, CARRY_DEFAULTS.lookbackDays),
    entryApr: num(values.entry, CARRY_DEFAULTS.entryApr),
    exitApr: num(values.exit, CARRY_DEFAULTS.exitApr),
    maxPositions: num(values["max-pos"], CARRY_DEFAULTS.maxPositions),
  };
  const fees: CarryFees = { spotTakerPct: num(values.spot, 0.1), perpTakerPct: num(values.taker, 0.055), slippagePct: num(values.slippage, 0.05) };
  const log = (l: string) => process.stderr.write(l + "\n");
  const series = await loadBroad(from, to, log);

  const start = monthStart(from);
  const split = monthStart(testFrom);
  const end = monthStart(shiftMonth(to, 1));
  const lines: string[] = [];
  const out = (s = "") => {
    console.log(s);
    lines.push(s);
  };
  const run = (c: CarryConfig, f: number, t: number, fe = fees) => simulateCarry(series, f, t, { cfg: c, fees: fe, volumeDays: 30 });
  const sum = (c: CarryConfig, r: ReturnType<typeof run>) => carrySummary(r.days, r.trades, c.maxPositions);

  out(`Фандинг-кері · бектест ${from} — ${to} · тест з ${testFrom}`);
  out(`Список: топ-${cfg.topN} за обігом 30 діб із ${series.length} монет · фандинг за ${cfg.lookbackDays} доби · вхід від ${cfg.entryApr}% річних, вихід нижче ${cfg.exitApr}% · до ${cfg.maxPositions} позицій`);
  out(`Комісії на вхід і вихід: спот ${fees.spotTakerPct}% + контракт ${fees.perpTakerPct}% + проковзування ${fees.slippagePct}% × 2 ноги. Базис не враховано (див. src/backtest/carry.ts).`);
  out("Результат у % капіталу бота, без реінвестування.");
  out("");

  const block = (title: string, f: number, t: number) => {
    const r = run(cfg, f, t);
    const s = sum(cfg, r);
    out(`== ${title}: ${new Date(f).toISOString().slice(0, 10)} — ${new Date(t - 1).toISOString().slice(0, 10)} ==`);
    out(formatCarryLine("Стартові параметри", s));
    const dbl = { ...fees, slippagePct: fees.slippagePct * 2 };
    out(formatCarryLine("Проковзування ×2", sum(cfg, run(cfg, f, t, dbl))));
    out(`  найгірший тиждень ${s.worstWeekPct}% · днів із від'ємним фандингом за позиціями ${Math.round(s.negativeDays * 100)}%`);
    out("");
    return { title, summary: s, ...r };
  };
  const full = block("Увесь період", start, end);
  const train = block("Навчання", start, split);
  const test = block("Тест (останні 12 повних місяців)", split, end);

  out("Роки (стартові параметри):");
  for (const y of [...new Set(full.days.map((d) => new Date(d.t).getUTCFullYear()))]) {
    const f = Math.max(start, Date.UTC(y, 0, 1));
    const t = Math.min(end, Date.UTC(y + 1, 0, 1));
    out(formatCarryLine(String(y), sum(cfg, run(cfg, f, t))));
  }
  out("");

  const top = new Map<string, number>();
  for (const tr of full.trades) top.set(tr.symbol, (top.get(tr.symbol) ?? 0) + tr.net * 100);
  out("Внесок монет за весь період, % капіталу: " + [...top].sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s.replace(/USDT$/, "")} ${v.toFixed(1)}`).join(", "));
  out("");

  const grid: { cfg: CarryConfig; train: ReturnType<typeof carrySummary> }[] = [];
  if (values.grid) {
    out("Сітка на навчальному періоді (тест не дивився):");
    for (const lookbackDays of [1, 3, 7])
      for (const entryApr of [10, 20, 30, 50])
        for (const maxPositions of [3, 5]) {
          const c = { ...cfg, lookbackDays, entryApr, exitApr: entryApr / 4, maxPositions };
          const s = sum(c, run(c, start, split));
          grid.push({ cfg: c, train: s });
          out(formatCarryLine(`${lookbackDays}д · від ${entryApr}% · ${maxPositions} поз.`, s));
        }
    const best = [...grid].sort((a, b) => b.train.aprPct - a.train.aprPct).slice(0, 3);
    out("");
    out("Три найкращі за річною дохідністю на навчанні — на тесті:");
    for (const b of best) out(formatCarryLine(`${b.cfg.lookbackDays}д · від ${b.cfg.entryApr}% · ${b.cfg.maxPositions} поз.`, sum(b.cfg, run(b.cfg, split, end))));
    out("");
  }

  const dir = values.out ?? join(ROOT, "out", `carry_${from}_${to}`);
  await mkdir(dir, { recursive: true });
  const strip = (b: ReturnType<typeof block>) => ({ title: b.title, summary: b.summary });
  await Promise.all([
    writeFile(join(dir, "report.txt"), lines.join("\n") + "\n"),
    writeFile(join(dir, "report.json"), JSON.stringify({ from, to, testFrom, cfg, fees, full: strip(full), train: strip(train), test: strip(test), grid }, null, 2)),
    writeFile(join(dir, "trades.csv"), carryTradesCsv(full.trades)),
  ]);
  console.log(`\nЗвіт і угоди: ${dir}`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? (e.stack ?? e.message) : e));
  process.exit(1);
});
