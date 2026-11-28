import { months, shiftMonth } from "./data";
import { loadSymbols, pool } from "./load";
import { fundingMonth } from "../research/load";
import { mergeByTime } from "../research/data";
import type { Candle } from "../worker/market/types";

/**
 * Широкий список монет, що в різні роки з 2021-го входили до найліквідніших на ф'ючерсах Binance, разом із тими,
 * що потім обвалились чи зникли. Список на кожен тиждень бектест вибирає з нього за обігом.
 */
export const CANDIDATES = [
  "BTC", "ETH", "BNB", "XRP", "SOL", "ADA", "DOGE", "AVAX", "DOT", "MATIC", "POL", "LINK", "LTC", "BCH", "TRX", "ETC", "UNI", "ATOM",
  "XLM", "FIL", "NEAR", "APT", "ARB", "OP", "SUI", "TON", "1000SHIB", "1000PEPE", "WIF", "LUNA", "LUNA2", "FTT", "SAND", "MANA", "AXS",
  "GALA", "AAVE", "EOS", "ALGO", "ICP", "HBAR", "VET", "FTM", "S", "INJ", "TIA", "SEI", "RNDR", "RENDER", "WLD", "ORDI", "1000BONK",
  "ENA", "HYPE", "ZEC", "XMR", "TAO", "ONDO", "TRUMP", "FET", "LDO", "APE", "CRV", "GMT", "DYDX", "STX", "MKR", "EGLD", "THETA", "CHZ",
  "XTZ", "SUSHI", "1000FLOKI", "JUP", "PENGU", "VIRTUAL", "KAS", "BTT", "SHIB", "SRM", "KSM", "NEO", "ZIL", "ENJ", "CAKE", "PNUT",
].map((s) => `${s}USDT`);

export interface BroadSeries {
  symbol: string;
  daily: Candle[];
  /** Фактично нараховані ставки фандингу (без зведення до 8 годин). */
  funding: { at: number; paid: number }[];
}

/** Денні свічки й фандинг ф'ючерсів Binance для всього широкого списку; монети без свічок за період пропускаються. */
export async function loadBroad(from: string, to: string, log: (l: string) => void = () => {}): Promise<BroadSeries[]> {
  // Розігрів: 2 місяці на ознаки й обіг за 30 діб.
  const loaded = await loadSymbols(CANDIDATES, from, to, log, ["1d"], { warmup: { "1d": 2 }, concurrency: 24 });
  const monthList = months(shiftMonth(from, -1), to);
  log(`Завантаження фандингу: ${loaded.length} монет × ${monthList.length} місяців`);
  let done = 0;
  return pool(
    loaded.map((d) => async () => {
      const parts = [];
      for (const m of monthList) parts.push(await fundingMonth(d.symbol, m));
      if (++done % 10 === 0) log(`  ${done}/${loaded.length}`);
      return { symbol: d.symbol, daily: d["1d"], funding: mergeByTime(parts).map((f) => ({ at: f.at, paid: f.paid ?? f.rate })) };
    }),
    16,
  );
}
