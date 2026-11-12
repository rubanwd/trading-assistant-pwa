import { useEffect, useState, type CSSProperties } from "react";
import { SETUP } from "./Signals";
import { api, c, card, day, dim, h2, p, primary, secondary } from "./ui";

interface Spec {
  key: string;
  group: string;
  label: string;
  help?: string;
  kind: "number" | "nullable-number" | "clock" | "quiet" | "report-times" | "symbols" | "macro" | "feeds" | "enum" | "timezone";
  options?: string[];
}

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
};
const area: CSSProperties = { ...input, minHeight: 96, padding: 12, lineHeight: 1.4, resize: "vertical" };

/** Значення з бази → текст для поля форми. */
function toText(kind: Spec["kind"], v: unknown): string {
  switch (kind) {
    case "symbols":
      return Array.isArray(v) ? v.join(", ") : "";
    case "macro":
      return Array.isArray(v)
        ? v
            .map((e) => {
              const at = typeof e === "string" ? e : (e as { at: string }).at;
              const name = typeof e === "string" ? "" : (e as { name?: string }).name ?? "";
              return `${at.slice(0, 16).replace("T", " ")} ${name}`.trim();
            })
            .join("\n")
        : "";
    case "feeds":
      return Array.isArray(v) ? v.map((f) => `${(f as { source: string }).source} ${(f as { url: string }).url}`).join("\n") : "";
    case "quiet":
      return v ? `${(v as { from: string }).from}-${(v as { to: string }).to}` : "";
    case "report-times":
      return `${(v as { morning?: string })?.morning ?? ""}-${(v as { evening?: string })?.evening ?? ""}`;
    default:
      return v === null || v === undefined ? "" : String(v);
  }
}

/** Текст із форми → значення для API. Перевіряє сервер; тут лише розбір. */
function fromText(kind: Spec["kind"], t: string): unknown {
  const text = t.trim();
  switch (kind) {
    case "number":
      return text === "" ? NaN : Number(text.replace(",", "."));
    case "nullable-number":
      return text === "" ? null : Number(text.replace(",", "."));
    case "symbols":
      return text.split(/[\s,;]+/).filter(Boolean);
    case "macro":
      return text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\S*\s*(.*)$/.exec(l);
          return m ? { at: `${m[1]}T${m[2]}:00Z`, name: m[3] } : { at: l, name: "" };
        });
    case "feeds":
      return text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [source, url] = l.split(/\s+/);
          return { source, url };
        });
    case "quiet": {
      if (text === "") return null;
      const [from, to] = text.split("-");
      return { from, to };
    }
    case "report-times": {
      const [morning, evening] = text.split("-");
      return { morning, evening };
    }
    default:
      return text;
  }
}

