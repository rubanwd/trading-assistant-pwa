import type { Stats } from "./stats";

/** Тижневий розбір: код рахує цифри, Opus пояснює їх і пропонує зміни правил; вмикає зміни людина. */

export const PROPOSAL_TARGETS = ["trend_pullback", "breakout_retest", "liquidity_sweep", "filter", "general"] as const;

export const WEEKLY_SYSTEM = `Ти розбираєш тиждень роботи системи торгових сигналів для трейдера ф'ючерсів (вхід на 1h, контекст 4h).
На вході JSON: статистика тижня й усього часу, яку порахував код, активні правила сетапів, налаштування фільтра і нотатки трейдера з журналу.
Пиши українською, коротко і конкретно. Не перераховуй цифри й не вигадуй тих, яких немає у вході.
Вибірка мала: до кількох десятків сигналів висновки ненадійні. Кажи про це прямо і не підганяй правила під один тиждень.
Порівнюй результат із простим утриманням BTC за той самий період і з беззбитковістю після комісій.
Калібрування: порівняй прогнозовані ймовірності аналітика, скептика і звітів із тим, як часто події справді збувались; бал Браєра 0.25 відповідає вгадуванню.
Відхилені моделлю кандидати мають тіньовий результат: якщо він кращий за опубліковані сигнали, фільтр моделі шкодить.

Поверни:
- headline: одне речення про головне за тиждень, до 100 символів.
- summary: 2–4 речення.
- working: 1–3 пункти, що працює.
- failing: 1–3 пункти, що не працює.
- calibration: 1–2 речення про калібрування.
- proposals: 0–3 пропозиції змін. Для кожної: target (сетап, filter або general), change (що саме змінити в правилі чи порозі), reason (чому, з посиланням на цифри), evidence (на скільки сигналах це видно).
  Пропонуй зміну лише тоді, коли цифри на неї вказують. Порожній список теж нормальна відповідь.
- next_week: 1–3 пункти, на що дивитися наступного тижня.`;

const text = { type: "string" } as const;
const texts = { type: "array", items: text } as const;

export const WEEKLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "working", "failing", "calibration", "proposals", "next_week"],
  properties: {
    headline: text,
    summary: text,
    working: texts,
    failing: texts,
    calibration: text,
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target", "change", "reason", "evidence"],
        properties: { target: { type: "string", enum: [...PROPOSAL_TARGETS] }, change: text, reason: text, evidence: text },
      },
    },
    next_week: texts,
  },
} as const;

export interface WeeklyReview {
  headline: string;
  summary: string;
  working: string[];
  failing: string[];
  calibration: string;
  proposals: { target: (typeof PROPOSAL_TARGETS)[number]; change: string; reason: string; evidence: string }[];
  nextWeek: string[];
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => str(x, 300)).filter(Boolean).slice(0, n) : []);

export function sanitizeWeekly(raw: unknown): WeeklyReview {
  const r = (raw ?? {}) as Record<string, unknown>;
  const headline = str(r.headline, 140);
  if (!headline) throw new Error("розбір без заголовка");
  return {
    headline,
    summary: str(r.summary, 1200),
    working: list(r.working, 3),
    failing: list(r.failing, 3),
    calibration: str(r.calibration, 600),
    proposals: (Array.isArray(r.proposals) ? r.proposals : [])
      .filter((p): p is Record<string, unknown> => !!p && PROPOSAL_TARGETS.includes((p as { target?: never }).target as never))
      .slice(0, 3)
      .map((p) => ({ target: p.target as WeeklyReview["proposals"][number]["target"], change: str(p.change, 500), reason: str(p.reason, 500), evidence: str(p.evidence, 300) }))
      .filter((p) => p.change),
    nextWeek: list(r.next_week, 3),
  };
}

/** Вхід для Opus: обидві статистики без зайвого, правила і нотатки журналу. */
export function weeklyInput(a: {
  week: Stats;
  allTime: Stats;
  playbook: { version: number; rules: Record<string, string> };
  settings: Record<string, unknown>;
  notes: { ts: string; action: string | null; note: string }[];
}) {
  return {
    week: a.week,
    all_time: { summary: a.allTime.summary, by_setup: a.allTime.bySetup, by_playbook_version: a.allTime.byVersion, rejected_by_model: a.allTime.rejected, calibration: a.allTime.calibration },
    playbook: a.playbook,
    filter_settings: a.settings,
    journal_notes: a.notes,
  };
}

/** Тіло тижневого звіту в reports.body. content дає заголовок і тези для стрічки звітів. */
export interface WeeklyBody {
  v: 1;
  type: "weekly";
  content: { headline: string; theses: string[] };
  week: Stats;
  allTime: Stats;
  review: WeeklyReview | null;
  /** Чому розбору моделі немає: стеля витрат або збій пакета. */
  reviewNote: string | null;
}

export function weeklyBody(week: Stats, allTime: Stats, review: WeeklyReview | null, reviewNote: string | null): WeeklyBody {
  const s = week.summary;
  const fallback = s.closed
    ? `Тиждень: ${s.closed} закритих сигналів, ${s.totalR > 0 ? "+" : ""}${s.totalR}R після комісій`
    : "Тиждень без закритих сигналів";
  return {
    v: 1,
    type: "weekly",
    content: {
      headline: review?.headline ?? fallback,
      theses: review ? [...review.working.slice(0, 1), ...review.failing.slice(0, 1), ...review.nextWeek.slice(0, 1)] : [],
    },
    week,
    allTime,
    review,
    reviewNote,
  };
}
