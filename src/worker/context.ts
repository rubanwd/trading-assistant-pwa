/** Фон ринку для звітів: домінація BTC і капіталізація (CoinGecko), індекс страху і жадібності. */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MarketContext {
  btcDominancePct: number | null;
  totalMarketCapUsd: number | null;
  marketCapChange24hPct: number | null;
  /** 0..100 */
  fearGreed: number | null;
}

async function getJson(fetcher: FetchLike, url: string, headers: Record<string, string> = {}): Promise<unknown> {
  // CoinGecko відхиляє запити без User-Agent.
  const res = await fetcher(url, {
    headers: { accept: "application/json", "user-agent": "trading-assistant/1.0", ...headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${new URL(url).hostname}: HTTP ${res.status}`);
  }
  return res.json();
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** Обидва джерела необов'язкові: збій повертає null у полях і текст у errors. */
export async function marketContext(
  fetcher: FetchLike,
  coingeckoKey?: string,
): Promise<{ context: MarketContext; errors: string[] }> {
  const errors: string[] = [];
  const context: MarketContext = {
    btcDominancePct: null,
    totalMarketCapUsd: null,
    marketCapChange24hPct: null,
    fearGreed: null,
  };
  await Promise.all([
    getJson(
      fetcher,
      "https://api.coingecko.com/api/v3/global",
      coingeckoKey ? { "x-cg-demo-api-key": coingeckoKey } : {},
    )
      .then((raw) => {
        const d = (raw as { data?: Record<string, any> }).data ?? {};
        context.btcDominancePct = num(d.market_cap_percentage?.btc);
        context.totalMarketCapUsd = num(d.total_market_cap?.usd);
        context.marketCapChange24hPct = num(d.market_cap_change_percentage_24h_usd);
      })
      .catch((e) => errors.push(String(e))),
    getJson(fetcher, "https://api.alternative.me/fng/?limit=1")
      .then((raw) => {
        const v = num((raw as { data?: { value?: unknown }[] }).data?.[0]?.value);
        context.fearGreed = v === null ? null : Math.min(100, Math.max(0, v));
      })
      .catch((e) => errors.push(String(e))),
  ]);
  return { context, errors };
}
