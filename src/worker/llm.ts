import { callCost, type AgentConfig, type AgentId, type AiConfig, type Effort, type ModelInfo } from "../shared/ai";

/**
 * Виклики моделей через OpenRouter (Chat Completions). Модель не має інструментів
 * і завжди відповідає JSON за схемою (response_format json_schema, strict).
 */

export const OPENROUTER = "https://openrouter.ai/api/v1";

export type Pipeline = "news" | "morning_report" | "evening_report" | "analyst" | "skeptic" | "weekly_review" | "test";

/** Який агент обслуговує конвеєр. */
export const PIPELINE_AGENT: Record<Exclude<Pipeline, "test">, AgentId> = {
  news: "news",
  morning_report: "report",
  evening_report: "report",
  analyst: "analyst",
  skeptic: "skeptic",
  weekly_review: "weekly",
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Ціна для моделі без відомої вартості: навмисно висока, щоб не занизити витрати проти стелі. */
const FALLBACK_PRICE = { inputPrice: 15, outputPrice: 75 };

/**
 * Вартість виклику: те, що повернув OpenRouter (usage.cost), інакше за ціною з каталогу,
 * інакше за консервативною ціною.
 */
export function costUsd(reported: number | null, usage: Usage, price: Pick<ModelInfo, "inputPrice" | "outputPrice"> | null): number {
  if (reported !== null && Number.isFinite(reported) && reported >= 0) return reported;
  return callCost(price ?? FALLBACK_PRICE, usage.inputTokens, usage.outputTokens);
}

/** Початок поточного місяця в UTC, ISO: з нього рахується місячна стеля. */
export function monthStart(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export type BudgetDecision = { allowed: true; agent: AgentConfig } | { allowed: false; reason: string };

/**
 * Перевірка стелі перед викликом. Поки стелю не вичерпано, працює модель агента.
 * Після стелі звіти пише запасна дешева модель; сортування новин, перевірка сигналів,
 * тижневий розбір і пробні виклики зупиняються до наступного місяця.
 */
export function decideModel(pipeline: Exclude<Pipeline, "test">, spentUsd: number, ai: AiConfig): BudgetDecision {
  const agent = ai.agents[PIPELINE_AGENT[pipeline]];
  if (spentUsd < ai.budgetUsd) return { allowed: true, agent };
  if (pipeline === "morning_report" || pipeline === "evening_report") {
    return { allowed: true, agent: { ...agent, model: ai.budgetFallbackModel, effort: "default", fallback: null } };
  }
  return { allowed: false, reason: `стелю $${ai.budgetUsd} вичерпано` };
}

export interface LlmRequest {
  model: string;
  fallback: string | null;
  effort: Effort;
  system: string;
  user: string;
  /** JSON-схема відповіді. */
  schema: Record<string, unknown>;
  maxTokens: number;
  dataCollection: "allow" | "deny";
}

export interface LlmResponse {
  /** Модель, яка фактично відповіла (могла спрацювати запасна). */
  model: string;
  text: string;
  usage: Usage;
  /** Вартість від OpenRouter, $; null, якщо не повідомлено. */
  costUsd: number | null;
}

export type Transport = (req: LlmRequest) => Promise<LlmResponse>;

export class LlmError extends Error {}

/** Тіло запиту до /chat/completions. Окремо, щоб перевірити тестом. */
export function chatBody(req: LlmRequest) {
  return {
    model: req.model,
    ...(req.fallback ? { models: [req.model, req.fallback] } : {}),
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: req.schema } },
    max_tokens: req.maxTokens,
    ...(req.effort === "default" ? {} : { reasoning: { effort: req.effort, exclude: true } }),
    // Лише провайдери, що підтримують JSON-схему; за бажанням без тих, хто зберігає дані.
    provider: { require_parameters: true, data_collection: req.dataCollection },
  };
}

/** Деякі моделі загортають JSON у ```json … ``` навіть зі схемою. */
export function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  return m ? m[1]! : t;
}

