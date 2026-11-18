import { BINS, DIRECTIONAL, FEATURES, type Feature, type Row } from "./features";
import { benjaminiHochberg, ClusterMean, oneSided, twoSided, type CellStat } from "./stats";

/**
 * Пошук закономірностей: для кожної ознаки та кожної пари ознак, кожного квінтиля, по всіх монетах разом і по кожній окремо
 * рахується середній рух ціни далі і порівнюється з базою (усі свічки того ж зрізу за той самий період).
 * Шукаємо на навчальному періоді з поправкою на множинні перевірки, підтверджуємо на тестовому, якого пошук не бачив.
 */

export const ALL = "ALL";

export interface SearchConfig {
  /** Межа між навчальним і тестовим періодами, мс UTC. */
  split: number;
  horizonHours: number;
  /** Бар'єри і одиниця руху, ATR 4h. */
  barrier: number;
  /** Частка хибних відкриттів (Бенджаміні — Гохберг). */
  q: number;
  /** Найменше спостережень і кластерів у клітинці на навчальному і тестовому періодах. */
  minN: number;
  minClusters: number;
  minTestN: number;
  minTestClusters: number;
  /** Довжина кластера за часом, мс. */
  clusterMs: number;
}

export const DEFAULT_SEARCH: Omit<SearchConfig, "split"> = {
  horizonHours: 24,
  barrier: 1,
  q: 0.05,
  minN: 150,
  minClusters: 40,
  minTestN: 60,
  minTestClusters: 20,
  clusterMs: 2 * 24 * 3_600_000,
};

export interface Condition {
  feature: Feature;
  bin: number;
}

export interface PeriodStat extends CellStat {
  /** Середній рух мінус база зрізу, ATR. */
  effect: number;
  z: number;
  p: number;
}

export interface Pattern {
  slice: string;
  conditions: Condition[];
  side: "long" | "short";
  train: PeriodStat;
  test: PeriodStat | null;
  /** Для пар: на скільки ефект сильніший за сильнішу з двох одиночних умов (навчання, тест). */
  lift: { train: number; test: number | null } | null;
  /** Для ALL: на скількох монетах ефект на тесті в тому ж напрямку. */
  coins: { agree: number; total: number } | null;
  confirmed: boolean;
  /** Чому не підтверджено. */
  reason: string | null;
}

/**
 * Родина перевірок для поправки на множинні перевірки. Поправка йде окремо в кожній родині, щоб кілька десятків
 * загальних умов по всіх монетах не тонули серед тисяч пар по окремих монетах.
 */
export type Family = "all_single" | "all_pair" | "coin_single" | "coin_pair";
export const FAMILIES: Family[] = ["all_single", "all_pair", "coin_single", "coin_pair"];
export const familyOf = (slice: string, conditions: number): Family =>
  `${slice === ALL ? "all" : "coin"}_${conditions === 1 ? "single" : "pair"}` as Family;

export interface SearchResult {
  slices: string[];
  tested: number;
  /** Скільки перевірено, знайдено на навчанні й підтверджено в кожній родині. */
  families: Record<Family, { tested: number; discovered: number; confirmed: number }>;
  discovered: Pattern[];
  confirmed: Pattern[];
  base: Record<string, { train: CellStat; test: CellStat }>;
  /** Статистика клітинки за періодом: 0 — навчання, 1 — тест, 2 — увесь час. */
  cell(slice: string, conditions: Condition[], period: 0 | 1 | 2): CellStat | null;
  rows: { train: number; test: number };
}

const F = FEATURES.length;
const PAIRS: [number, number][] = [];
for (let a = 0; a < F; a++) for (let b = a + 1; b < F; b++) PAIRS.push([a, b]);
const PAIR_INDEX = new Map(PAIRS.map(([a, b], i) => [a * F + b, i]));
const SINGLES = F * BINS;
export const CELLS = SINGLES + PAIRS.length * BINS * BINS;

