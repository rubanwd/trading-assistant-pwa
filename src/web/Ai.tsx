import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { callCost, type AgentConfig, type AgentId, type AgentSpec, type AiConfig, type Effort, type ModelInfo } from "../shared/ai";
import { api, c, card, dim, h2, p, primary, secondary } from "./ui";

interface AiState {
  config: AiConfig;
  agents: AgentSpec[];
  models: ModelInfo[];
  modelsError: string | null;
  key: { configured: boolean; info: { usage: number | null; limit: number | null; limitRemaining: number | null; isFreeTier: boolean | null } | null; error: string | null };
  spend: { monthUsd: number; byAgent: Record<string, { usd: number; calls: number }> };
}

const EFFORT_NAME: Record<Effort, string> = {
  default: "як у моделі",
  none: "без міркування",
  minimal: "мінімальне",
  low: "низьке",
  medium: "середнє",
  high: "високе",
  xhigh: "дуже високе",
  max: "максимальне",
};

const input: CSSProperties = {
  minHeight: 44,
  borderRadius: 10,
  border: `1px solid ${c.line}`,
  background: c.bg,
  color: c.ink,
  font: "16px Inter, system-ui, sans-serif",
  padding: "0 12px",
  boxSizing: "border-box",
  width: "100%",
  minWidth: 0,
};

