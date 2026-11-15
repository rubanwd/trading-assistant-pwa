import { stopDistancePct } from "../../shared/risk";
import type { MarketRegime } from "../regime";
import { compactSymbol, type NewsField } from "../report/input";
import type { Snapshot } from "../snapshot";
import { ENTRY_BARS, EXIT_BARS, STOP_ATR } from "./detectors";
import { SETUP_NAME, type Candidate, type SetupId } from "./types";

/** Правила сетапів за замовчуванням. Лягають у playbook_versions; нові версії вмикає людина. */
export const PLAYBOOK_DEFAULT: Record<SetupId, string> = {
  trend_breakout:
    `Трендовий пробій 4h. Свічка 4h закрилась вище максимуму ${ENTRY_BARS} попередніх свічок і вище EMA200 4h (для шорта дзеркально). ` +
    `Вхід за ринком після закриття, початковий стоп ${STOP_ATR} ATR(14) 4h від входу, цілі немає: позицію закриває стоп або закриття 4h нижче мінімуму ${EXIT_BARS} попередніх свічок. ` +
    "Більшість угод закривається невеликим збитком, результат дають рідкі довгі тренди. Слабкі ознаки: ціна вже далеко від EMA200 після тривалого руху, вузький канал перед пробоєм на низькому обсязі, перегрітий фандинг у бік угоди, відкритий інтерес падає, тренд 1d і BTC проти угоди, новини високого впливу проти угоди.",
};

export interface ReviewArgs {
  candidate: Candidate;
  rule: string;
  snapshot: Snapshot;
  btc: Snapshot | null;
  market: MarketRegime;
  news: NewsField[];
  minutesToMacro: number | null;
}

/**
 * Вхід для аналітика і скептика. Обидва бачать той самий JSON:
 * кандидата з рівнями від коду, правило сетапу, знімок ознак і поля новин. Сирих свічок і заголовків тут немає.
 */
export function reviewInput(a: ReviewArgs) {
  const c = a.candidate;
  return {
    candidate: {
      symbol: c.symbol,
      side: c.side,
      setup: c.setup,
      setup_name: SETUP_NAME[c.setup],
      entry: c.entry,
      stop: c.stop,
      one_r_level: Number((c.entry + (c.entry - c.stop)).toPrecision(6)),
      stop_distance_pct: Number(stopDistancePct(c.entry, c.stop).toFixed(2)),
      exit_rule: `закриття 4h за ${c.side === "long" ? "мінімумом" : "максимумом"} ${EXIT_BARS} попередніх свічок`,
      measurements: c.facts,
    },
    setup_rule: a.rule,
    symbol: compactSymbol(a.snapshot),
    btc: a.btc && a.btc.symbol !== c.symbol ? compactSymbol(a.btc) : null,
    market: { mood: a.market.mood, btc_trend_4h: a.market.btcTrend, share_above_ema200_4h: a.market.breadth },
    news_last_12h: a.news,
    minutes_to_macro_event: a.minutesToMacro,
  };
}

const COMMON = `На вході JSON: кандидат на угоду, знайдений кодом, правило сетапу, знімок ринку та поля новин.
Усі рівні й числа порахував код: не змінюй їх, не пропонуй інших рівнів і не називай розмір позиції.
Імовірність означає одне: до закриття позиції (стопом або виходом за каналом) ціна хоча б раз дійде до one_r_level, тобто пройде від входу в бік угоди на відстань стопа. Це ціле число відсотків від 5 до 95.
Орієнтир: у бектесті так було в 42–52% угод цього сетапу. Не завищуй і не занижуй без конкретної причини.
Пиши українською, коротко, по одному факту на пункт.`;