function cellIndex(conds: Condition[]): number {
  const fi = (c: Condition) => FEATURES.indexOf(c.feature);
  if (conds.length === 1) return fi(conds[0]!) * BINS + conds[0]!.bin;
  let [x, y] = conds as [Condition, Condition];
  if (fi(x) > fi(y)) [x, y] = [y, x];
  return SINGLES + PAIR_INDEX.get(fi(x) * F + fi(y))! * BINS * BINS + x.bin * BINS + y.bin;
}

function cellConditions(idx: number): Condition[] {
  if (idx < SINGLES) return [{ feature: FEATURES[Math.floor(idx / BINS)]!, bin: idx % BINS }];
  const k = idx - SINGLES;
  const [a, b] = PAIRS[Math.floor(k / (BINS * BINS))]!;
  const r = k % (BINS * BINS);
  return [
    { feature: FEATURES[a]!, bin: Math.floor(r / BINS) },
    { feature: FEATURES[b]!, bin: r % BINS },
  ];
}

function merge(a: CellStat, b: CellStat): CellStat {
  const n = a.n + b.n;
  const w = (x: number, y: number) => (n ? (x * a.n + y * b.n) / n : 0);
  return { n, clusters: a.clusters + b.clusters, mean: w(a.mean, b.mean), se: Number.NaN, long: w(a.long, b.long), short: w(a.short, b.short) };
}

