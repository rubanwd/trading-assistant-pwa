/**
 * Статистика для пошуку закономірностей. Чисті функції.
 *
 * Спостереження не незалежні: сусідні свічки 4h мають спільне майбутнє, а 15 монет рухаються разом із BTC.
 * Тому похибка середнього рахується з кластерами за часом (усі монети в одному 2-денному відрізку — один кластер),
 * а не як для незалежних точок: інакше «значущим» виглядало б майже все.
 */

export interface CellStat {
  n: number;
  /** Кількість кластерів (незалежних відрізків часу). */
  clusters: number;
  /** Середній рух, ATR. */
  mean: number;
  /** Кластерна похибка середнього. */
  se: number;
  /** Середній результат лонга і шорта після комісій, R. */
  long: number;
  short: number;
}

/** Накопичувач середнього з кластерною похибкою. Значення мають надходити впорядкованими за кластером. */
export class ClusterMean {
  n = 0;
  sum = 0;
  longSum = 0;
  shortSum = 0;
  private s2 = 0;
  private sn = 0;
  private n2 = 0;
  private g = 0;
  private cur = Number.NaN;
  private cs = 0;
  private cn = 0;

  add(cluster: number, x: number, long: number, short: number): void {
    if (cluster !== this.cur) {
      this.flush();
      this.cur = cluster;
    }
    this.cs += x;
    this.cn++;
    this.n++;
    this.sum += x;
    this.longSum += long;
    this.shortSum += short;
  }

  private flush(): void {
    if (!this.cn) return;
    this.s2 += this.cs * this.cs;
    this.sn += this.cs * this.cn;
    this.n2 += this.cn * this.cn;
    this.g++;
    this.cs = 0;
    this.cn = 0;
  }

  stat(): CellStat {
    this.flush();
    this.cur = Number.NaN;
    const n = this.n;
    const mean = n ? this.sum / n : 0;
    const g = this.g;
    // Σ_c (S_c − n_c·m)² / n², з поправкою g/(g−1) на мале число кластерів.
    const v = n && g > 1 ? (Math.max(0, this.s2 - 2 * mean * this.sn + mean * mean * this.n2) / (n * n)) * (g / (g - 1)) : Number.NaN;
    return { n, clusters: g, mean, se: Math.sqrt(v), long: n ? this.longSum / n : 0, short: n ? this.shortSum / n : 0 };
  }
}

/** Функція розподілу стандартного нормального (Abramowitz–Stegun 7.1.26, похибка < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export const twoSided = (z: number) => 2 * (1 - normalCdf(Math.abs(z)));
export const oneSided = (z: number) => 1 - normalCdf(z);

/**
 * Поправка Бенджаміні — Гохберга на множинні перевірки: які з гіпотез відкинути, щоб частка хибних відкриттів не перевищила q.
 * Повертає маску того ж порядку, що й p.
 */
export function benjaminiHochberg(p: number[], q: number): boolean[] {
  const order = p.map((v, i) => [v, i] as const).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0]);
  const m = order.length;
  let k = -1;
  order.forEach(([v], i) => {
    if (v <= ((i + 1) / m) * q) k = i;
  });
  const out = new Array<boolean>(p.length).fill(false);
  for (let i = 0; i <= k; i++) out[order[i]![1]] = true;
  return out;
}
