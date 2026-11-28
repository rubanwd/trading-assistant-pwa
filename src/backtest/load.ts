/**
 * Завантаження історичних свічок для бектесту: архів data.binance.vision, кеш у .backtest/cache.
 * Лише для локального запуску в Node.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Candle, Timeframe } from "../worker/market/types";
import { archiveUrl, mergeCandles, months, parseKlines, shiftMonth, unzipFirst } from "./data";
import type { SymbolCandles } from "./simulate";

/** Стартовий список монет, як у міграції 0001. */
export const WATCHLIST = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
  "LINKUSDT", "SUIUSDT", "TONUSDT", "DOTUSDT", "LTCUSDT", "NEARUSDT", "APTUSDT",
];

/** Скільки місяців історії до початку потрібно, щоб набрати 498 свічок для індикаторів. */
export const WARMUP: Record<Timeframe, number> = { "15m": 0, "1h": 1, "4h": 3, "1d": 17 };

export const ROOT = ".backtest";

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

export async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
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

const TIMEFRAMES: Timeframe[] = ["15m", "1h", "4h", "1d"];

/**
 * Свічки всіх таймфреймів для монет за місяці from..to разом із розгоном індикаторів.
 * `timeframes` обмежує завантаження; таймфрейми поза списком лишаються порожніми.
 */
export async function loadSymbols(
  symbols: string[],
  from: string,
  to: string,
  log: (line: string) => void = () => {},
  timeframes: Timeframe[] = TIMEFRAMES,
  opts: { warmup?: Partial<Record<Timeframe, number>>; concurrency?: number } = {},
): Promise<SymbolCandles[]> {
  const jobs = symbols.flatMap((symbol) =>
    timeframes.flatMap((tf) => months(shiftMonth(from, -(opts.warmup?.[tf] ?? WARMUP[tf])), to).map((month) => ({ symbol, tf, month }))),
  );
  let done = 0;
  log(`Завантаження свічок: ${jobs.length} місячних файлів (кеш у ${ROOT}/cache)`);
  const parts = await pool(
    jobs.map((j) => async () => {
      const candles = await fetchMonth(j.symbol, j.tf, j.month, to);
      if (++done % 50 === 0 || done === jobs.length) log(`  ${done}/${jobs.length}`);
      return { ...j, candles };
    }),
    opts.concurrency ?? 8,
  );
  const data: SymbolCandles[] = [];
  for (const symbol of symbols) {
    const series = Object.fromEntries(
      TIMEFRAMES.map((tf) => [tf, mergeCandles(parts.filter((p) => p.symbol === symbol && p.tf === tf).map((p) => p.candles))]),
    ) as Record<Timeframe, Candle[]>;
    if (!series[timeframes.includes("1h") ? "1h" : timeframes[0]!].length) {
      log(`  ${symbol}: немає даних за період, пропускаю`);
      continue;
    }
    data.push({ symbol, ...series });
  }
  return data;
}
