/**
 * Історія Bybit для бектесту: денні й годинні свічки контракту, годинні свічки ціни маркування, ставки фандингу,
 * денні свічки споту (для порівняння з купівлею BTC). Кешується помісячно; поточний місяць завантажується знову.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BybitMarket, type Category } from "./bybit";
import { dec } from "./decimal";
import { DAY_MS, HOUR_MS, isoDay } from "./strategy";
import type { Candle, FundingRate } from "./types";

export interface SeriesCheck {
  name: string;
  count: number;
  first: number | null;
  last: number | null;
  /** Однакові повтори (прибрано). */
  duplicates: number;
  /** Повтори з різними цінами: дані суперечливі. */
  conflicting: number;
  /** Скільки разів порядок у відповіді біржі був порушений (виправлено сортуванням). */
  unordered: number;
  /** Пропуски: інтервали, для яких немає жодного запису. */
  gaps: { from: number; to: number }[];
}

export interface History {
  daily: Candle[];
  hourly: Candle[];
  markHourly: Candle[];
  spotDaily: Candle[];
  funding: FundingRate[];
  checks: SeriesCheck[];
}

type Raw = string[];

const monthStart = (month: string) => Date.parse(`${month}-01T00:00:00Z`);
export const nextMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
export const monthOf = (ts: number) => new Date(ts).toISOString().slice(0, 7);

export function months(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = nextMonth(m)) out.push(m);
  return out;
}

/** Відсортувати, прибрати повтори й знайти пропуски для ряду з рівним кроком. */
export function checkCandles(name: string, input: Candle[], step: number): { candles: Candle[]; check: SeriesCheck } {
  let unordered = 0;
  for (let i = 1; i < input.length; i++) if (input[i].openTime < input[i - 1].openTime) unordered++;
  const sorted = [...input].sort((a, b) => a.openTime - b.openTime);
  const out: Candle[] = [];
  let duplicates = 0;
  let conflicting = 0;
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.openTime === c.openTime) {
      const same = prev.open.eq(c.open) && prev.high.eq(c.high) && prev.low.eq(c.low) && prev.close.eq(c.close);
      if (same) duplicates++;
      else conflicting++;
      continue;
    }
    out.push(c);
  }
  const gaps: { from: number; to: number }[] = [];
  for (let i = 1; i < out.length; i++) {
    const diff = out[i].openTime - out[i - 1].openTime;
    if (diff !== step) gaps.push({ from: out[i - 1].openTime + step, to: out[i].openTime - 1 });
  }
  return {
    candles: out,
    check: { name, count: out.length, first: out[0]?.openTime ?? null, last: out[out.length - 1]?.openTime ?? null, duplicates, conflicting, unordered, gaps },
  };
}

/** Фандинг: пропуском вважається інтервал довший за 8 год між нарахуваннями. */
export function checkFunding(input: FundingRate[], maxGap = 8 * HOUR_MS): { funding: FundingRate[]; check: SeriesCheck } {
  let unordered = 0;
  for (let i = 1; i < input.length; i++) if (input[i].ts < input[i - 1].ts) unordered++;
  const sorted = [...input].sort((a, b) => a.ts - b.ts);
  const out: FundingRate[] = [];
  let duplicates = 0;
  let conflicting = 0;
  for (const f of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.ts === f.ts) {
      if (prev.rate.eq(f.rate)) duplicates++;
      else conflicting++;
      continue;
    }
    out.push(f);
  }
  const gaps: { from: number; to: number }[] = [];
  for (let i = 1; i < out.length; i++) if (out[i].ts - out[i - 1].ts > maxGap) gaps.push({ from: out[i - 1].ts + 1, to: out[i].ts - 1 });
  return { funding: out, check: { name: "funding", count: out.length, first: out[0]?.ts ?? null, last: out[out.length - 1]?.ts ?? null, duplicates, conflicting, unordered, gaps } };
}

export const describeGap = (g: { from: number; to: number }) => `${new Date(g.from).toISOString().slice(0, 16)} — ${new Date(g.to).toISOString().slice(0, 16)}`;

interface Source {
  key: string;
  step: number;
  fetch: (start: number, end: number) => Promise<Raw[]>;
}

export interface LoadOptions {
  market: BybitMarket;
  cacheDir: string;
  fromMonth: string;
  toMonth: string;
  now?: number;
  log?: (msg: string) => void;
}

const candleRaw = (c: Candle): Raw => [String(c.openTime), c.open.toString(), c.high.toString(), c.low.toString(), c.close.toString()];
const rawCandle = (r: Raw): Candle => ({ openTime: Number(r[0]), open: dec(r[1]), high: dec(r[2]), low: dec(r[3]), close: dec(r[4]) });