function Field({ spec, value, error, onChange }: { spec: Spec; value: string; error?: string; onChange: (v: string) => void }) {
  const id = `s-${spec.key}`;
  let control;
  if (spec.kind === "enum") {
    control = (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} style={input}>
        {spec.options?.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (spec.kind === "clock") {
    control = <input id={id} type="time" value={value} onChange={(e) => onChange(e.target.value)} style={input} />;
  } else if (spec.kind === "quiet" || spec.kind === "report-times") {
    const [a = "", b = ""] = value.split("-");
    const off = spec.kind === "quiet" && value === "";
    control = (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {spec.kind === "quiet" && (
          <label style={{ ...dim, display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={!off} onChange={(e) => onChange(e.target.checked ? "23:00-07:00" : "")} />
            увімк.
          </label>
        )}
        <input aria-label={spec.kind === "quiet" ? "Початок" : "Ранковий"} type="time" disabled={off} value={a} onChange={(e) => onChange(`${e.target.value}-${b}`)} style={{ ...input, flex: 1, minWidth: 0, width: "auto" }} />
        <input aria-label={spec.kind === "quiet" ? "Кінець" : "Вечірній"} type="time" disabled={off} value={b} onChange={(e) => onChange(`${a}-${e.target.value}`)} style={{ ...input, flex: 1, minWidth: 0, width: "auto" }} />
      </div>
    );
  } else if (spec.kind === "macro" || spec.kind === "feeds" || spec.kind === "symbols") {
    control = <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} style={area} spellCheck={false} />;
  } else {
    control = (
      <input
        id={id}
        inputMode={spec.kind === "timezone" ? "text" : "decimal"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={input}
      />
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 14 }}>{spec.label}</label>
      {control}
      {spec.help && <span style={dim}>{spec.help}</span>}
      {error && <span style={{ ...dim, color: c.orange }}>{error}</span>}
    </div>
  );
}

function SettingsForm() {
  const [schema, setSchema] = useState<Spec[] | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ values: Record<string, unknown>; schema: Spec[] }>("/api/settings").then((d) => {
      const text = Object.fromEntries(d.schema.map((s) => [s.key, toText(s.kind, d.values[s.key])]));
      setSchema(d.schema);
      setSaved(text);
      setDraft(text);
    }, (e) => setNote(String(e)));
  useEffect(() => {
    void load();
  }, []);

  if (!schema) return <p style={dim}>{note ?? "Завантажую…"}</p>;
  const changed = schema.filter((s) => draft[s.key] !== saved[s.key]);

  const save = async () => {
    setBusy(true);
    setNote(null);
    setErrors({});
    try {
      const body = Object.fromEntries(changed.map((s) => [s.key, fromText(s.kind, draft[s.key] ?? "")]));
      const res = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json()) as { errors?: Record<string, string>; error?: string };
      if (!res.ok) {
        setErrors(data.errors ?? {});
        setNote(data.error ?? `HTTP ${res.status}`);
        return;
      }
      await load();
      setNote("Збережено. Рушій візьме нові значення на наступному запуску.");
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  const groups = [...new Set(schema.map((s) => s.group))];
  return (
    <>
      {groups.map((g) => (
        <section key={g} style={card}>
          <h2 style={h2}>{g}</h2>
          {schema
            .filter((s) => s.group === g)
            .map((s) => (
              <Field key={s.key} spec={s} value={draft[s.key] ?? ""} error={errors[s.key]} onChange={(v) => setDraft({ ...draft, [s.key]: v })} />
            ))}
        </section>
      ))}
      <div style={{ position: "sticky", bottom: 64, display: "flex", flexDirection: "column", gap: 6, background: c.bg, paddingTop: 8 }}>
        {note && <p style={{ ...dim, color: Object.keys(errors).length ? c.orange : c.dim }}>{note}</p>}
        <button type="button" style={primary} disabled={busy || changed.length === 0} onClick={save}>
          {changed.length ? `Зберегти зміни (${changed.length})` : "Змін немає"}
        </button>
      </div>
    </>
  );
}

interface Playbook {
  active: { version: number | null; created_at: string | null; rules: Record<string, string> };
  versions: { version: number; created_at: string; active: number }[];
  nextAllowedAt: string | null;
}

function PlaybookEditor() {
  const [pb, setPb] = useState<Playbook | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<Playbook>("/api/playbook").then((d) => {
      setPb(d);
      setDraft(d.active.rules);
    }, (e) => setNote(String(e)));
  useEffect(() => {
    void load();
  }, []);
  if (!pb) return note ? <p style={dim}>{note}</p> : null;

  const locked = pb.nextAllowedAt !== null && Date.parse(pb.nextAllowedAt) > Date.now();
  const changed = Object.keys(SETUP).some((k) => (draft[k] ?? "") !== (pb.active.rules[k] ?? ""));
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/playbook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rules: draft }) });
      const data = (await res.json()) as { error?: string; version?: number };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      await load();
      setNote(`Версію ${data.version} ввімкнено. Нові сигнали оцінюватимуться за нею.`);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={card}>
      <h2 style={h2}>Правила сетапів · версія {pb.active.version ?? 1}</h2>
      <p style={dim}>
        Аналітик і скептик оцінюють кандидатів за цими правилами. Пропозиції змін дає тижневий розбір, вмикаєш їх ти.
        {pb.nextAllowedAt && (locked ? ` Наступну версію можна ввімкнути з ${day(pb.nextAllowedAt)}.` : " Нову версію вже можна ввімкнути.")}
      </p>
      <p style={dim}>Детектори й рівні рахує код: тут змінюються критерії оцінки, а не те, як знаходяться сетапи.</p>
      {Object.entries(SETUP).map(([k, name]) => (
        <label key={k} style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
          {name}
          <textarea value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} style={{ ...area, minHeight: 140 }} disabled={locked} />
        </label>
      ))}
      {note && <p style={dim}>{note}</p>}
      <button type="button" style={secondary} disabled={busy || locked || !changed} onClick={save}>
        Зберегти як нову версію й увімкнути
      </button>
      {pb.versions.length > 1 && (
        <p style={dim}>Історія: {pb.versions.map((v) => `в${v.version} від ${day(v.created_at)}${v.active ? " (активна)" : ""}`).join(", ")}</p>
      )}
    </section>
  );
}

export function Settings({ onBack, onOpenAi }: { onBack: () => void; onOpenAi: () => void }) {
  return (
    <>
      <button type="button" style={{ ...secondary, alignSelf: "flex-start" }} onClick={onBack}>← Назад</button>
      <p style={{ ...p, color: c.dim }}>Зміни діють без деплою: рушій читає налаштування на кожному запуску.</p>
      <button type="button" onClick={onOpenAi} style={{ ...card, color: c.ink, textAlign: "left", font: "inherit", cursor: "pointer" }}>
        <span style={{ ...p, fontWeight: 600 }}>Моделі ШІ та бюджет →</span>
        <span style={dim}>Модель для кожного агента через OpenRouter, рівень міркування, стеля витрат, приватність.</span>
      </button>
      <SettingsForm />
      <PlaybookEditor />
    </>
  );
}
