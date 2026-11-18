/**
 * Пошук закономірностей в історії: як ознаки ринку (відкритий інтерес, фандинг, волатильність, обсяг, тренд…)
 * пов'язані з рухом ціни далі, по всіх монетах разом і кожній окремо, з перевіркою на періоді, якого пошук не бачив.
 * Запускається локально, не на Cloudflare: npm run patterns -- --from 2022-01 --to 2026-10 --split 2025-01
 *
 * Дані з публічного архіву data.binance.vision, кеш у .backtest/cache. Звіт у консоль і в .backtest/research.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { months, shiftMonth } from "../src/backtest/data";
import { loadSymbols, ROOT, WATCHLIST } from "../src/backtest/load";
import { backtest, DEFAULT_CONFIG } from "../src/backtest/simulate";
import { btcReturns, buildRows, FEATURES, type Feature, type Row } from "../src/research/features";
import { loadMetrics } from "../src/research/load";
import { breakoutSplits, DEFAULT_SEARCH, searchPatterns } from "../src/research/patterns";
import { conditionText, formatResearch } from "../src/research/report";

const HELP = `Пошук закономірностей в історії.

  npm run patterns -- [параметри]

  --from YYYY-MM        перший місяць (2022-01: раніше в архіві немає відкритого інтересу)
  --to YYYY-MM          останній місяць (типово попередній повний місяць)
  --split YYYY-MM       перший місяць тестового періоду (типово 2025-01)
  --symbols A,B         монети (типово стартовий список із 15)
  --horizon N           горизонт, год (${DEFAULT_SEARCH.horizonHours})
  --barrier N           бар'єри: стоп і ціль у ATR 4h (${DEFAULT_SEARCH.barrier})
  --q N                 допустима частка хибних відкриттів (${DEFAULT_SEARCH.q})
  --focus S:A:B,...     сітки пар ознак для монети (типово ETHUSDT:oi_vs_30d:atr_pct,ETHUSDT:oi_vs_30d:volume_24h)
  --no-breakout         не розбирати трендовий пробій за ознаками
  --out DIR             куди писати звіт (.backtest/research/<from>_<to>)

Ознаки: ${FEATURES.join(", ")}
`;

async function main() {
  const { values } = parseArgs({
    options: {
      from: { type: "string" }, to: { type: "string" }, split: { type: "string" }, symbols: { type: "string" },
      horizon: { type: "string" }, barrier: { type: "string" }, q: { type: "string" }, focus: { type: "string" }, "no-breakout": { type: "boolean" },
      out: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);
  const log = (line: string) => process.stderr.write(line + "\n");

  const to = values.to ?? shiftMonth(new Date().toISOString().slice(0, 7), -1);
  const from = values.from ?? "2022-01";
  const split = values.split ?? "2025-01";
  for (const m of [from, to, split]) if (!/^\d{4}-\d{2}$/.test(m)) throw new Error(`місяць у форматі YYYY-MM: ${m}`);
  if (!(from < split && split <= to)) throw new Error("має бути from < split ≤ to");
  const symbols = values.symbols ? values.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : WATCHLIST;
  if (!symbols.includes("BTCUSDT")) symbols.unshift("BTCUSDT");
  const cfg = {
    ...DEFAULT_SEARCH,
    split: Date.parse(`${split}-01T00:00:00Z`),
    horizonHours: values.horizon ? Number(values.horizon) : DEFAULT_SEARCH.horizonHours,
    barrier: values.barrier ? Number(values.barrier) : DEFAULT_SEARCH.barrier,
    q: values.q ? Number(values.q) : DEFAULT_SEARCH.q,
  };
  // Кластер не коротший за подвійний горизонт: сусідні свічки мають спільне майбутнє.
  cfg.clusterMs = Math.max(DEFAULT_SEARCH.clusterMs, 2 * cfg.horizonHours * 3_600_000);
  const focus = (values.focus ?? "ETHUSDT:oi_vs_30d:atr_pct,ETHUSDT:oi_vs_30d:volume_24h").split(",").map((f) => {
    const [slice, a, b] = f.split(":");
    if (!slice || !FEATURES.includes(a as Feature) || !FEATURES.includes(b as Feature)) throw new Error(`--focus: ${f}`);
    return { slice: slice.toUpperCase(), a: a as Feature, b: b as Feature };
  });

  const candles = await loadSymbols(symbols, from, to, log, ["1h", "4h", "1d"]);
  // Місяць до початку: розгін 30-денного середнього відкритого інтересу.
  const metrics = await loadMetrics(candles.map((c) => c.symbol), months(shiftMonth(from, -1), to), log);
  const btc = btcReturns(candles.find((c) => c.symbol === "BTCUSDT")?.["4h"] ?? []);
  const start = Date.parse(`${from}-01T00:00:00Z`);
  const end = Date.parse(`${shiftMonth(to, 1)}-01T00:00:00Z`);

  log("Ознаки й результати…");
  const rows: Row[] = [];
  for (const c of candles) {
    const m = metrics.get(c.symbol)!;
    const mine = buildRows({ symbol: c.symbol, h1: c["1h"], h4: c["4h"], metrics: m.metrics, funding: m.funding }, btc, cfg.horizonHours, DEFAULT_CONFIG.takerPct, cfg.barrier)
      .filter((r) => r.t >= start && r.t < end);
    log(`  ${c.symbol}: ${mine.length} закриттів 4h, з відкритим інтересом ${mine.filter((r) => r.bins[FEATURES.indexOf("oi_vs_30d")]! >= 0).length}`);
    rows.push(...mine);
  }

  log("Пошук закономірностей…");
  const result = searchPatterns(rows, cfg);

  let splits = null;
  if (!values["no-breakout"]) {
    log("Бектест трендового пробою для розбору за ознаками…");
    const { trades } = backtest(candles, { ...DEFAULT_CONFIG, from: start, to: end - 3_600_000 });
    splits = breakoutSplits(trades, rows, cfg.split);
  }

  const text = formatResearch(result, splits, cfg, { from, to, split, symbols: candles.length, takerPct: DEFAULT_CONFIG.takerPct, focus });
  console.log(text);

  const out = values.out ?? join(ROOT, "research", `${from}_${to}`);
  await mkdir(out, { recursive: true });
  const pattern = (p: (typeof result.discovered)[number]) => ({ ...p, text: conditionText(p.conditions) });
  await Promise.all([
    writeFile(join(out, "report.txt"), text + "\n"),
    writeFile(
      join(out, "patterns.json"),
      JSON.stringify({ from, to, split, symbols: candles.map((c) => c.symbol), config: cfg, tested: result.tested, base: result.base, confirmed: result.confirmed.map(pattern), discovered: result.discovered.map(pattern), breakout: splits }, null, 2),
    ),
  ]);
  console.log(`\nЗвіт і закономірності: ${out}`);
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
