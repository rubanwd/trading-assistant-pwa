import { useEffect, useState } from "react";
import { SETUP } from "./Signals";
import { api, c, card, dim, h2, p, pct, secondary, signed } from "./ui";

interface Group { closed: number; wins: number; winRate: number | null; avgR: number | null; totalR: number }
interface Bin { from: number; to: number; n: number; predicted: number; actual: number }
interface Calibration { n: number; brier: number | null; bins: Bin[] }
export interface Stats {
  from: string | null;
  summary: Group & { published: number; open: number; avgFeeR: number | null; riskPct: number; equityPct: number; btcHoldPct: number | null; target: number };
  bySetup: (Group & { setup: string; published: number })[];
  byVersion: (Group & { version: number | null })[];
  journal: Record<"taken" | "skipped" | "none", Group>;
  rejected: Group & { count: number };
  calibration: { analyst: Calibration; skeptic: Calibration; reports: Calibration };
  funnel: { scans: number; detected: number; filtered: Record<string, number>; reviewed: number; published: number; rejected: number };
  spend: { monthUsd: number; budgetUsd: number | null; byPipeline: { pipeline: string; usd: number; calls: number }[] };
}

const PIPELINE: Record<string, string> = {
  news: "Сортувальник новин", morning_report: "Ранкові звіти", evening_report: "Вечірні звіти",
  analyst: "Аналітик", skeptic: "Скептик", weekly_review: "Тижневий розбір", test: "Пробні виклики",
};
const FILTER: Record<string, string> = {
  rr: "R:R нижче порога", regime: "проти режиму", market: "проти настрою ринку", duplicate: "уже є сигнал по монеті",
  cooldown: "пауза після сетапу", macro: "перед макроподією", max_active: "ліміт відкритих",
};

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14 }}>
      <span style={{ color: c.dim }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", color, textAlign: "right" }}>{value}</span>
    </div>
  );
}

const rColor = (v: number | null) => (v === null || v === 0 ? undefined : v > 0 ? c.blue : c.orange);
const groupLine = (g: Group) => (g.closed ? `${g.closed} · ${pct(g.winRate)} · ${signed(g.totalR)}R` : "немає закритих");

function CalibrationView({ title, cal }: { title: string; cal: Calibration }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ color: c.dim, fontSize: 13 }}>{cal.n ? `${cal.n} перевірених · Браєр ${cal.brier}` : "ще немає перевірених"}</span>
      </div>
      {cal.bins.map((b) => (
        <div key={b.from} style={{ display: "grid", gridTemplateColumns: "64px 1fr 76px", alignItems: "center", gap: 8, fontSize: 13 }}>
          <span style={{ color: c.dim }}>{Math.round(b.from * 100)}–{Math.round(b.to * 100)}%</span>
          <div style={{ position: "relative", height: 8, borderRadius: 4, background: c.line }} aria-hidden>
            <div style={{ position: "absolute", height: 8, borderRadius: 4, width: `${b.actual * 100}%`, background: c.blue }} />
            <div style={{ position: "absolute", left: `calc(${b.predicted * 100}% - 1px)`, top: -3, width: 2, height: 14, background: c.ink }} />
          </div>
          <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(b.actual * 100)}% з {b.n}</span>
        </div>
      ))}
    </div>
  );
}

type Period = "all" | "30" | "7";
const PERIOD: Record<Period, string> = { all: "Увесь час", "30": "30 днів", "7": "7 днів" };

