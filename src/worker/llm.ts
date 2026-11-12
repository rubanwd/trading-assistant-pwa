import Anthropic from "@anthropic-ai/sdk";

/** Моделі за ролями. Тижневий розбір (Opus через Batch API) з'явиться на етапі статистики. */
export const MODELS = {
  news: "claude-haiku-5-5",
  report: "claude-sonnet-5-5",
} as const;

export type Pipeline = "news" | "morning_report" | "evening_report" | "analyst" | "skeptic";
export type Effort = "low" | "medium" | "high";

/** Ціни за 1 млн токенів, $: вхід і вихід. */
const PRICES: [prefix: string, input: number, output: number][] = [
  ["claude-haiku-5-5", 0.1, 0.5],
  ["claude-sonnet-5", 2, 10],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus", 5, 25],
];
/** Невідому модель (наприклад, запасну після відмови) рахуємо за найдорожчим тарифом, щоб не занизити витрати. */
const FALLBACK_PRICE: [number, number] = [5, 25];

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export function costUsd(model: string, usage: Usage): number {
  const row = PRICES.find(([prefix]) => model.startsWith(prefix));
  const [input, output] = row ? [row[1], row[2]] : FALLBACK_PRICE;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
}

/** Початок поточного місяця в UTC, ISO: з нього рахується місячна стеля. */
export function monthStart(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export type BudgetDecision = { allowed: true; model: string } | { allowed: false; reason: string };

/**
 * Перевірка стелі перед викликом. Поки стелю не вичерпано, працює модель ролі.
 * Після стелі звіти пише Haiku; сортування новин і перевірка сигналів зупиняються до наступного місяця,
 * тож нові сигнали не публікуються.
 */
export function decideModel(pipeline: Pipeline, spentUsd: number, budgetUsd: number): BudgetDecision {
  if (spentUsd < budgetUsd) return { allowed: true, model: pipeline === "news" ? MODELS.news : MODELS.report };
  if (pipeline === "morning_report" || pipeline === "evening_report") return { allowed: true, model: MODELS.news };
  return { allowed: false, reason: `стелю $${budgetUsd} вичерпано` };
}

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  /** JSON-схема відповіді для output_config.format. */
  schema: Record<string, unknown>;
  maxTokens: number;
  effort: Effort;
}

export interface LlmResponse {
  /** Модель, яка фактично відповіла. */
  model: string;
  text: string;
  usage: Usage;
}

export type Transport = (req: LlmRequest) => Promise<LlmResponse>;

export class LlmError extends Error {}

/**
 * Виклик Claude API. Модель не має інструментів і відповідає JSON за схемою.
 * Для Sonnet увімкнено серверний запасний маршрут на випадок відмови класифікатора безпеки.
 */
export function anthropicTransport(apiKey: string): Transport {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 180_000 });
  return async (req) => {
    const withFallback = req.model.startsWith("claude-sonnet-5-5");
    const res = await client.beta.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
      ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    if (res.stop_reason === "refusal") throw new LlmError("модель відмовилась відповідати");
    if (res.stop_reason === "max_tokens") throw new LlmError("відповідь обрізано за max_tokens");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text) throw new LlmError("порожня відповідь моделі");
    return {
      model: res.model,
      text,
      usage: {
        inputTokens:
          res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0),
        outputTokens: res.usage.output_tokens,
      },
    };
  };
}