export const ANALYST_SYSTEM = `Ти аналітик сигналів для трейдера ф'ючерсів (трендові пробої на 4h, вхід за ринком, вихід за каналом).
${COMMON}
Оціни, чи відповідає кандидат правилу сетапу і чи підтримує його контекст: тренд, режим ринку, фандинг, відкритий інтерес, новини.
Поверни:
- verdict: take, якщо сетап чистий і контекст не проти; skip, якщо є вагома причина не брати.
- probability_pct: твоя ймовірність.
- summary: одне речення з головною причиною вердикту.
- arguments_for: 2–4 аргументи за.
- arguments_against: 1–3 аргументи проти (вони є завжди).
- invalidation: що на графіку скасує ідею ще до стопа чи виходу за каналом.`;

export const SKEPTIC_SYSTEM = `Ти скептик: твоя робота шукати причини, чому ця угода не спрацює.
${COMMON}
Ти не знаєш думки інших і оцінюєш кандидата самостійно. Шукай слабкі ознаки з правила сетапу, конфлікти між таймфреймами, хибний пробій, близькі сильні рівні в бік угоди, ризики з новин і настрою ринку.
Якщо вагомих заперечень немає, чесно дай високу ймовірність: занижувати її без причини так само погано, як завищувати.
Поверни:
- probability_pct: твоя ймовірність.
- strongest_risk: одне речення про головний ризик.
- arguments_against: 2–4 аргументи проти.`;

const text = { type: "string" } as const;
const texts = { type: "array", items: text } as const;

export const ANALYST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "probability_pct", "summary", "arguments_for", "arguments_against", "invalidation"],
  properties: {
    verdict: { type: "string", enum: ["take", "skip"] },
    probability_pct: { type: "integer" },
    summary: text,
    arguments_for: texts,
    arguments_against: texts,
    invalidation: text,
  },
} as const;

export const SKEPTIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["probability_pct", "strongest_risk", "arguments_against"],
  properties: { probability_pct: { type: "integer" }, strongest_risk: text, arguments_against: texts },
} as const;

export interface AnalystView {
  verdict: "take" | "skip";
  /** 0..1 */
  probability: number;
  summary: string;
  argumentsFor: string[];
  argumentsAgainst: string[];
  invalidation: string;
}

export interface SkepticView {
  /** 0..1 */
  probability: number;
  strongestRisk: string;
  argumentsAgainst: string[];
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 240)).filter(Boolean).slice(0, 4) : []);
/** Імовірність у межах 5–95%; нечислова відповідь є помилкою, а не нулем. */
function probability(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("модель не дала ймовірності");
  return Math.min(95, Math.max(5, Math.round(v))) / 100;
}

export function sanitizeAnalyst(raw: unknown): AnalystView {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.verdict !== "take" && r.verdict !== "skip") throw new Error("аналітик не дав вердикту");
  return {
    verdict: r.verdict,
    probability: probability(r.probability_pct),
    summary: str(r.summary, 300),
    argumentsFor: list(r.arguments_for),
    argumentsAgainst: list(r.arguments_against),
    invalidation: str(r.invalidation, 300),
  };
}

export function sanitizeSkeptic(raw: unknown): SkepticView {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { probability: probability(r.probability_pct), strongestRisk: str(r.strongest_risk, 300), argumentsAgainst: list(r.arguments_against) };
}

export type Decision = { publish: true } | { publish: false; by: "analyst" | "skeptic" };

/** Сигнал публікується, коли аналітик сказав «брати», а скептик дав імовірність не нижче порога. */
export function decide(analyst: AnalystView, skeptic: SkepticView | null, threshold: number): Decision {
  if (analyst.verdict !== "take") return { publish: false, by: "analyst" };
  if (!skeptic || skeptic.probability < threshold) return { publish: false, by: "skeptic" };
  return { publish: true };
}

/** Пояснення в signals.reasoning. */
export interface Reasoning {
  v: 1;
  facts: Record<string, number>;
  analyst: AnalystView;
  skeptic: SkepticView | null;
  rejectedBy: "analyst" | "skeptic" | null;
}