export function StatsView({ stats }: { stats: Stats }) {
  const s = stats.summary;
  const beats = s.btcHoldPct === null ? null : s.equityPct > s.btcHoldPct;
  return (
    <>
      <section style={card}>
        <h2 style={h2}>Результат</h2>
        <Row label="Закритих сигналів" value={`${s.closed} із ${s.target} для рішення`} />
        <div style={{ height: 6, borderRadius: 3, background: c.line }} aria-hidden>
          <div style={{ height: 6, borderRadius: 3, width: `${Math.min(100, (s.closed / s.target) * 100)}%`, background: c.blue }} />
        </div>
        <Row label="Прибуткових" value={pct(s.winRate)} />
        <Row label="Середній результат" value={s.avgR === null ? "—" : `${signed(s.avgR)}R`} color={rColor(s.avgR)} />
        <Row label="Разом" value={`${signed(s.totalR)}R`} color={rColor(s.totalR)} />
        <Row label={`Депозит при ризику ${s.riskPct}%`} value={`${signed(s.equityPct)}%`} color={rColor(s.equityPct)} />
        <Row label="Утримання BTC за той самий час" value={s.btcHoldPct === null ? "—" : `${signed(s.btcHoldPct)}%`} />
        {beats !== null && s.closed > 0 && (
          <p style={{ ...dim, color: beats ? c.blue : c.orange }}>{beats ? "Поки краще за утримання BTC." : "Поки гірше за утримання BTC."}</p>
        )}
        <Row label="Комісії на угоду" value={s.avgFeeR === null ? "—" : `${s.avgFeeR}R`} />
        <Row label="Опубліковано / відкрито" value={`${s.published} / ${s.open}`} />
        <p style={dim}>Усі R після комісій. Перевірка задуму: середній результат вищий за 0R і кращий за утримання BTC після 100 закритих сигналів.</p>
      </section>

      <section style={card}>
        <h2 style={h2}>За сетапами</h2>
        {stats.bySetup.length === 0 && <p style={dim}>Сигналів ще немає.</p>}
        {stats.bySetup.map((g) => (
          <Row key={g.setup} label={SETUP[g.setup] ?? g.setup} value={`${g.published} сигн. · ${groupLine(g)}`} color={rColor(g.closed ? g.totalR : null)} />
        ))}
        {stats.byVersion.length > 1 && (
          <>
            <p style={{ ...dim, marginTop: 4 }}>За версіями правил</p>
            {stats.byVersion.map((g) => <Row key={String(g.version)} label={`Версія ${g.version ?? "—"}`} value={groupLine(g)} />)}
          </>
        )}
        <p style={dim}>Кількість закритих · частка прибуткових · сума R.</p>
      </section>

      <section style={card}>
        <h2 style={h2}>Твої рішення</h2>
        <Row label="Взяв" value={groupLine(stats.journal.taken)} color={rColor(stats.journal.taken.closed ? stats.journal.taken.totalR : null)} />
        <Row label="Пропустив" value={groupLine(stats.journal.skipped)} color={rColor(stats.journal.skipped.closed ? stats.journal.skipped.totalR : null)} />
        <Row label="Без позначки" value={groupLine(stats.journal.none)} />
        <Row
          label="Відхилені моделлю, якби брали"
          value={`${stats.rejected.count} канд. · ${groupLine(stats.rejected)}`}
          color={rColor(stats.rejected.closed ? stats.rejected.totalR : null)}
        />
      </section>

      <section style={card}>
        <h2 style={h2}>Калібрування</h2>
        <p style={dim}>Синя смужка: як часто збувалося; риска: середня оцінка в кошику. У добре відкаліброваних оцінок риска стоїть на краю смужки.</p>
        <CalibrationView title="Аналітик" cal={stats.calibration.analyst} />
        <CalibrationView title="Скептик" cal={stats.calibration.skeptic} />
        <CalibrationView title="Сценарії звітів" cal={stats.calibration.reports} />
      </section>

      <section style={card}>
        <h2 style={h2}>Воронка</h2>
        <Row label="Сканів зі свіжою свічкою 1h" value={String(stats.funnel.scans)} />
        <Row label="Знайдено сетапів" value={String(stats.funnel.detected)} />
        {Object.entries(stats.funnel.filtered)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => <Row key={k} label={`відсіяно: ${FILTER[k] ?? k}`} value={String(v)} />)}
        <Row label="Перевірила модель" value={String(stats.funnel.reviewed)} />
        <Row label="Опубліковано / відхилено" value={`${stats.funnel.published} / ${stats.funnel.rejected}`} />
      </section>

      <section style={card}>
        <h2 style={h2}>Витрати цього місяця</h2>
        <Row label="Разом" value={`$${stats.spend.monthUsd.toFixed(2)}${stats.spend.budgetUsd !== null ? ` із $${stats.spend.budgetUsd}` : ""}`} />
        {stats.spend.byPipeline.map((x) => <Row key={x.pipeline} label={`${PIPELINE[x.pipeline] ?? x.pipeline} · ${x.calls}`} value={`$${x.usd.toFixed(3)}`} />)}
      </section>
    </>
  );
}

export function Stats() {
  const [period, setPeriod] = useState<Period>("all");
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setStats(null);
    api<Stats>(`/api/stats?period=${period}`).then(
      (d) => {
        setStats(d);
        setError(null);
      },
      (e) => setError(String(e)),
    );
  }, [period]);
  return (
    <>
      <div style={{ display: "flex", gap: 8 }}>
        {(Object.keys(PERIOD) as Period[]).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={period === k}
            onClick={() => setPeriod(k)}
            style={{ ...secondary, flex: 1, minHeight: 40, fontSize: 14, padding: 0, color: period === k ? c.blue : c.dim, borderColor: period === k ? c.blue : c.line }}
          >
            {PERIOD[k]}
          </button>
        ))}
      </div>
      {error && <p style={{ ...p, color: c.orange }}>{error}</p>}
      {!stats && !error && <p style={dim}>Рахую…</p>}
      {stats && <StatsView stats={stats} />}
    </>
  );
}