/** Свічки місяця з пагінацією по 1000. */
async function fetchCandles(get: (s: number, e: number) => Promise<Candle[]>, start: number, end: number, step: number): Promise<Raw[]> {
  const out: Candle[] = [];
  let from = start;
  for (let guard = 0; guard < 100 && from <= end; guard++) {
    const page = (await get(from, end)).filter((c) => c.openTime >= from && c.openTime <= end);
    out.push(...page);
    if (page.length < 1000) break;
    from = page[page.length - 1].openTime + step;
  }
  return out.map(candleRaw);
}

/** Фандинг місяця: біржа віддає до 200 від нових до старих, тож ідемо назад від кінця. */
async function fetchFunding(market: BybitMarket, start: number, end: number): Promise<Raw[]> {
  const out: FundingRate[] = [];
  let to = end;
  for (let guard = 0; guard < 100 && to >= start; guard++) {
    const page = (await market.fundingHistory(start, to)).filter((f) => f.ts >= start && f.ts <= to);
    out.push(...page);
    if (page.length < 200) break;
    to = page[0].ts - 1;
  }
  return out.map((f) => [String(f.ts), f.rate.toString()]);
}

export async function loadHistory(opts: LoadOptions): Promise<History> {
  const { market, cacheDir, fromMonth, toMonth } = opts;
  const now = opts.now ?? Date.now();
  const log = opts.log ?? (() => {});
  const kl = (interval: string, category: Category) => (s: number, e: number) => market.kline(interval, s, e, category);
  const sources: Source[] = [
    { key: "linear_D", step: DAY_MS, fetch: (s, e) => fetchCandles(kl("D", "linear"), s, e, DAY_MS) },
    { key: "linear_60", step: HOUR_MS, fetch: (s, e) => fetchCandles(kl("60", "linear"), s, e, HOUR_MS) },
    { key: "mark_60", step: HOUR_MS, fetch: (s, e) => fetchCandles((a, b) => market.markKline("60", a, b), s, e, HOUR_MS) },
    { key: "spot_D", step: DAY_MS, fetch: (s, e) => fetchCandles(kl("D", "spot"), s, e, DAY_MS) },
    { key: "funding", step: 0, fetch: (s, e) => fetchFunding(market, s, e) },
  ];
  const raw = new Map<string, Raw[]>();
  for (const src of sources) {
    const dir = join(cacheDir, market.symbol, src.key);
    await mkdir(dir, { recursive: true });
    const rows: Raw[] = [];
    let fetched = 0;
    for (const m of months(fromMonth, toMonth)) {
      const start = monthStart(m);
      const end = monthStart(nextMonth(m)) - 1;
      if (start > now) break;
      const file = join(dir, `${m}.json`);
      // Місяць кешується назавжди лише тоді, коли він повністю минув (з запасом на добу).
      const complete = end + DAY_MS < now;
      if (complete && existsSync(file)) {
        rows.push(...(JSON.parse(await readFile(file, "utf8")) as Raw[]));
        continue;
      }
      const data = await src.fetch(start, Math.min(end, now));
      fetched++;
      if (complete) await writeFile(file, JSON.stringify(data));
      rows.push(...data);
    }
    log(`${src.key}: ${rows.length} записів${fetched ? `, завантажено місяців: ${fetched}` : ", з кешу"}`);
    raw.set(src.key, rows);
  }
  const checks: SeriesCheck[] = [];
  const candles = (key: string, name: string, step: number) => {
    const r = checkCandles(name, raw.get(key)!.map(rawCandle), step);
    checks.push(r.check);
    return r.candles;
  };
  const daily = candles("linear_D", "денні свічки BTCUSDT perp", DAY_MS);
  const hourly = candles("linear_60", "годинні свічки BTCUSDT perp", HOUR_MS);
  const markHourly = candles("mark_60", "годинні свічки ціни маркування", HOUR_MS);
  const spotDaily = candles("spot_D", "денні свічки BTCUSDT spot", DAY_MS);
  const f = checkFunding(raw.get("funding")!.map((r) => ({ ts: Number(r[0]), rate: dec(r[1]) })));
  checks.push(f.check);
  return { daily, hourly, markHourly, spotDaily, funding: f.funding, checks };
}

export function formatChecks(checks: SeriesCheck[]): string[] {
  return checks.map((c) => {
    const range = c.first === null ? "порожньо" : `${isoDay(c.first)} — ${isoDay(c.last!)}`;
    const issues = [
      c.duplicates ? `повторів прибрано: ${c.duplicates}` : "",
      c.conflicting ? `СУПЕРЕЧЛИВИХ повторів: ${c.conflicting}` : "",
      c.unordered ? `порушень порядку: ${c.unordered}` : "",
      c.gaps.length ? `пропусків: ${c.gaps.length} (${c.gaps.slice(0, 3).map(describeGap).join("; ")}${c.gaps.length > 3 ? "; …" : ""})` : "",
    ].filter(Boolean);
    return `${c.name}: ${c.count}, ${range}${issues.length ? `; ${issues.join("; ")}` : "; без пропусків і повторів"}`;
  });
}
