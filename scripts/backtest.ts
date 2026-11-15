/**
 * Бектест детекторів, фільтра і супроводу на історичних свічках Binance.
 * Запускається локально, не на Cloudflare: npm run backtest -- --from 2025-11 --to 2026-10
 *
 * Свічки завантажуються з публічного архіву data.binance.vision і кешуються в .backtest/cache.
 * Звіт друкується в консоль і пишеться в .backtest/out (report.txt, report.json, trades.csv).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { archiveUrl, mergeCandles, months, parseKlines, shiftMonth, unzipFirst } from "../src/backtest/data";
import { buildReport, formatReport, tradesCsv } from "../src/backtest/report";
import { backtest, DEFAULT_CONFIG, type SymbolCandles } from "../src/backtest/simulate";
import type { Candle, Timeframe } from "../src/worker/market/types";

/** Стартовий список монет, як у міграції 0001. */
const WATCHLIST = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
  "LINKUSDT", "SUIUSDT", "TONUSDT", "DOTUSDT", "LTCUSDT", "NEARUSDT", "APTUSDT",
];

/** Скільки місяців історії до початку потрібно, щоб набрати 498 свічок для індикаторів. */
const WARMUP: Record<Timeframe, number> = { "15m": 0, "1h": 1, "4h": 3, "1d": 17 };

const HELP = `Бектест коду без моделі.

  npm run backtest -- [параметри]

  --from YYYY-MM        перший місяць (типово 12 місяців тому)
  --to YYYY-MM          останній місяць (типово попередній повний місяць)
  --symbols A,B         монети (типово стартовий список із 15)
  --min-rr N            мінімальний R:R (${DEFAULT_CONFIG.minRr})
  --max-active N        відкритих сигналів не більше (${DEFAULT_CONFIG.maxActive})
  --cooldown N          пауза для того самого сетапу по монеті, год (${DEFAULT_CONFIG.cooldownHours})
  --per-scan N          кандидатів за скан (${DEFAULT_CONFIG.maxCandidatesPerScan})
  --ttl N               сигнал чекає входу, год (${DEFAULT_CONFIG.ttlHours})
  --max-hold N          найдовше тримати позицію, год (${DEFAULT_CONFIG.maxHoldHours})
  --fee N               комісія за угоду, % (${DEFAULT_CONFIG.feePctPerSide})
  --out DIR             куди писати звіт (.backtest/out/<from>_<to>)
`;

const ROOT = ".backtest";

async function fetchMonth(symbol: string, tf: Timeframe, month: string, latest: string): Promise<Candle[]> {
  const dir = join(ROOT, "cache", symbol, tf);
  const file = join(dir, `${month}.csv`);
  const missing = `${file}.missing`;
  if (existsSync(file)) return parseKlines(await readFile(file, "utf8"));
  if (existsSync(missing)) return [];
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(archiveUrl(symbol, tf, month), { signal: AbortSignal.timeout(60_000) });
      await mkdir(dir, { recursive: true });
      if (res.status === 404) {
        await res.body?.cancel();
        // Монети ще не було на біржі. Останній місяць архів міг ще не опублікувати: його не запам'ятовуємо.
        if (month !== latest) await writeFile(missing, "");
        return [];
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const csv = new TextDecoder().decode(unzipFirst(new Uint8Array(await res.arrayBuffer())));
      await writeFile(file, csv);
      return parseKlines(csv);
    } catch (e) {
      if (attempt >= 4) throw new Error(`${symbol} ${tf} ${month}: ${String(e)}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]!();
      }
    }),
  );
  return out;
}

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
      "min-rr": { type: "string" }, "max-active": { type: "string" }, cooldown: { type: "string" },
      "per-scan": { type: "string" }, ttl: { type: "string" }, "max-hold": { type: "string" },
      fee: { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return console.log(HELP);

  const current = new Date().toISOString().slice(0, 7);
  const to = values.to ?? shiftMonth(current, -1);
  const from = values.from ?? shiftMonth(to, -11);
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) throw new Error("--from і --to у форматі YYYY-MM, from не пізніше to");
  const symbols = values.symbols ? values.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : WATCHLIST;

  const tfs: Timeframe[] = ["15m", "1h", "4h", "1d"];
  const jobs = symbols.flatMap((symbol) =>
    tfs.flatMap((tf) => months(shiftMonth(from, -WARMUP[tf]), to).map((month) => ({ symbol, tf, month }))),
  );
  let done = 0;
  process.stderr.write(`Завантаження свічок: ${jobs.length} місячних файлів (кеш у ${ROOT}/cache)\n`);
  const parts = await pool(
    jobs.map((j) => async () => {
      const candles = await fetchMonth(j.symbol, j.tf, j.month, to);
      if (++done % 50 === 0 || done === jobs.length) process.stderr.write(`  ${done}/${jobs.length}\n`);
      return { ...j, candles };
    }),
    8,
  );

  const data: SymbolCandles[] = [];
  for (const symbol of symbols) {
    const series = Object.fromEntries(
      tfs.map((tf) => [tf, mergeCandles(parts.filter((p) => p.symbol === symbol && p.tf === tf).map((p) => p.candles))]),
    ) as Record<Timeframe, Candle[]>;
    if (!series["1h"].length) {
      process.stderr.write(`  ${symbol}: немає даних за період, пропускаю\n`);
      continue;
    }
    data.push({ symbol, ...series });
  }

  const start = Date.parse(`${from}-01T00:00:00Z`);
  const end = Date.parse(`${shiftMonth(to, 1)}-01T00:00:00Z`) - 3_600_000;
  const config = {
    from: start,
    to: end,
    minRr: num(values["min-rr"], DEFAULT_CONFIG.minRr),
    maxActive: num(values["max-active"], DEFAULT_CONFIG.maxActive),
    cooldownHours: num(values.cooldown, DEFAULT_CONFIG.cooldownHours),
    maxCandidatesPerScan: num(values["per-scan"], DEFAULT_CONFIG.maxCandidatesPerScan),
    ttlHours: num(values.ttl, DEFAULT_CONFIG.ttlHours),
    maxHoldHours: num(values["max-hold"], DEFAULT_CONFIG.maxHoldHours),
    feePctPerSide: num(values.fee, DEFAULT_CONFIG.feePctPerSide),
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
