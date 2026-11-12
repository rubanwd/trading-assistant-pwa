import { entryMid } from "../../shared/risk";
import type { MarketRegime } from "../regime";
import { compactSymbol, type NewsField } from "../report/input";
import type { Snapshot } from "../snapshot";
import { SETUP_NAME, type Candidate, type SetupId } from "./types";

/** Правила сетапів, версія 1. Лягає в playbook_versions; нові версії вмикає людина. */
export const PLAYBOOK_V1: Record<SetupId, string> = {
  trend_pullback:
    "Відкат у тренді. Тренд 4h у бік угоди, 1d не проти. На 1h EMA20 з боку тренду від EMA50; після імпульсу щонайменше 1.5 ATR ціна повернулась до EMA20, втрималась за EMA50 і закрила свічку в бік тренду; RSI 35–60 (для шорта дзеркально). Вхід від закриття свічки на 0.5 ATR углиб, але не далі EMA50; стоп за екстремумом відкату з запасом 0.3 ATR. Слабкі ознаки: третій і пізніший відкат без оновлення екстремуму, відкат глибший за 3 ATR, перегрітий фандинг у бік угоди, відкритий інтерес падає разом із ціною.",
  breakout_retest:
    "Пробій із ретестом. Рівень із двома й більше дотиками тримав ціну щонайменше 20 свічок 1h; ціна закрилась за ним, не поверталась закриттям назад і зараз тестує рівень з іншого боку. Вхід від рівня до 0.5 ATR за ним, стоп за мінімумом після пробою з запасом. Слабкі ознаки: пробій на обсязі нижче середнього, пробій проти тренду 1d, близький сильний рівень на шляху до цілі, відкритий інтерес не росте.",
  liquidity_sweep:
    "Зняття ліквідності з поверненням. Свічка 1h проколола тінню розворотний екстремум, який раніше не пробивали закриттям, і закрилась назад; тінь займає щонайменше 40% свічки. Вхід від рівня до закриття, стоп за тінню з запасом 0.3 ATR. Слабкі ознаки: тренд 4h проти угоди сильний, прокол на новинах високого впливу, це вже другий прокол того самого рівня, ціль ближча за протилежний край діапазону.",
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
  const mid = entryMid(c.entryLow, c.entryHigh);
  return {
    candidate: {
      symbol: c.symbol,
      side: c.side,
      setup: c.setup,
      setup_name: SETUP_NAME[c.setup],
      entry_low: c.entryLow,
      entry_high: c.entryHigh,
      stop: c.stop,
      target_1: c.tp1,
      target_2: c.tp2,
      risk_reward: c.rr,
      stop_distance_pct: Number(((Math.abs(mid - c.stop) / mid) * 100).toFixed(2)),
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
Імовірність означає одне: ціна дійде до target_1 раніше, ніж до stop, після входу в зоні. Це ціле число відсотків від 5 до 95.
Орієнтир: за R:R 2 беззбитковість настає на 33%. Не завищуй: більшість технічних сетапів має 35–55%.
Пиши українською, коротко, по одному факту на пункт.`;

export const ANALYST_SYSTEM = `Ти аналітик сигналів для трейдера ф'ючерсів (вхід на 1h, контекст 4h).
${COMMON}
Оціни, чи відповідає кандидат правилу сетапу і чи підтримує його контекст: тренд, режим ринку, фандинг, відкритий інтерес, новини.
Поверни:
- verdict: take, якщо сетап чистий і контекст не проти; skip, якщо є вагома причина не брати.
- probability_pct: твоя ймовірність.
- summary: одне речення з головною причиною вердикту.
- arguments_for: 2–4 аргументи за.
- arguments_against: 1–3 аргументи проти (вони є завжди).
- invalidation: що на графіку скасує ідею ще до стопа.`;

export const SKEPTIC_SYSTEM = `Ти скептик: твоя робота шукати причини, чому ця угода не спрацює.
${COMMON}
Ти не знаєш думки інших і оцінюєш кандидата самостійно. Шукай слабкі ознаки з правила сетапу, конфлікти між таймфреймами, перешкоди на шляху до цілі, ризики з новин і настрою ринку.
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
