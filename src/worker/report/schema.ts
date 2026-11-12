import { CONDITIONS, statement, type Condition, type ForecastRule } from "../forecasts";
import type { ReportKind } from "../time";

export const HORIZONS = [12, 24] as const;

export function reportSchema(symbols: string[]) {
  const text = { type: "string" } as const;
  return {
    type: "object",
    additionalProperties: false,
    required: ["headline", "theses", "regime", "levels", "scenarios", "plan", "review"],
    properties: {
      headline: text,
      theses: { type: "array", items: text },
      regime: text,
      levels: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["symbol", "price", "kind", "note"],
          properties: {
            symbol: { type: "string", enum: symbols },
            price: { type: "number" },
            kind: { type: "string", enum: ["support", "resistance"] },
            note: text,
          },
        },
      },
      scenarios: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description", "probability_pct", "invalidation", "check"],
          properties: {
            title: text,
            description: text,
            probability_pct: { type: "integer" },
            invalidation: text,
            check: {
              type: "object",
              additionalProperties: false,
              required: ["symbol", "condition", "level", "horizon_hours"],
              properties: {
                symbol: { type: "string", enum: symbols },
                condition: { type: "string", enum: [...CONDITIONS] },
                level: { type: "number" },
                horizon_hours: { type: "integer", enum: [...HORIZONS] },
              },
            },
          },
        },
      },
      plan: {
        type: "object",
        additionalProperties: false,
        required: ["do", "avoid"],
        properties: { do: { type: "array", items: text }, avoid: { type: "array", items: text } },
      },
      review: text,
    },
  } as const;
}

export function reportSystem(kind: ReportKind): string {
  const specific =
    kind === "morning"
      ? `Це ранковий звіт: план на день. Поле review залиш порожнім рядком, якщо previous_forecasts порожній; інакше одним-двома реченнями скажи, що з учорашніх сценаріїв збулося.
Для сценаріїв дня став horizon_hours 12, щоб вечірній звіт міг їх перевірити.`
      : `Це вечірній звіт: підсумок дня і план на ніч. У полі review розбери previous_forecasts: які ранкові сценарії збулися, які ні, і який із цього урок. Результати там уже пораховано кодом, не переоцінюй їх.
Для сценаріїв на ніч став horizon_hours 12, для сценаріїв на добу 24.`;
  return `Ти пишеш звіт для трейдера ф'ючерсів, який входить на 1h із контекстом 4h. Пиши українською, стисло й конкретно.
На вході JSON зі знімком ринку. Усі числа в ньому порахував код: не перераховуй їх і не вигадуй цін, яких у знімку немає.
Новини подано полями (категорія, вплив, тон, монети) без заголовків; посилайся на них як на тип події.
${specific}

Що повернути:
- headline: одне речення про головне, до 90 символів. Воно піде в сповіщення.
- theses: рівно три короткі тези для головного екрана.
- regime: 2–3 речення про режим ринку: тренд BTC, ширина ринку, волатильність, фон новин і настрою.
- levels: 4–8 ключових рівнів, передусім BTC і ETH. Ціну бери з levels_1h або levels_4h знімка.
- scenarios: два або три сценарії. Для кожного: назва, опис на 1–2 речення, ймовірність у відсотках (ціле від 5 до 95), рівень скасування словами і перевірка check.
  check має бути однозначною умовою, яку код перевірить за свічками 1h: монета, умова (touch_above, touch_below, close_above, close_below), рівень і горизонт у годинах. Імовірність стосується саме цієї умови.
  Сценарії не мусять у сумі давати 100%, але ймовірності мають бути чесними: 50% означає «не знаю».
- plan.do і plan.avoid: по 2–4 пункти, що робити і чого не робити.

Ти не даєш фінансових порад і не називаєш розмір позиції: його рахує код.`;
}

export interface ReportLevel {
  symbol: string;
  price: number;
  kind: "support" | "resistance";
  note: string;
}

