/**
 * Агенти й налаштування моделей. Моделі викликаються через OpenRouter; для кожного агента
 * модель, рівень міркування й ліміт відповіді вибираються на сторінці «Моделі ШІ».
 * Спільне для рушія (виклики), API (перевірка) і застосунку (форма).
 */

export const AGENT_IDS = ["news", "report", "analyst", "skeptic", "weekly"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Рівні міркування OpenRouter. "default" означає не передавати параметр: модель вирішує сама. */
export const EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface AgentSpec {
  id: AgentId;
  name: string;
  role: string;
  defaultModel: string;
  defaultEffort: Effort;
  defaultMaxTokens: number;
  /** Типовий виклик для оцінки вартості: токени на вхід і вихід. */
  typicalTokens: { input: number; output: number };
  /** Скільки викликів приблизно буває на місяць. */
  callsPerMonth: number;
}

export const AGENTS: AgentSpec[] = [
  {
    id: "news",
    name: "Сортувальник новин",
    role: "Перетворює заголовки новин на поля: монети, вплив, тон, релевантність. Працює щопів години на нових заголовках.",
    defaultModel: "anthropic/claude-haiku-5.5",
    defaultEffort: "low",
    defaultMaxTokens: 8000,
    typicalTokens: { input: 4000, output: 2500 },
    callsPerMonth: 1440,
  },
  {
    id: "report",
    name: "Автор звітів",
    role: "Пише ранковий і вечірній звіт: режим ринку, рівні, сценарії з імовірностями.",
    defaultModel: "anthropic/claude-sonnet-5.5",
    defaultEffort: "medium",
    defaultMaxTokens: 16000,
    typicalTokens: { input: 25000, output: 3000 },
    callsPerMonth: 60,
  },
  {
    id: "analyst",
    name: "Аналітик сигналу",
    role: "Оцінює кандидата, знайденого кодом: вердикт «брати чи ні» і ймовірність дійти до цілі.",
    defaultModel: "anthropic/claude-sonnet-5.5",
    defaultEffort: "medium",
    defaultMaxTokens: 8000,
    typicalTokens: { input: 6000, output: 700 },
    callsPerMonth: 180,
  },
  {
    id: "skeptic",
    name: "Скептик",
    role: "Шукає аргументи проти кандидата й дає власну ймовірність. Не бачить відповіді аналітика.",
    defaultModel: "anthropic/claude-sonnet-5.5",
    defaultEffort: "medium",
    defaultMaxTokens: 8000,
    typicalTokens: { input: 6000, output: 700 },
    callsPerMonth: 120,
  },
  {
    id: "weekly",
    name: "Тижневий розбір",
    role: "У неділю пояснює статистику тижня й пропонує зміни правил.",
    defaultModel: "anthropic/claude-opus-5.5",
    defaultEffort: "high",
    defaultMaxTokens: 16000,
    typicalTokens: { input: 30000, output: 3000 },
    callsPerMonth: 4,
  },
];

export interface AgentConfig {
  model: string;
  effort: Effort;
  maxTokens: number;
  /** Запасна модель, якщо основна недоступна (OpenRouter перемикає сам). */
  fallback: string | null;
}

export interface AiConfig {
  agents: Record<AgentId, AgentConfig>;
  /** Місячна стеля витрат, $. */
  budgetUsd: number;
  /** Модель для звітів після стелі; сортування новин і перевірка сигналів тоді зупиняються. */
  budgetFallbackModel: string;
  /** "deny": лише провайдери, що не зберігають дані запитів. */
  dataCollection: "allow" | "deny";
}

export const DEFAULT_AI: AiConfig = {
  agents: Object.fromEntries(
    AGENTS.map((a) => [a.id, { model: a.defaultModel, effort: a.defaultEffort, maxTokens: a.defaultMaxTokens, fallback: null }]),
  ) as Record<AgentId, AgentConfig>,
  budgetUsd: 25,
  budgetFallbackModel: "anthropic/claude-haiku-5.5",
  dataCollection: "deny",
};

/** Ключі таблиці settings, у яких лежить AiConfig. */
export const AI_KEYS = {
  agents: "ai_agents",
  budgetUsd: "llm_budget_usd",
  budgetFallbackModel: "ai_budget_fallback_model",
  dataCollection: "ai_data_collection",
} as const;

/** Ідентифікатор моделі OpenRouter: автор/назва, можливо з варіантом після двокрапки. */
export const MODEL_ID = /^[a-z0-9][\w.-]{0,60}\/[\w.-]{1,100}(:[\w.-]{1,30})?$/i;

/** Збирає конфіг із рядків settings; бракує чогось — береться значення за замовчуванням. */
export function aiFromSettings(values: Record<string, unknown>): AiConfig {
  const saved = (values[AI_KEYS.agents] ?? {}) as Partial<Record<AgentId, Partial<AgentConfig>>>;
  const agents = Object.fromEntries(
    AGENTS.map((a) => {
      const s = saved[a.id] ?? {};
      return [
        a.id,
        {
          model: typeof s.model === "string" && MODEL_ID.test(s.model) ? s.model : a.defaultModel,
          effort: EFFORTS.includes(s.effort as Effort) ? (s.effort as Effort) : a.defaultEffort,
          maxTokens: typeof s.maxTokens === "number" && s.maxTokens >= 256 ? Math.min(s.maxTokens, 64000) : a.defaultMaxTokens,
          fallback: typeof s.fallback === "string" && MODEL_ID.test(s.fallback) ? s.fallback : null,
        },
      ];
    }),
  ) as Record<AgentId, AgentConfig>;
  const budget = values[AI_KEYS.budgetUsd];
  const fallback = values[AI_KEYS.budgetFallbackModel];
  return {
    agents,
    budgetUsd: typeof budget === "number" && budget > 0 ? budget : DEFAULT_AI.budgetUsd,
    budgetFallbackModel: typeof fallback === "string" && MODEL_ID.test(fallback) ? fallback : DEFAULT_AI.budgetFallbackModel,
    dataCollection: values[AI_KEYS.dataCollection] === "allow" ? "allow" : "deny",
  };
}

/**
 * Перевіряє конфіг із форми. known: моделі з каталогу OpenRouter, що підтримують JSON-схему;
 * якщо каталогу немає (мережа), перевіряється лише формат ідентифікатора.
 */
export function validateAi(raw: unknown, known: Set<string> | null): { ok: true; config: AiConfig } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const r = (raw ?? {}) as Partial<AiConfig>;
  const model = (key: string, v: unknown, nullable = false): string | null => {
    if (nullable && (v === null || v === "")) return null;
    if (typeof v !== "string" || !MODEL_ID.test(v)) {
      errors[key] = "ідентифікатор моделі OpenRouter, наприклад anthropic/claude-sonnet-5.5";
      return null;
    }
    if (known && !known.has(v)) {
      errors[key] = `модель ${v} не знайдено серед моделей OpenRouter із підтримкою JSON-схеми`;
      return null;
    }
    return v;
  };
  const agents = {} as Record<AgentId, AgentConfig>;
  for (const a of AGENTS) {
    const s = (r.agents?.[a.id] ?? {}) as Partial<AgentConfig>;
    const m = model(`${a.id}.model`, s.model);
    const fb = model(`${a.id}.fallback`, s.fallback ?? null, true);
    if (fb !== null && fb === m) errors[`${a.id}.fallback`] = "запасна модель збігається з основною";
    if (!EFFORTS.includes(s.effort as Effort)) errors[`${a.id}.effort`] = "невідомий рівень міркування";
    const max = s.maxTokens;
    if (typeof max !== "number" || !Number.isInteger(max) || max < 256 || max > 64000) errors[`${a.id}.maxTokens`] = "ціле від 256 до 64000";
    agents[a.id] = { model: m ?? a.defaultModel, effort: (s.effort as Effort) ?? a.defaultEffort, maxTokens: max ?? a.defaultMaxTokens, fallback: fb };
  }
  if (typeof r.budgetUsd !== "number" || !Number.isFinite(r.budgetUsd) || r.budgetUsd < 1 || r.budgetUsd > 500) errors.budgetUsd = "від 1 до 500";
  const budgetFallbackModel = model("budgetFallbackModel", r.budgetFallbackModel);
  if (r.dataCollection !== "allow" && r.dataCollection !== "deny") errors.dataCollection = "allow або deny";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    config: { agents, budgetUsd: r.budgetUsd!, budgetFallbackModel: budgetFallbackModel!, dataCollection: r.dataCollection! },
  };
}

/** Модель із каталогу OpenRouter у стиснутому вигляді для форми й розрахунку вартості. */
export interface ModelInfo {
  id: string;
  name: string;
  /** $ за 1 млн токенів. */
  inputPrice: number;
  outputPrice: number;
  context: number;
  maxOutput: number | null;
  /** Рівні міркування, які приймає модель; null, якщо модель не дає ними керувати. */
  efforts: Effort[] | null;
  defaultEffort: Effort | null;
}

/** Вартість одного виклику за ціною моделі, $. */
export const callCost = (m: Pick<ModelInfo, "inputPrice" | "outputPrice">, input: number, output: number) =>
  (input * m.inputPrice + output * m.outputPrice) / 1_000_000;
