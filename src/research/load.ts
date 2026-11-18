/**
 * Завантаження метрик і фандингу для дослідження закономірностей. Лише для локального запуску в Node.
 * Кеш у .backtest/cache/<монета>/metrics/<місяць>.csv (годинні точки) і .../funding/<місяць>.csv.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipFirst } from "../backtest/data";
import { pool, ROOT } from "../backtest/load";
import {
  daysOf,
  fundingUrl,
  mergeByTime,
  metricsFromCsv,
  metricsToCsv,
  metricsUrl,
  parseFunding,
  parseMetrics,
  type FundingPoint,
  type MetricPoint,
} from "./data";

/** Файл архіву або null, якщо його немає (404). Мережеві збої повторюються. */
async function download(url: string): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new TextDecoder().decode(unzipFirst(new Uint8Array(await res.arrayBuffer())));
    } catch (e) {
      if (attempt >= 4) throw new Error(`${url}: ${String(e)}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** Місяць ще не завершився або архів міг його не дописати: такий місяць не кешуємо. */
const isComplete = (month: string) => month < new Date().toISOString().slice(0, 7);

async function metricsMonth(symbol: string, month: string): Promise<MetricPoint[]> {
  const dir = join(ROOT, "cache", symbol, "metrics");
  const file = join(dir, `${month}.csv`);
  if (existsSync(file)) return metricsFromCsv(await readFile(file, "utf8"));
  const days = await pool(
    daysOf(month).map((day) => async () => {
      const csv = await download(metricsUrl(symbol, day));
      return csv ? parseMetrics(csv) : [];
    }),
    4,
  );
  const points = mergeByTime(days);
  if (isComplete(month)) {
    await mkdir(dir, { recursive: true });
    await writeFile(file, metricsToCsv(points));
  }
  return points;
}

async function fundingMonth(symbol: string, month: string): Promise<FundingPoint[]> {
  const dir = join(ROOT, "cache", symbol, "funding");
  const file = join(dir, `${month}.csv`);
  if (existsSync(file)) return parseFunding(await readFile(file, "utf8"));
  const csv = await download(fundingUrl(symbol, month));
  if (isComplete(month)) {
    await mkdir(dir, { recursive: true });
    await writeFile(file, csv ?? "");
  }
  return csv ? parseFunding(csv) : [];
}

export interface SymbolMetrics {
  metrics: MetricPoint[];
  funding: FundingPoint[];
}

/** Метрики й фандинг для монет за місяці. */
export async function loadMetrics(
  symbols: string[],
  monthsList: string[],
  log: (line: string) => void = () => {},
): Promise<Map<string, SymbolMetrics>> {
  const jobs = symbols.flatMap((symbol) => monthsList.map((month) => ({ symbol, month })));
  let done = 0;
  log(`Завантаження відкритого інтересу і фандингу: ${jobs.length} місяців по монетах (кеш у ${ROOT}/cache)`);
  const parts = await pool(
    jobs.map((j) => async () => {
      const [metrics, funding] = await Promise.all([metricsMonth(j.symbol, j.month), fundingMonth(j.symbol, j.month)]);
      if (++done % 25 === 0 || done === jobs.length) log(`  ${done}/${jobs.length}`);
      return { ...j, metrics, funding };
    }),
    8,
  );
  const out = new Map<string, SymbolMetrics>();
  for (const symbol of symbols) {
    const mine = parts.filter((p) => p.symbol === symbol);
    out.set(symbol, { metrics: mergeByTime(mine.map((p) => p.metrics)), funding: mergeByTime(mine.map((p) => p.funding)) });
  }
  return out;
}