export interface ReportScenario {
  title: string;
  description: string;
  /** 0..1 */
  probability: number;
  invalidation: string;
  /** Правило перевірки; null, якщо код його відхилив. */
  rule: ForecastRule | null;
  statement: string | null;
  resolveAt: string | null;
}

export interface ReportContent {
  headline: string;
  theses: string[];
  regime: string;
  levels: ReportLevel[];
  scenarios: ReportScenario[];
  plan: { do: string[]; avoid: string[] };
  review: string;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter(Boolean).slice(0, maxItems) : [];

/** Рівень прогнозу має лежати не далі цієї частки від поточної ціни, інакше перевірка беззмістовна. */
export const MAX_LEVEL_DISTANCE = 0.25;

export interface SanitizeContext {
  /** Поточні ціни монет зі знімка. */
  prices: Map<string, number>;
  now: number;
  /** Підпис дедлайну для твердження, наприклад «19:30 12.11». */
  deadlineLabel: (resolveAt: number) => string;
}

/**
 * Перевірка відповіді кодом: обрізає довжини, тримає ймовірності в межах 5–95%,
 * відкидає рівні й перевірки для невідомих монет або з неправдоподібною ціною.
 * Кидає помилку, якщо звіт непридатний (немає заголовка чи сценаріїв).
 */
export function sanitizeReport(raw: unknown, ctx: SanitizeContext): ReportContent {
  const r = (raw ?? {}) as Record<string, any>;
  const plausible = (symbol: unknown, level: unknown): level is number => {
    const price = typeof symbol === "string" ? ctx.prices.get(symbol) : undefined;
    return (
      price !== undefined &&
      typeof level === "number" &&
      Number.isFinite(level) &&
      level > 0 &&
      Math.abs(level - price) / price <= MAX_LEVEL_DISTANCE
    );
  };

  const levels: ReportLevel[] = (Array.isArray(r.levels) ? r.levels : [])
    .filter((l: any) => plausible(l?.symbol, l?.price) && (l.kind === "support" || l.kind === "resistance"))
    .slice(0, 8)
    .map((l: any) => ({ symbol: l.symbol, price: l.price, kind: l.kind, note: str(l.note, 200) }));

  const scenarios: ReportScenario[] = (Array.isArray(r.scenarios) ? r.scenarios : [])
    .slice(0, 3)
    .map((s: any): ReportScenario | null => {
      const title = str(s?.title, 120);
      const pct = typeof s?.probability_pct === "number" && Number.isFinite(s.probability_pct) ? s.probability_pct : NaN;
      if (!title || Number.isNaN(pct)) return null;
      const c = s.check ?? {};
      const valid =
        plausible(c.symbol, c.level) &&
        CONDITIONS.includes(c.condition as Condition) &&
        HORIZONS.includes(c.horizon_hours);
      const resolveAt = valid ? ctx.now + c.horizon_hours * 3_600_000 : null;
      const rule: ForecastRule | null = valid
        ? { v: 1, symbol: c.symbol, condition: c.condition, level: c.level, from: new Date(ctx.now).toISOString(), title }
        : null;
      return {
        title,
        description: str(s.description, 500),
        probability: Math.min(95, Math.max(5, Math.round(pct))) / 100,
        invalidation: str(s.invalidation, 300),
        rule,
        statement: rule && resolveAt ? statement(rule, ctx.deadlineLabel(resolveAt)) : null,
        resolveAt: resolveAt ? new Date(resolveAt).toISOString() : null,
      };
    })
    .filter((s: ReportScenario | null): s is ReportScenario => s !== null);

  const headline = str(r.headline, 140);
  if (!headline || scenarios.length === 0) throw new Error("звіт моделі без заголовка або сценаріїв");
  return {
    headline,
    theses: list(r.theses, 3, 240),
    regime: str(r.regime, 800),
    levels,
    scenarios,
    plan: { do: list(r.plan?.do, 4, 240), avoid: list(r.plan?.avoid, 4, 240) },
    review: str(r.review, 1200),
  };
}