const usd = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(4)}`);
const price = (m: ModelInfo) => `$${m.inputPrice} / $${m.outputPrice} за 1 млн`;

/** Вибір моделі: пошук за назвою й список із цінами. Без каталогу (мережа) лишається поле для ідентифікатора. */
function ModelPicker({
  label,
  value,
  models,
  onChange,
  optional = false,
  error,
}: {
  label: string;
  value: string | null;
  models: ModelInfo[];
  onChange: (v: string | null) => void;
  optional?: boolean;
  error?: string;
}) {
  const [query, setQuery] = useState("");
  const current = models.find((m) => m.id === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : models;
    const top = list.slice(0, 80);
    return current && !top.includes(current) ? [current, ...top] : top;
  }, [models, query, current]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 14 }}>{label}</span>
      {models.length ? (
        <>
          <input aria-label={`${label}: пошук`} placeholder="Пошук: sonnet, gpt, gemini…" value={query} onChange={(e) => setQuery(e.target.value)} style={input} />
          <select aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} style={input}>
            {optional && <option value="">немає</option>}
            {value && !current && <option value={value}>{value} (немає в каталозі)</option>}
            {filtered.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} · ${m.inputPrice}/${m.outputPrice}
              </option>
            ))}
          </select>
          {current && (
            <span style={dim}>
              {current.name} · {price(current)} · контекст {Math.round(current.context / 1000)} тис.
            </span>
          )}
        </>
      ) : (
        <input
          aria-label={label}
          value={value ?? ""}
          placeholder={optional ? "немає" : "автор/модель"}
          onChange={(e) => onChange(e.target.value.trim() || null)}
          style={input}
          spellCheck={false}
        />
      )}
      {error && <span style={{ ...dim, color: c.orange }}>{error}</span>}
    </div>
  );
}

function AgentCard({
  spec,
  value,
  models,
  spend,
  errors,
  onChange,
}: {
  spec: AgentSpec;
  value: AgentConfig;
  models: ModelInfo[];
  spend: { usd: number; calls: number } | undefined;
  errors: Record<string, string>;
  onChange: (v: AgentConfig) => void;
}) {
  const [test, setTest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const model = models.find((m) => m.id === value.model);
  const efforts: Effort[] = ["default", ...(model?.efforts ?? [])];
  const perCall = model ? callCost(model, spec.typicalTokens.input, spec.typicalTokens.output) : null;

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const res = await api<{ ok: boolean; model?: string; latencyMs?: number; costUsd?: number; error?: string }>("/api/ai/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: spec.id, config: value }),
      });
      setTest(res.ok ? `Працює: ${res.model}, ${((res.latencyMs ?? 0) / 1000).toFixed(1)} с, ${usd(res.costUsd ?? 0)}` : `Не працює: ${res.error}`);
    } catch (e) {
      setTest(`Не працює: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={card}>
      <h2 style={h2}>{spec.name}</h2>
      <p style={dim}>{spec.role}</p>
      <ModelPicker
        label="Модель"
        value={value.model}
        models={models}
        error={errors[`${spec.id}.model`]}
        onChange={(m) => {
          const next = models.find((x) => x.id === m);
          const effort = next && value.effort !== "default" && !(next.efforts ?? []).includes(value.effort) ? "default" : value.effort;
          onChange({ ...value, model: m ?? "", effort });
        }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0, fontSize: 14 }}>
          Міркування
          <select value={value.effort} onChange={(e) => onChange({ ...value, effort: e.target.value as Effort })} style={input}>
            {efforts.map((e) => (
              <option key={e} value={e}>
                {EFFORT_NAME[e]}
                {model?.defaultEffort === e ? " (типове)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0, fontSize: 14 }}>
          Ліміт, токенів
          <input
            inputMode="numeric"
            value={String(value.maxTokens)}
            onChange={(e) => onChange({ ...value, maxTokens: Number(e.target.value.replace(/\D/g, "")) || 0 })}
            style={input}
          />
        </label>
      </div>
      {(errors[`${spec.id}.effort`] || errors[`${spec.id}.maxTokens`]) && (
        <span style={{ ...dim, color: c.orange }}>{[errors[`${spec.id}.effort`], errors[`${spec.id}.maxTokens`]].filter(Boolean).join("; ")}</span>
      )}
      <ModelPicker
        label="Запасна модель, якщо основна недоступна"
        value={value.fallback}
        models={models}
        optional
        error={errors[`${spec.id}.fallback`]}
        onChange={(m) => onChange({ ...value, fallback: m })}
      />
      <p style={dim}>
        {perCall !== null && `≈ ${usd(perCall)} за типовий виклик, ≈ ${usd(perCall * spec.callsPerMonth)} на місяць. `}
        {spend ? `Цього місяця: ${usd(spend.usd)} за ${spend.calls} викл.` : "Цього місяця викликів не було."}
      </p>
      <button type="button" style={secondary} disabled={busy || !value.model} onClick={runTest}>
        {busy ? "Перевіряю…" : "Перевірити модель"}
      </button>
      {test && <p style={{ ...dim, color: test.startsWith("Працює") ? c.blue : c.orange }}>{test}</p>}
    </section>
  );
}

export function AiSettings({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<AiState | null>(null);
  const [draft, setDraft] = useState<AiConfig | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<AiState>("/api/ai").then(
      (d) => {
        setState(d);
        setDraft(structuredClone(d.config));
      },
      (e) => setNote(String(e)),
    );
  useEffect(() => {
    void load();
  }, []);

  if (!state || !draft) return <p style={dim}>{note ?? "Завантажую моделі…"}</p>;
  const changed = JSON.stringify(draft) !== JSON.stringify(state.config);
  const monthly = state.agents.reduce((sum, a) => {
    const m = state.models.find((x) => x.id === draft.agents[a.id].model);
    return sum + (m ? callCost(m, a.typicalTokens.input, a.typicalTokens.output) * a.callsPerMonth : 0);
  }, 0);
  const setAgent = (id: AgentId, v: AgentConfig) => setDraft({ ...draft, agents: { ...draft.agents, [id]: v } });

  const save = async () => {
    setBusy(true);
    setNote(null);
    setErrors({});
    try {
      const res = await fetch("/api/ai", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
      const data = (await res.json()) as { error?: string; errors?: Record<string, string> };
      if (!res.ok) {
        setErrors(data.errors ?? {});
        setNote(data.error ?? `HTTP ${res.status}`);
        return;
      }
      await load();
      setNote("Збережено. Наступні виклики підуть на вибрані моделі.");
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  const key = state.key;
  return (
    <>
      <button type="button" style={{ ...secondary, alignSelf: "flex-start" }} onClick={onBack}>← Назад</button>
      <p style={{ ...p, color: c.dim }}>
        Усі агенти працюють через OpenRouter. Модель для кожного вибирається тут; підходять лише моделі, що відповідають JSON за схемою.
      </p>

      <section style={card}>
        <h2 style={h2}>Ключ OpenRouter</h2>
        {!key.configured && (
          <p style={{ ...p, color: c.orange }}>
            Ключ не задано. Створи його на openrouter.ai у розділі Keys і поклади в секрет: <code>npx wrangler secret put OPENROUTER_API_KEY</code>
          </p>
        )}
        {key.error && <p style={{ ...p, color: c.orange }}>{key.error}</p>}
        {key.info && (
          <p style={p}>
            Ключ працює. Використано {key.info.usage === null ? "—" : usd(key.info.usage)} за весь час
            {key.info.limit === null ? ", ліміту на ключі немає." : `, ліміт ${usd(key.info.limit)}, залишок ${usd(key.info.limitRemaining ?? 0)}.`}
          </p>
        )}
        <p style={dim}>Ключ зберігається лише в секретах Cloudflare; застосунок його не бачить.</p>
      </section>

      <section style={card}>
        <h2 style={h2}>Бюджет</h2>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
          Стеля витрат на моделі, $ на місяць
          <input inputMode="decimal" value={String(draft.budgetUsd)} onChange={(e) => setDraft({ ...draft, budgetUsd: Number(e.target.value.replace(",", ".")) || 0 })} style={input} />
        </label>
        {errors.budgetUsd && <span style={{ ...dim, color: c.orange }}>{errors.budgetUsd}</span>}
        <p style={dim}>
          Цього місяця витрачено {usd(state.spend.monthUsd)}. Оцінка для вибраних моделей: ≈ {usd(monthly)} на місяць.
          {monthly > draft.budgetUsd && " Це більше за стелю: наприкінці місяця звіти перейдуть на запасну модель, а сигнали зупиняться."}
        </p>
        <ModelPicker
          label="Модель для звітів після стелі"
          value={draft.budgetFallbackModel}
          models={state.models}
          error={errors.budgetFallbackModel}
          onChange={(m) => setDraft({ ...draft, budgetFallbackModel: m ?? "" })}
        />
        <p style={dim}>Після стелі сортування новин, перевірка сигналів і тижневий розбір зупиняються до наступного місяця.</p>
      </section>

      <section style={card}>
        <h2 style={h2}>Приватність</h2>
        <label style={{ ...p, display: "flex", gap: 10, alignItems: "flex-start" }}>
          <input type="checkbox" checked={draft.dataCollection === "deny"} onChange={(e) => setDraft({ ...draft, dataCollection: e.target.checked ? "deny" : "allow" })} style={{ marginTop: 4 }} />
          <span>Лише провайдери, які не зберігають і не використовують дані запитів. Деякі моделі тоді можуть бути недоступні.</span>
        </label>
      </section>

      {state.modelsError && <p style={{ ...p, color: c.orange }}>Каталог моделей не завантажився ({state.modelsError}). Ідентифікатор можна ввести вручну.</p>}
      {state.agents.map((a) => (
        <AgentCard
          key={a.id}
          spec={a}
          value={draft.agents[a.id]}
          models={state.models}
          spend={state.spend.byAgent[a.id]}
          errors={errors}
          onChange={(v) => setAgent(a.id, v)}
        />
      ))}

      <div style={{ position: "sticky", bottom: 64, display: "flex", flexDirection: "column", gap: 6, background: c.bg, paddingTop: 8 }}>
        {note && <p style={{ ...dim, color: Object.keys(errors).length ? c.orange : c.dim }}>{note}</p>}
        <button type="button" style={primary} disabled={busy || !changed} onClick={save}>
          {changed ? "Зберегти моделі" : "Змін немає"}
        </button>
      </div>
    </>
  );
}
