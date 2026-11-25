import { TIMEFRAME_MS, type Candle, type MarketData, type Timeframe } from "./types";

/**
 * Кеш свічок у сховищі рушія. Кожен запит до біржі докачує лише свічки, що закрились після останньої збереженої,
 * а якщо нових немає, біржу не питає зовсім. Так скан вкладається в 50 зовнішніх запитів і 10 мс процесора
 * безкоштовного плану Workers: відповіді біржі маленькі, а розбирати їх дешево.
 */

/** Скільки закритих свічок тримаємо на монету й таймфрейм. */
export const KEEP = 500;

export interface CandleStorage {
  load(symbol: string, tf: Timeframe): Candle[] | null;
  save(symbol: string, tf: Timeframe, candles: Candle[]): void;
}

/** Скільки свічок закрилось після останньої збереженої (на момент now). */
export function newlyClosed(lastCloseTime: number, tf: Timeframe, now: number): number {
  const step = TIMEFRAME_MS[tf];
  // Наступні свічки закриваються в lastClose + k·step; закрита та, у якої час закриття вже минув.
  return Math.max(0, Math.ceil((now - lastCloseTime) / step) - 1);
}

/**
 * Зливає збережені свічки з новими: нові перекривають старі з тим самим часом відкриття.
 * null, якщо між ними розрив (бракує свічок): тоді треба качати історію заново.
 */
export function mergeCandles(cached: Candle[], fresh: Candle[], tf: Timeframe, keep = KEEP): Candle[] | null {
  if (!fresh.length) return cached.slice(-keep);
  const last = cached[cached.length - 1];
  if (last && fresh[0]!.openTime > last.openTime + TIMEFRAME_MS[tf]) return null;
  const firstFresh = fresh[0]!.openTime;
  return [...cached.filter((c) => c.openTime < firstFresh), ...fresh].slice(-keep);
}

/** Обгортка над адаптером біржі: свічки через кеш, фандинг і відкритий інтерес напряму. */
export class CachedMarket implements MarketData {
  private mem = new Map<string, Candle[]>();

  constructor(
    private readonly inner: MarketData,
    private readonly storage: CandleStorage,
    private readonly now: () => number = Date.now,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  async candles(symbol: string, tf: Timeframe, limit: number): Promise<Candle[]> {
    const key = `${symbol}|${tf}`;
    const cached = this.mem.get(key) ?? this.storage.load(symbol, tf);
    const want = Math.min(limit, KEEP);
    const last = cached?.[cached.length - 1];
    if (cached && last && cached.length >= want) {
      const missing = newlyClosed(last.closeTime, tf, this.now());
      if (missing === 0) {
        this.mem.set(key, cached);
        return cached.slice(-want);
      }
      if (missing < KEEP - 10) {
        // Дві свічки перекриття: остання збережена могла змінитись у джерелі, а ще одна страхує від зсуву часу.
        const fresh = await this.inner.candles(symbol, tf, missing + 2);
        const merged = mergeCandles(cached, fresh, tf);
        if (merged) {
          this.remember(key, symbol, tf, merged);
          return merged.slice(-want);
        }
      }
    }
    const full = await this.inner.candles(symbol, tf, Math.max(want, KEEP - 2));
    this.remember(key, symbol, tf, full.slice(-KEEP));
    return full.slice(-want);
  }

  funding() {
    return this.inner.funding();
  }

  openInterest(symbol: string, points: number) {
    return this.inner.openInterest(symbol, points);
  }

  private remember(key: string, symbol: string, tf: Timeframe, candles: Candle[]): void {
    this.mem.set(key, candles);
    this.storage.save(symbol, tf, candles);
  }
}

/**
 * Сховище свічок у SQLite самого Durable Object: компактні масиви, один рядок на монету й таймфрейм.
 * prefix розводить джерела з однаковими символами: бот бере свічки Bybit, а скан крипто — з біржі налаштувань.
 */
export class SqlCandleStorage implements CandleStorage {
  constructor(
    private readonly sql: SqlStorage,
    private readonly prefix = "",
  ) {
    sql.exec("CREATE TABLE IF NOT EXISTS candles (symbol TEXT NOT NULL, tf TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (symbol, tf))");
  }

  load(name: string, tf: Timeframe): Candle[] | null {
    const symbol = this.prefix + name;
    const rows = this.sql.exec<{ data: string }>("SELECT data FROM candles WHERE symbol = ? AND tf = ?", symbol, tf).toArray();
    if (!rows.length) return null;
    const step = TIMEFRAME_MS[tf];
    return (JSON.parse(rows[0]!.data) as number[][]).map(([openTime, open, high, low, close, volume]) => ({
      openTime: openTime!,
      closeTime: openTime! + step - 1,
      open: open!,
      high: high!,
      low: low!,
      close: close!,
      volume: volume!,
    }));
  }

  save(name: string, tf: Timeframe, candles: Candle[]): void {
    const data = JSON.stringify(candles.map((c) => [c.openTime, c.open, c.high, c.low, c.close, c.volume]));
    this.sql.exec(
      "INSERT INTO candles (symbol, tf, data) VALUES (?, ?, ?) ON CONFLICT (symbol, tf) DO UPDATE SET data = excluded.data",
      this.prefix + name,
      tf,
      data,
    );
  }
}