export function searchPatterns(rows: Row[], cfg: SearchConfig): SearchResult {
  const symbols = [...new Set(rows.map((r) => r.symbol))].sort();
  const slices = [ALL, ...symbols];
  const sliceOf = new Map(symbols.map((s, i) => [s, i + 1]));
  const acc: ClusterMean[][][] = [0, 1].map(() => slices.map(() => []));
  const base: ClusterMean[][] = [0, 1].map(() => slices.map(() => new ClusterMean()));
  const get = (p: number, s: number, i: number) => (acc[p]![s]![i] ??= new ClusterMean());
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const horizon = cfg.horizonHours * 3_600_000;
  const count = { train: 0, test: 0 };

  for (const r of sorted) {
    // Навчальні рядки, чий горизонт заходить у тестовий період, відкидаються, щоб періоди не перетинались.
    const period = r.t >= cfg.split ? 1 : r.t + horizon <= cfg.split ? 0 : -1;
    if (period < 0) continue;
    count[period ? "test" : "train"]++;
    const cluster = Math.floor(r.t / cfg.clusterMs);
    for (const s of [0, sliceOf.get(r.symbol)!]) {
      base[period]![s]!.add(cluster, r.move, r.longNet, r.shortNet);
      for (let a = 0; a < F; a++) {
        const ba = r.bins[a]!;
        if (ba < 0) continue;
        get(period, s, a * BINS + ba).add(cluster, r.move, r.longNet, r.shortNet);
        for (let b = a + 1; b < F; b++) {
          const bb = r.bins[b]!;
          if (bb < 0) continue;
          get(period, s, SINGLES + PAIR_INDEX.get(a * F + b)! * BINS * BINS + ba * BINS + bb).add(cluster, r.move, r.longNet, r.shortNet);
        }
      }
    }
  }

  const stats: (CellStat | null)[][][] = acc.map((p) => p.map((s) => Array.from({ length: CELLS }, (_, i) => s[i]?.stat() ?? null)));
  const baseStats = base.map((p) => p.map((b) => b.stat()));
  const withEffect = (st: CellStat, b: CellStat): PeriodStat => {
    const effect = st.mean - b.mean;
    const z = effect / st.se;
    return { ...st, effect, z, p: Number.isFinite(z) ? twoSided(z) : 1 };
  };

  // Навчання: кожна клітинка з достатньою кількістю даних — окрема перевірка.
  const tests: { s: number; i: number; train: PeriodStat }[] = [];
  slices.forEach((_, s) => {
    for (let i = 0; i < CELLS; i++) {
      const st = stats[0]![s]![i];
      if (!st || st.n < cfg.minN || st.clusters < cfg.minClusters) continue;
      tests.push({ s, i, train: withEffect(st, baseStats[0]![s]!) });
    }
  });
  const famOf = (s: number, i: number) => familyOf(slices[s]!, i < SINGLES ? 1 : 2);
  /** Поправка Бенджаміні — Гохберга окремо в кожній родині. */
  const byFamily = <T>(items: T[], fam: (x: T) => Family, p: (x: T) => number): boolean[] => {
    const out = new Array<boolean>(items.length).fill(false);
    for (const f of FAMILIES) {
      const idx = items.map((x, k) => [x, k] as const).filter(([x]) => fam(x) === f);
      const pass = benjaminiHochberg(idx.map(([x]) => p(x)), cfg.q);
      idx.forEach(([, k], j) => (out[k] = pass[j]!));
    }
    return out;
  };
  const passTrain = byFamily(tests, (t) => famOf(t.s, t.i), (t) => t.train.p);
  const found = tests.filter((_, k) => passTrain[k]);

  // Тест: та сама клітинка на періоді, якого пошук не бачив, в тому ж напрямку.
  const testStat = (s: number, i: number): PeriodStat | null => {
    const st = stats[1]![s]![i];
    if (!st || st.n < cfg.minTestN || st.clusters < cfg.minTestClusters) return null;
    return withEffect(st, baseStats[1]![s]!);
  };
  const testP = found.map((f) => {
    const t = testStat(f.s, f.i);
    return t && Number.isFinite(t.z) ? oneSided(t.z * Math.sign(f.train.effect)) : 1;
  });
  const passTest = byFamily(found.map((f, k) => ({ f, k })), (x) => famOf(x.f.s, x.f.i), (x) => testP[x.k]!);

  const discovered: Pattern[] = found.map((f, k) => {
    const conditions = cellConditions(f.i);
    const sign = Math.sign(f.train.effect);
    const side = sign > 0 ? "long" : "short";
    const test = testStat(f.s, f.i);
    let lift: Pattern["lift"] = null;
    if (conditions.length === 2) {
      const single = (p: 0 | 1, c: Condition) => {
        const st = stats[p]![f.s]![cellIndex([c])];
        return st ? sign * (st.mean - baseStats[p]![f.s]!.mean) : 0;
      };
      const best = (p: 0 | 1) => Math.max(single(p, conditions[0]!), single(p, conditions[1]!));
      lift = { train: sign * f.train.effect - best(0), test: test ? sign * test.effect - best(1) : null };
    }
    let coins: Pattern["coins"] = null;
    if (f.s === 0) {
      let agree = 0;
      let total = 0;
      for (let s = 1; s < slices.length; s++) {
        const st = stats[1]![s]![f.i];
        if (!st || st.n < 20) continue;
        total++;
        if (Math.sign(st.mean - baseStats[1]![s]!.mean) === sign) agree++;
      }
      coins = { agree, total };
    }
    const sideTest = test ? (side === "long" ? test.long : test.short) : null;
    let reason: string | null = null;
    if (!test) reason = "мало даних на тесті";
    else if (!passTest[k]) reason = Math.sign(test.effect) === sign ? "на тесті слабше, не значуще" : "на тесті у протилежний бік";
    else if (lift && (lift.train <= 0 || (lift.test ?? 0) <= 0)) reason = "не сильніша за одну з умов окремо";
    else if (sideTest === null || sideTest <= 0) reason = "на тесті угода в цей бік не окупає комісій";
    return { slice: slices[f.s]!, conditions, side, train: f.train, test, lift, coins, confirmed: reason === null, reason };
  });

  const order = (a: Pattern, b: Pattern) => Math.abs(b.test?.effect ?? 0) - Math.abs(a.test?.effect ?? 0);
  const families = Object.fromEntries(FAMILIES.map((f) => [f, { tested: 0, discovered: 0, confirmed: 0 }])) as SearchResult["families"];
  for (const t of tests) families[famOf(t.s, t.i)].tested++;
  for (const p of discovered) {
    const f = families[familyOf(p.slice, p.conditions.length)];
    f.discovered++;
    if (p.confirmed) f.confirmed++;
  }
  return {
    slices,
    tested: tests.length,
    families,
    discovered: discovered.sort(order),
    confirmed: discovered.filter((p) => p.confirmed).sort(order),
    base: Object.fromEntries(slices.map((s, i) => [s, { train: baseStats[0]![i]!, test: baseStats[1]![i]! }])),
    cell(slice, conditions, period) {
      const s = slices.indexOf(slice);
      if (s < 0) return null;
      const i = cellIndex(conditions);
      if (period < 2) return stats[period]![s]![i] ?? null;
      const a = stats[0]![s]![i];
      const b = stats[1]![s]![i];
      return a && b ? merge(a, b) : (a ?? b ?? null);
    },
    rows: count,
  };
}

