import { BIN_LABEL, BINS, FEATURE_LABEL, FEATURES, type Feature } from "./features";
import { ALL, FAMILIES, type BreakoutSplit, type Condition, type Family, type Pattern, type SearchConfig, type SearchResult } from "./patterns";

const FAMILY_LABEL: Record<Family, string> = {
  all_single: "усі монети, одна умова",
  all_pair: "усі монети, пара умов",
  coin_single: "окремі монети, одна умова",
  coin_pair: "окремі монети, пара умов",
};

/** Текстовий звіт дослідження закономірностей. */

const sgn = (v: number, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}` : "—");
const sliceName = (s: string) => (s === ALL ? "усі монети" : s.replace(/USDT$/, ""));
const SIDE = { long: "ЛОНГ ▲", short: "ШОРТ ▼" };

export const conditionText = (c: Condition[]) => c.map((x) => `${FEATURE_LABEL[x.feature]}: ${BIN_LABEL[x.bin]}`).join(" + ");

function patternLines(p: Pattern, i: number): string[] {
  const side = (s: { long: number; short: number }) => sgn(p.side === "long" ? s.long : s.short);
  const train = `навчання: n ${p.train.n}, рух ${sgn(p.train.effect)}R від бази (z ${sgn(p.train.z, 1)}), угода ${side(p.train)}R`;
  const test = p.test
    ? `тест: n ${p.test.n}, рух ${sgn(p.test.effect)}R (z ${sgn(p.test.z, 1)}), угода ${side(p.test)}R`
    : "тест: мало даних";
  const extra = [
    p.coins ? `в тому ж напрямку на тесті на ${p.coins.agree} з ${p.coins.total} монет` : null,
    p.lift ? `приріст над однією умовою ${sgn(p.lift.train)} / ${p.lift.test === null ? "—" : sgn(p.lift.test)}R` : null,
    p.reason,
  ].filter(Boolean);
  return [
    `${String(i + 1).padStart(3)}. [${sliceName(p.slice)}] ${conditionText(p.conditions)} → ${SIDE[p.side]}`,
    `       ${train}`,
    `       ${test}`,
    ...(extra.length ? [`       ${extra.join("; ")}`] : []),
  ];
}

/** Сітка 5×5 для двох ознак по одній монеті: середній рух від бази за весь час і кількість. */
export function focusGrid(r: SearchResult, slice: string, a: Feature, b: Feature): string[] {
  if (!r.slices.includes(slice)) return [`\n${slice}: немає даних`];
  const base = r.base[slice]!;
  const baseMean = (base.train.mean * base.train.n + base.test.mean * base.test.n) / (base.train.n + base.test.n || 1);
  const head = `${"".padEnd(14)}${BIN_LABEL.map((l) => l.padStart(15)).join("")}`;
  const lines = [`\n${sliceName(slice)}: рядки — ${FEATURE_LABEL[a]}, стовпці — ${FEATURE_LABEL[b]}`, `рух від бази, R (кількість свічок 4h), увесь період`, head];
  for (let x = BINS - 1; x >= 0; x--) {
    const cells = Array.from({ length: BINS }, (_, y) => {
      const st = r.cell(slice, [{ feature: a, bin: x }, { feature: b, bin: y }], 2);
      return (st && st.n ? `${sgn(st.mean - baseMean)} (${st.n})` : "—").padStart(15);
    });
    lines.push(`${BIN_LABEL[x]!.padEnd(14)}${cells.join("")}`);
  }
  const corner = [{ feature: a, bin: BINS - 1 }, { feature: b, bin: BINS - 1 }];
  for (const [name, p] of [["навчання", 0], ["тест", 1]] as const) {
    const st = r.cell(slice, corner, p);
    const bm = p ? base.test.mean : base.train.mean;
    if (st && st.n)
      lines.push(
        `Обидві у верхніх 20%, ${name}: n ${st.n}, рух ${sgn(st.mean - bm)}R від бази (z ${sgn((st.mean - bm) / st.se, 1)}), лонг ${sgn(st.long)}R, шорт ${sgn(st.short)}R`,
      );
  }
  return lines;
}

/** Огляд: рух від бази по квінтилях кожної ознаки, усі монети разом, навчання / тест. */
export function overviewLines(r: SearchResult): string[] {
  const b = r.base[ALL]!;
  const lines = [`${"".padEnd(44)}${BIN_LABEL.map((l) => l.padStart(14)).join("")}`];
  for (const f of FEATURES) {
    const cells = Array.from({ length: BINS }, (_, bin) => {
      const tr = r.cell(ALL, [{ feature: f, bin }], 0);
      const te = r.cell(ALL, [{ feature: f, bin }], 1);
      const v = (st: typeof tr, m: number) => (st && st.n ? sgn(st.mean - m) : "—");
      return `${v(tr, b.train.mean)}/${v(te, b.test.mean)}`.padStart(14);
    });
    lines.push(`${FEATURE_LABEL[f].padEnd(44)}${cells.join("")}`);
  }
  return lines;
}

function breakoutLines(splits: BreakoutSplit[]): string[] {
  const g = (x: { n: number; mean: number }) => `${sgn(x.mean)} (${x.n})`;
  const lines = [`${"".padEnd(46)}${"навчання: нижні 40% / середина / верхні 40%".padEnd(52)}тест`];
  for (const s of splits) {
    const label = `${FEATURE_LABEL[s.feature]}${s.directional ? " *" : ""}`;
    const tr = `${g(s.train.low)} / ${g(s.train.mid)} / ${g(s.train.high)}  z ${sgn(s.train.z, 1)}`;
    const te = `${g(s.test.low)} / ${g(s.test.mid)} / ${g(s.test.high)}  z ${sgn(s.test.z, 1)}`;
    lines.push(`${s.candidate ? "► " : "  "}${label.padEnd(44)}${tr.padEnd(52)}${te}`);
  }
  lines.push("* для шортів квінтилі дзеркальні: «верхні» значить «у бік угоди» (для шорта — падіння, низький фандинг тощо).");
  lines.push("► різниця «верхні мінус нижні» значуща на навчанні й повторилась на тесті: кандидат у фільтр пробоїв.");
  return lines;
}

export interface ReportMeta {
  from: string;
  to: string;
  split: string;
  symbols: number;
  takerPct: number;
  focus: { slice: string; a: Feature; b: Feature }[];
}

export function formatResearch(r: SearchResult, splits: BreakoutSplit[] | null, cfg: SearchConfig, meta: ReportMeta): string {
  const b = r.base[ALL]!;
  const rejected = r.discovered.filter((p) => !p.confirmed).sort((x, y) => Math.abs(y.train.z) - Math.abs(x.train.z));
  const byReason = new Map<string, number>();
  for (const p of rejected) byReason.set(p.reason!, (byReason.get(p.reason!) ?? 0) + 1);
  return [
    `Закономірності в історії: ${meta.from} — ${meta.to}, монет ${meta.symbols}, горизонт ${cfg.horizonHours} год, бар'єри ±${cfg.barrier} ATR`,
    `Навчання до ${meta.split} (${r.rows.train} закриттів 4h по монетах), тест з ${meta.split} (${r.rows.test}).`,
    `Рух — в одиницях бар'єра (${cfg.barrier} ATR 4h): +1 — ціна спершу пройшла бар'єр угору, −1 — униз. ` +
      `Угода — лонг чи шорт за ринком зі стопом і ціллю на бар'єрах, R після комісій taker ${meta.takerPct}% на вході й виході.`,
    `База по всіх монетах: навчання рух ${sgn(b.train.mean)}, лонг ${sgn(b.train.long)}R, шорт ${sgn(b.train.short)}R; ` +
      `тест рух ${sgn(b.test.mean)}, лонг ${sgn(b.test.long)}R, шорт ${sgn(b.test.short)}R.`,
    `\nПеревірено клітинок: ${r.tested} (одна умова або пара умов; усі монети разом і кожна окремо).`,
    `Поправка на множинні перевірки окремо в кожній родині (частка хибних відкриттів ${cfg.q}):`,
    ...FAMILIES.map((f) => {
      const x = r.families[f];
      return `   ${FAMILY_LABEL[f].padEnd(28)} перевірено ${String(x.tested).padStart(6)}, значущих на навчанні ${String(x.discovered).padStart(4)}, підтвердились на тесті ${String(x.confirmed).padStart(3)}`;
    }),
    `Значущих на навчанні разом: ${r.discovered.length} (до ~${Math.ceil(r.discovered.length * cfg.q)} з них можуть бути випадковими).`,
    `Підтвердились на тесті: ${r.confirmed.length}.` +
      (byReason.size ? ` Не підтвердились: ${[...byReason].map(([k, v]) => `${k} — ${v}`).join(", ")}.` : ""),
    `\n1. Підтверджені закономірності (за силою на тесті)`,
    ...(r.confirmed.length ? r.confirmed.slice(0, 40).flatMap(patternLines) : ["   немає"]),
    ...(r.confirmed.length > 40 ? [`   … ще ${r.confirmed.length - 40} у patterns.json`] : []),
    `\n2. Найсильніші на навчанні, що не підтвердились на тесті`,
    ...(rejected.length ? rejected.slice(0, 12).flatMap(patternLines) : ["   немає"]),
    `\n3. Огляд: рух від бази по квінтилях кожної ознаки, усі монети, навчання/тест, R`,
    ...overviewLines(r),
    `\n4. Окремі пари ознак`,
    ...meta.focus.flatMap((f) => focusGrid(r, f.slice, f.a, f.b)),
    ...(splits ? [`\n5. Трендовий пробій за ознаками на момент сигналу: середній R угоди після комісій (кількість)`, ...breakoutLines(splits)] : []),
    `\nРух у R — це результат угоди до комісій (стоп і ціль на бар'єрах): ±0.05R слабко, але на сотнях угод помітно. ` +
      `Ефект на тесті зазвичай слабший, ніж на навчанні: на навчанні він завищений самим відбором.`,
  ].join("\n");
}
