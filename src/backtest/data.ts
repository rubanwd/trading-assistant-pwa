import { inflateRawSync } from "node:zlib";
import type { Candle, Timeframe } from "../worker/market/types";

/**
 * Історичні свічки ф'ючерсів USDⓈ-M з публічного архіву Binance (data.binance.vision).
 * Лише публічні дані без ключів. Архів доступний і там, де API Binance відповідає 451.
 */

export const ARCHIVE = "https://data.binance.vision/data/futures/um/monthly/klines";

export const archiveUrl = (symbol: string, tf: Timeframe, month: string) => `${ARCHIVE}/${symbol}/${tf}/${symbol}-${tf}-${month}.zip`;

/** Місяці у форматі YYYY-MM від `from` до `to` включно. */
export function months(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Зсув місяця YYYY-MM на `delta` місяців. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Розпаковує перший файл zip-архіву (архіви Binance містять один CSV). */
export function unzipFirst(zip: Uint8Array): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Кінець центрального каталогу шукаємо з кінця файлу: після нього може йти коментар.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("не zip-архів");
  const dir = view.getUint32(eocd + 16, true);
  if (view.getUint32(dir, true) !== 0x02014b50) throw new Error("пошкоджений zip-архів");
  const method = view.getUint16(dir + 10, true);
  const size = view.getUint32(dir + 20, true);
  const local = view.getUint32(dir + 42, true);
  const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const data = zip.subarray(start, start + size);
  if (method === 0) return data;
  if (method === 8) return new Uint8Array(inflateRawSync(data));
  throw new Error(`непідтримуваний метод стиснення ${method}`);
}

/** CSV свічок Binance: open_time, open, high, low, close, volume, close_time, ... Рядок заголовка пропускається. */
export function parseKlines(csv: string): Candle[] {
  const out: Candle[] = [];
  for (const line of csv.split("\n")) {
    const f = line.split(",");
    const openTime = Number(f[0]);
    if (f.length < 7 || !Number.isFinite(openTime)) continue;
    out.push({
      openTime,
      closeTime: Number(f[6]),
      open: Number(f[1]),
      high: Number(f[2]),
      low: Number(f[3]),
      close: Number(f[4]),
      volume: Number(f[5]),
    });
  }
  return out;
}

/** Склеює місяці, прибирає дублікати й упорядковує за часом. */
export function mergeCandles(parts: Candle[][]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const part of parts) for (const c of part) byTime.set(c.openTime, c);
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}