interface ChatResponse {
  model?: string;
  error?: { message?: string; code?: number | string };
  choices?: { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null }; error?: { message?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

/** Розбір відповіді OpenRouter: помилки, обрізання, відмова, текст і вартість. */
export function parseChat(status: number, body: ChatResponse, requested: string): LlmResponse {
  if (status >= 400 || body.error) {
    throw new LlmError(`OpenRouter ${status}: ${body.error?.message ?? "невідома помилка"}`);
  }
  const choice = body.choices?.[0];
  if (!choice) throw new LlmError("OpenRouter: відповідь без варіантів");
  if (choice.error) throw new LlmError(`OpenRouter: ${choice.error.message ?? "помилка провайдера"}`);
  if (choice.message?.refusal) throw new LlmError("модель відмовилась відповідати");
  if (choice.finish_reason === "length") throw new LlmError("відповідь обрізано за max_tokens: збільш ліміт для агента");
  const text = stripFences(choice.message?.content ?? "");
  if (!text) throw new LlmError("порожня відповідь моделі");
  return {
    model: body.model ?? requested,
    text,
    usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
    costUsd: typeof body.usage?.cost === "number" ? body.usage.cost : null,
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function openRouterTransport(apiKey: string, appOrigin?: string, fetcher: FetchLike = (i, init) => fetch(i, init)): Transport {
  return async (req) => {
    let res: Response;
    try {
      res = await fetcher(`${OPENROUTER}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "x-title": "Trading Assistant",
          ...(appOrigin ? { "http-referer": appOrigin } : {}),
        },
        body: JSON.stringify(chatBody(req)),
        signal: AbortSignal.timeout(240_000),
      });
    } catch (e) {
      throw new LlmError(`OpenRouter недоступний: ${String(e)}`);
    }
    const body = (await res.json().catch(() => ({ error: { message: `HTTP ${res.status}, не JSON` } }))) as ChatResponse;
    return parseChat(res.status, body, req.model);
  };
}

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  architecture?: { output_modalities?: string[] };
  reasoning?: { supported_efforts?: string[] | null; default_effort?: string; mandatory?: boolean };
}

/**
 * Каталог OpenRouter → моделі, придатні для агентів: текстова відповідь, підтримка JSON-схеми,
 * відома ціна. Пакетні варіанти (:batch) не працюють у звичайних запитах і відкидаються.
 */
export function compactModels(raw: RawModel[]): ModelInfo[] {
  const efforts = new Set<string>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  return raw
    .filter(
      (m) =>
        (m.supported_parameters ?? []).includes("structured_outputs") &&
        !m.id.endsWith(":batch") &&
        (m.architecture?.output_modalities ?? ["text"]).includes("text") &&
        Number.isFinite(Number(m.pricing?.prompt)) &&
        Number.isFinite(Number(m.pricing?.completion)) &&
        Number(m.pricing?.prompt) >= 0,
    )
    .map((m) => {
      const supported = m.reasoning?.supported_efforts?.filter((e) => efforts.has(e)) as Effort[] | undefined;
      const hasReasoning = (m.supported_parameters ?? []).includes("reasoning");
      return {
        id: m.id,
        name: m.name ?? m.id,
        inputPrice: Number((Number(m.pricing!.prompt) * 1_000_000).toFixed(4)),
        outputPrice: Number((Number(m.pricing!.completion) * 1_000_000).toFixed(4)),
        context: m.context_length ?? 0,
        maxOutput: m.top_provider?.max_completion_tokens ?? null,
        efforts: supported?.length ? supported : hasReasoning ? (["low", "medium", "high"] as Effort[]) : null,
        defaultEffort: (m.reasoning?.default_effort as Effort | undefined) ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface KeyInfo {
  label: string | null;
  /** Використано за весь час, $. */
  usage: number | null;
  /** Ліміт ключа, $; null, якщо без ліміту. */
  limit: number | null;
  limitRemaining: number | null;
  isFreeTier: boolean | null;
}

export function parseKeyInfo(body: unknown): KeyInfo {
  const d = ((body as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    label: typeof d.label === "string" ? d.label : null,
    usage: num(d.usage),
    limit: num(d.limit),
    limitRemaining: num(d.limit_remaining),
    isFreeTier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : null,
  };
}