/** Угода трендового пробою з бектесту: лише те, що потрібно для розбору за ознаками. */
export interface TradeLike {
  symbol: string;
  side: "long" | "short";
  createdAt: number;
  netR: number | null;
}

export interface GroupStat {
  n: number;
  mean: number;
  se: number;
}

export interface BreakoutSplit {
  feature: Feature;
  /** Для ознак з напрямом квінтилі шортів дзеркаляться: «високе» значить «у бік угоди». */
  directional: boolean;
  train: { low: GroupStat; mid: GroupStat; high: GroupStat; diff: number; z: number };
  test: { low: GroupStat; mid: GroupStat; high: GroupStat; diff: number; z: number };
  candidate: boolean;
}

function group(values: number[]): GroupStat {
  const n = values.length;
  const mean = n ? values.reduce((s, v) => s + v, 0) / n : 0;
  const varr = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : Number.NaN;
  return { n, mean, se: Math.sqrt(varr / n) };
}

/**
 * Чи залежить результат трендового пробою від ознак на момент сигналу: нижні 40%, середина і верхні 40% кожної ознаки,
 * різниця «верхні мінус нижні» на навчанні і тесті. Кандидат у фільтр — різниця в тому самому напрямку на обох періодах.
 */
export function breakoutSplits(trades: TradeLike[], rows: Row[], split: number, q = 0.1): BreakoutSplit[] {
  const byKey = new Map(rows.map((r) => [`${r.symbol}|${r.t}`, r]));
  const joined = trades
    .filter((t): t is TradeLike & { netR: number } => t.netR !== null)
    .map((t) => ({ t, row: byKey.get(`${t.symbol}|${t.createdAt}`) }))
    .filter((x): x is { t: TradeLike & { netR: number }; row: Row } => x.row !== undefined);
  const out = FEATURES.map((feature, k) => {
    const directional = DIRECTIONAL.has(feature);
    const period = (p: 0 | 1) => {
      const g: number[][] = [[], [], []];
      for (const { t, row } of joined) {
        if ((t.createdAt >= split ? 1 : 0) !== p) continue;
        let b = row.bins[k]!;
        if (b < 0) continue;
        if (directional && t.side === "short") b = BINS - 1 - b;
        g[b <= 1 ? 0 : b === 2 ? 1 : 2]!.push(t.netR);
      }
      const [low, mid, high] = g.map(group) as [GroupStat, GroupStat, GroupStat];
      const diff = high.mean - low.mean;
      return { low, mid, high, diff, z: diff / Math.sqrt(high.se ** 2 + low.se ** 2) };
    };
    return { feature, directional, train: period(0), test: period(1), candidate: false };
  });
  const pass = benjaminiHochberg(out.map((s) => (Number.isFinite(s.train.z) ? twoSided(s.train.z) : 1)), q);
  out.forEach((s, i) => {
    s.candidate = pass[i]! && Number.isFinite(s.test.z) && Math.sign(s.test.diff) === Math.sign(s.train.diff) && Math.abs(s.test.z) >= 1.64;
  });
  return out;
}
