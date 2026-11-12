/** Місцевий час рахує код: Cron у Cloudflare працює лише в UTC. */

export type ReportKind = "morning" | "evening";
export type ReportTimes = Record<ReportKind, string>;

export interface LocalTime {
  /** Місцева дата, YYYY-MM-DD. */
  date: string;
  /** Хвилини від місцевої півночі. */
  minutes: number;
  /** День тижня: 0 неділя … 6 субота. */
  weekday: number;
}

export function localTime(now: number, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

/** Тижневий розбір: неділя за місцевим часом, від призначеного часу до кінця доби. */
export function dueWeekly(now: number, timeZone: string, time: string): { date: string } | null {
  const local = localTime(now, timeZone);
  const at = parseClock(time);
  return local.weekday === 0 && at !== null && local.minutes >= at ? { date: local.date } : null;
}

export function parseClock(value: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Скільки після призначеного часу звіт ще можна наздогнати, якщо запуск пропущено. */
export const REPORT_WINDOW_MIN = 180;

/**
 * Які звіти належить скласти зараз: настав час, вікно ще не минуло.
 * Чи звіт уже є в базі, перевіряє рушій (UNIQUE(kind, date)).
 */
export function dueReports(now: number, timeZone: string, times: ReportTimes): { kind: ReportKind; date: string }[] {
  const local = localTime(now, timeZone);
  return (["morning", "evening"] as const)
    .filter((kind) => {
      const at = parseClock(times[kind]);
      return at !== null && local.minutes >= at && local.minutes < at + REPORT_WINDOW_MIN;
    })
    .map((kind) => ({ kind, date: local.date }));
}

/** Місцевий час HH:MM для підписів. */
export function clock(ts: number, timeZone: string): string {
  const m = localTime(ts, timeZone).minutes;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
