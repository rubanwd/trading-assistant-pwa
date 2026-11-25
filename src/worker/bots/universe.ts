/**
 * Список монет бота: топ за капіталізацією (CoinGecko), що мають безстроковий USDT-контракт на Bybit.
 * Стейблкоїни, токенізоване золото, обгортки й стейкінгові токени не беруться: вони не рухаються самі по собі.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Рядок /coins/markets CoinGecko: лише поля, які потрібні. */
export interface CapRow {
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap_rank: number | null;
}

export interface LinearInstrument {
  symbol: string;
  baseCoin: string;
}

const STABLE = new Set([
  "USDT", "USDC", "USDE", "DAI", "USDS", "FDUSD", "TUSD", "PYUSD", "USD1", "RLUSD", "USDG", "USDY", "USYC", "BUIDL", "USD0", "USDD",
  "GHO", "FRAX", "LUSD", "CRVUSD", "EURC", "EURS", "BSC-USD", "USDTB", "USDF", "SUSDE", "SUSDS", "USDX", "USDB", "USDL", "USDP",
]);
const WRAPPED = new Set([
  "WBTC", "WETH", "WBNB", "WSOL", "STETH", "WSTETH", "WEETH", "EETH", "CBBTC", "CBETH", "RETH", "METH", "JITOSOL", "MSOL", "BNSOL",
  "LBTC", "SOLVBTC", "TBTC", "BTCB", "CLBTC", "RSETH", "EZETH", "BETH", "WBETH", "STSOL", "JUPSOL", "WBT",
]);
const GOLD = new Set(["XAUT", "PAXG", "KAU", "XAUM"]);

/** Чи це монета, що рухається сама: не стейблкоїн, не золото, не обгортка. */
export function isTradableCoin(row: CapRow): boolean {
  const sym = row.symbol.toUpperCase();
  const name = row.name.toLowerCase();
  if (STABLE.has(sym) || WRAPPED.has(sym) || GOLD.has(sym)) return false;
  if (/wrapped|staked|bridged|\bgold\b|tokenized|treasury/.test(name)) return false;
  // Невідомий стейблкоїн чи токенізований фонд: ціна біля $1 (або €1) і «usd»/«eur»/«dollar» у назві чи символі.
  const p = row.current_price;
  if (p !== null && p > 0.85 && p < 1.35 && /usd|eur|dollar|euro/.test(`${sym.toLowerCase()} ${name}`)) return false;
  return true;
}

/** Множники, з якими Bybit називає дешеві монети: SHIB1000USDT, 1000PEPEUSDT. */
const ALIASES = (sym: string) => [sym, `1000${sym}`, `10000${sym}`, `1000000${sym}`, `${sym}1000`];

/** Перші n монет за капіталізацією, для яких є контракт на Bybit. */
export function topUniverse(rows: CapRow[], instruments: LinearInstrument[], n: number): string[] {
  const byBase = new Map(instruments.map((i) => [i.baseCoin.toUpperCase(), i.symbol]));
  const out: string[] = [];
  const sorted = [...rows].sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9));
  for (const row of sorted) {
    if (out.length >= n) break;
    if (!isTradableCoin(row)) continue;
    const symbol = ALIASES(row.symbol.toUpperCase())
      .map((a) => byBase.get(a))
      .find((s) => s !== undefined);
    if (symbol && !out.includes(symbol)) out.push(symbol);
  }
  return out;
}

/** Монети за капіталізацією з CoinGecko: одна сторінка на 100 рядків, цього вистачає на топ-30 без стейблкоїнів. */
export async function marketCaps(fetcher: FetchLike, key?: string): Promise<CapRow[]> {
  const res = await fetcher("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1", {
    // CoinGecko відхиляє запити без User-Agent.
    headers: { accept: "application/json", "user-agent": "trading-assistant/1.0", ...(key ? { "x-cg-demo-api-key": key } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`CoinGecko: HTTP ${res.status}`);
  }
  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows)) throw new Error("CoinGecko: несподівана відповідь");
  return rows.flatMap((r): CapRow[] =>
    r && typeof r.symbol === "string" && typeof r.name === "string"
      ? [{ symbol: r.symbol, name: r.name, current_price: typeof r.current_price === "number" ? r.current_price : null, market_cap_rank: typeof r.market_cap_rank === "number" ? r.market_cap_rank : null }]
      : [],
  );
}
