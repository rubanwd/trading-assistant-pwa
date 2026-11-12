import { describe, expect, it } from "vitest";
import { AGENTS, aiFromSettings, callCost, DEFAULT_AI, validateAi, type AiConfig } from "../src/shared/ai";
import { chatBody, compactModels, LlmError, openRouterTransport, parseChat, parseKeyInfo, stripFences, type LlmRequest } from "../src/worker/llm";

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: "anthropic/claude-sonnet-5.5",
  fallback: null,
  effort: "medium",
  system: "sys",
  user: '{"x":1}',
  schema: { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } },
  maxTokens: 8000,
  dataCollection: "deny",
  ...over,
});

describe("запит до OpenRouter", () => {
  it("JSON-схема, ліміт, міркування, лише провайдери з підтримкою параметрів", () => {
    expect(chatBody(req())).toEqual({
      model: "anthropic/claude-sonnet-5.5",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: '{"x":1}' },
      ],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: req().schema } },
      max_tokens: 8000,
      reasoning: { effort: "medium", exclude: true },
      provider: { require_parameters: true, data_collection: "deny" },
    });
  });

  it("запасна модель іде списком models, а «за замовчуванням» не передає міркування", () => {
    const body = chatBody(req({ fallback: "openai/gpt-5.6-luna", effort: "default", dataCollection: "allow" }));
    expect(body.models).toEqual(["anthropic/claude-sonnet-5.5", "openai/gpt-5.6-luna"]);
    expect("reasoning" in body).toBe(false);
    expect(body.provider.data_collection).toBe("allow");
  });

  it("транспорт шле ключ і розбирає відповідь", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const t = openRouterTransport("sk-or-test", "https://app.example.com", async (url, init) => {
      seen = { url, init };
      return Response.json({
        model: "anthropic/claude-sonnet-5.5",
        choices: [{ finish_reason: "stop", message: { content: '{"a":"b"}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0004 },
      });
    });
    const res = await t(req());
    expect(seen!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = seen!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-or-test");
    expect(headers["http-referer"]).toBe("https://app.example.com");
    expect(res).toEqual({ model: "anthropic/claude-sonnet-5.5", text: '{"a":"b"}', usage: { inputTokens: 100, outputTokens: 20 }, costUsd: 0.0004 });
  });
});

describe("відповідь OpenRouter", () => {
  const ok = (content: string, extra: Record<string, unknown> = {}) => ({ choices: [{ finish_reason: "stop", message: { content } }], ...extra });

  it("знімає обгортку ```json і бере фактичну модель", () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
    expect(parseChat(200, ok("```\n{}\n```", { model: "openai/gpt-5.6-luna" }), "x/y").model).toBe("openai/gpt-5.6-luna");
    expect(parseChat(200, ok("{}"), "x/y")).toMatchObject({ model: "x/y", costUsd: null, usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it("помилки: HTTP, у тілі, у варіанті, обрізання, відмова, порожньо", () => {
    const err = (status: number, body: object) => {
      try {
        parseChat(status, body, "x/y");
        return "ok";
      } catch (e) {
        expect(e).toBeInstanceOf(LlmError);
        return (e as Error).message;
      }
    };
    expect(err(402, { error: { message: "Insufficient credits", code: 402 } })).toBe("OpenRouter 402: Insufficient credits");
    expect(err(200, { error: { message: "No endpoints found that support response_format" } })).toContain("No endpoints");
    expect(err(200, { choices: [{ error: { message: "provider down" } }] })).toBe("OpenRouter: provider down");
    expect(err(200, { choices: [{ finish_reason: "length", message: { content: '{"a":' } }] })).toContain("max_tokens");
    expect(err(200, { choices: [{ finish_reason: "stop", message: { content: null, refusal: "no" } }] })).toBe("модель відмовилась відповідати");
    expect(err(200, { choices: [{ finish_reason: "stop", message: { content: "  " } }] })).toBe("порожня відповідь моделі");
    expect(err(200, {})).toContain("без варіантів");
  });

  it("стан ключа", () => {
    expect(parseKeyInfo({ data: { label: "sk-or-v1-abc", usage: 1.25, limit: 20, limit_remaining: 18.75, is_free_tier: false } })).toEqual({
      label: "sk-or-v1-abc", usage: 1.25, limit: 20, limitRemaining: 18.75, isFreeTier: false,
    });
    expect(parseKeyInfo({ data: { limit: null } })).toMatchObject({ limit: null, usage: null });
  });
});

describe("каталог моделей", () => {
  const raw = [
    {
      id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", context_length: 1_000_000,
      pricing: { prompt: "0.000002", completion: "0.00001" }, top_provider: { max_completion_tokens: 128000 },
      supported_parameters: ["max_tokens", "reasoning", "response_format", "structured_outputs"],
      reasoning: { supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "high", mandatory: true },
    },
    { id: "anthropic/claude-sonnet-5.5:batch", pricing: { prompt: "0.000001", completion: "0.000005" }, supported_parameters: ["structured_outputs"] },
    { id: "some/no-schema", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["max_tokens"] },
    { id: "some/image-only", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["structured_outputs"], architecture: { output_modalities: ["image"] } },
    { id: "a/reasoning-no-efforts", pricing: { prompt: "0.0000001", completion: "0.0000002" }, supported_parameters: ["structured_outputs", "reasoning"] },
    { id: "a/bad-price", pricing: { prompt: "-1", completion: "0" }, supported_parameters: ["structured_outputs"] },
  ];

  it("лише текстові моделі з JSON-схемою, без пакетних варіантів, ціни за 1 млн", () => {
    const m = compactModels(raw);
    expect(m.map((x) => x.id)).toEqual(["a/reasoning-no-efforts", "anthropic/claude-sonnet-5.5"]);
    expect(m[1]).toEqual({
      id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", inputPrice: 2, outputPrice: 10, context: 1_000_000, maxOutput: 128000,
      efforts: ["max", "xhigh", "high", "medium", "low"], defaultEffort: "high",
    });
    expect(m[0]!.efforts).toEqual(["low", "medium", "high"]);
    expect(callCost(m[1]!, 25_000, 3_000)).toBeCloseTo(0.08, 10);
  });
});

describe("налаштування агентів", () => {
  const known = new Set(["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "openai/gpt-5.6-luna"]);
  const config = (over: Partial<AiConfig> = {}): AiConfig => structuredClone({ ...DEFAULT_AI, ...over });

  it("стартові значення коректні й усі моделі є в каталозі", () => {
    expect(validateAi(DEFAULT_AI, known)).toEqual({ ok: true, config: DEFAULT_AI });
    expect(AGENTS.map((a) => a.id)).toEqual(["news", "report", "analyst", "skeptic", "weekly"]);
  });

  it("відхиляє невідому модель, збіг із запасною, поганий ліміт і рівень", () => {
    const c = config();
    c.agents.analyst = { model: "openai/gpt-404", effort: "turbo" as never, maxTokens: 100, fallback: null };
    c.agents.skeptic = { ...c.agents.skeptic, fallback: c.agents.skeptic.model };
    const res = validateAi({ ...c, budgetUsd: 0, dataCollection: "maybe" }, known);
    expect(res.ok).toBe(false);
    expect(Object.keys((res as { errors: object }).errors).sort()).toEqual([
      "analyst.effort", "analyst.maxTokens", "analyst.model", "budgetUsd", "dataCollection", "skeptic.fallback",
    ]);
  });

  it("без каталогу перевіряє лише формат ідентифікатора", () => {
    const c = config();
    c.agents.news = { ...c.agents.news, model: "mistralai/new-model-2026" };
    expect(validateAi(c, null).ok).toBe(true);
    c.agents.news = { ...c.agents.news, model: "not a model" };
    expect(validateAi(c, null).ok).toBe(false);
  });

  it("збирає конфіг із settings і підставляє значення за замовчуванням", () => {
    const ai = aiFromSettings({
      ai_agents: { report: { model: "openai/gpt-5.6-luna", effort: "high", maxTokens: 12000, fallback: "anthropic/claude-sonnet-5.5" }, news: { model: "bad id" } },
      llm_budget_usd: 40,
      ai_data_collection: "allow",
    });
    expect(ai.agents.report).toEqual({ model: "openai/gpt-5.6-luna", effort: "high", maxTokens: 12000, fallback: "anthropic/claude-sonnet-5.5" });
    expect(ai.agents.news).toEqual(DEFAULT_AI.agents.news);
    expect(ai.budgetUsd).toBe(40);
    expect(ai.dataCollection).toBe("allow");
    expect(aiFromSettings({}).dataCollection).toBe("deny");
  });
});
