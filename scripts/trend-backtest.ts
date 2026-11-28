/**
 * Бектест трендового кошика (часовий моментум із цільовою волатильністю). Локально, не на Cloudflare:
 *   npm run backtest:trend
 *   npm run backtest:trend -- --sma 100 --top 5 --sides both --grid
 *
 * Денні свічки й фандинг ф'ючерсів з публічного архіву data.binance.vision (кеш у .backtest/cache).
 * Результат — у % капіталу після комісій, проковзування й фандингу, без плеча.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TREND_BASKET_DEFAULTS, type TrendBasketConfig } from "../src/shared/bots";
import { formatTrendLine, holdConfig, simulateTrend, trendSummary } from "../src/backtest/trend";
import { shiftMonth } from "../src/backtest/data";
import { ROOT } from "../src/backtest/load";
import { loadBroad } from "../src/backtest/universe";

const D = TREND_BASKET_DEFAULTS;
const HELP = `Бектест трендового кошика: лонг монет вище середньої, частки за волатильністю.

  npm run backtest:trend -- [параметри]

  --from YYYY-MM      перший місяць (2021-01)
  --to YYYY-MM        останній місяць (попередній повний місяць)
  --test-from YYYY-MM початок тестового періоду (останні 12 повних місяців)
  --top N             монет у списку (${D.topN})
  --sma N             середня, діб (${D.smaDays})
  --vol N             волатильність за N діб (${D.volDays})
  --target N          цільова річна волатильність позиції (${D.targetVol})
  --band N            смуга перебалансування (${D.band})
  --sides S           long | both (${D.sides})
  --taker N --slippage N   комісія й проковзування, % (0.055, 0.05)
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
      from: { type: "string" }, to: { type: "string" }, "test-from": { type: "string" }, top: { type: "string" }, sma: { type: "string" }, vol: { type: "string" },
      target: { type: "string" }, band: { type: "string" }, sides: { type: "string" }, taker: { type: "string" }, slippage: { type: "string" },
      grid: { type: "boolean" }, out: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  const to = values.to ?? shiftMonth(new Date().toISOString().slice(0, 7), -1);
  const from = values.from ?? "2021-01";
  const testFrom = values["test-from"] ?? shiftMonth(to, -11);
  if (![from, to, testFrom].every((m) => /^\d{4}-\d{2}$/.test(m)) || from > to || testFrom < from || testFrom > to) throw new Error("--from, --to, --test-from у форматі YYYY-MM, from ≤ test-from ≤ to");
  const sides = (values.sides ?? D.sides) as TrendBasketConfig["sides"];
  if (sides !== "long" && sides !== "both") throw new Error("--sides long | both");
  const cfg: TrendBasketConfig = {
    topN: num(values.top, D.topN), smaDays: num(values.sma, D.smaDays), volDays: num(values.vol, D.volDays), targetVol: num(values.target, D.targetVol), band: num(values.band, D.band), sides,
  };
  const takerPct = num(values.taker, 0.055);
  const slippagePct = num(values.slippage, 0.05);
  const log = (l: string) => process.stderr.write(l + "\n");
  // Розігрів середньої: loadBroad бере 2 місяці до from, тож перші тижні середня на 50 діб уже є; для довших — пізніше.
  const series = await loadBroad(shiftMonth(from, -3), to, log);

  const start = monthStart(from);
  const split = monthStart(testFrom);
  const end = monthStart(shiftMonth(to, 1));
  const lines: string[] = [];
  const out = (s = "") => {
    console.log(s);
    lines.push(s);
  };
  const run = (c: TrendBasketConfig, f: number, t: number, slip = slippagePct) => simulateTrend(series, f, t, { cfg: c, takerPct, slippagePct: slip, volumeDays: 30 });
  const btc = series.find((s) => s.symbol === "BTCUSDT")!.daily;
  const btcPct = (f: number, t: number) => {
    const a = btc.find((c) => c.openTime >= f);
    const b = [...btc].reverse().find((c) => c.openTime < t);
    return a && b ? `${((b.close / a.open - 1) * 100).toFixed(1)}%` : "—";
  };

  out(`Трендовий кошик · бектест ${from} — ${to} · тест з ${testFrom}`);
  out(`Список: топ-${cfg.topN} за обігом 30 діб із ${series.length} монет · ${cfg.sides === "long" ? "лонг" : "лонг / шорт"} відносно SMA ${cfg.smaDays} · волатильність ${cfg.volDays} діб, ціль ${cfg.targetVol} · смуга ${cfg.band} · taker ${takerPct}% + проковзування ${slippagePct}%`);
  out("Результат у % капіталу без плеча, денні результати додаються без реінвестування.");
  out("");

  const block = (title: string, f: number, t: number) => {
    const s = trendSummary(run(cfg, f, t));
    out(`== ${title}: ${new Date(f).toISOString().slice(0, 10)} — ${new Date(t - 1).toISOString().slice(0, 10)} · BTC ${btcPct(f, t)} ==`);
    out(formatTrendLine("Стартові параметри", s));
    out(formatTrendLine("Проковзування ×2", trendSummary(run(cfg, f, t, slippagePct * 2))));
    out(formatTrendLine("Утримання кошика (без сигналу)", trendSummary(run(holdConfig(cfg), f, t))));
    out("");
    return { title, summary: s };
  };
  const full = block("Увесь період", start, end);
  const train = block("Навчання", start, split);
  const test = block("Тест (останні 12 повних місяців)", split, end);

  out("Роки (стартові параметри · утримання кошика):");
  for (let y = new Date(start).getUTCFullYear(); y <= new Date(end - 1).getUTCFullYear(); y++) {
    const f = Math.max(start, Date.UTC(y, 0, 1));
    const t = Math.min(end, Date.UTC(y + 1, 0, 1));
    out(formatTrendLine(`${y} · BTC ${btcPct(f, t)}`, trendSummary(run(cfg, f, t))));
    out(formatTrendLine(`${y} · утримання`, trendSummary(run(holdConfig(cfg), f, t))));
  }
  out("");

  const grid: { cfg: TrendBasketConfig; train: ReturnType<typeof trendSummary> }[] = [];
  if (values.grid) {
    out("Сітка на навчальному періоді (тест не дивився):");
    for (const smaDays of [20, 50, 100])
      for (const topN of [5, 10])
        for (const s of ["long", "both"] as const) {
          const c = { ...cfg, smaDays, topN, sides: s };
          const r = trendSummary(run(c, start, split));
          grid.push({ cfg: c, train: r });
          out(formatTrendLine(`SMA ${smaDays} · топ-${topN} · ${s}`, r));
        }
    const best = [...grid].sort((a, b) => (b.train.sharpe ?? -99) - (a.train.sharpe ?? -99)).slice(0, 3);
    out("");
    out("Три найкращі за Шарпом на навчанні — на тесті:");
    for (const b of best) out(formatTrendLine(`SMA ${b.cfg.smaDays} · топ-${b.cfg.topN} · ${b.cfg.sides}`, trendSummary(run(b.cfg, split, end))));
    out("");
  }

  const dir = values.out ?? join(ROOT, "out", `trend_${from}_${to}`);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, "report.txt"), lines.join("\n") + "\n"),
    writeFile(join(dir, "report.json"), JSON.stringify({ from, to, testFrom, cfg, takerPct, slippagePct, full, train, test, grid }, null, 2)),
  ]);
  console.log(`\nЗвіт: ${dir}`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? (e.stack ?? e.message) : e));
  process.exit(1);
});
