import { useState } from "react";
import type { BotId, BotMode } from "../shared/bots";
import { BOT_BACKTESTS } from "../shared/tubeBacktest";
import { c, card, dim, h2, num, p, pct, signed, tone } from "./ui";
import { Stat } from "./viz";

/** Спільне для сторінок ботів: підсумок групи угод, напрямок, результат угоди, бектест, періоди. */

export type Side = "long" | "short";
export type Outcome = "win" | "loss" | "open" | "pending" | "cancelled";

/** Слова для ордерів бота: лімітки в High Value Tube, стоп-ордери в High Value Breakout, ринкові входи в Channel 20/10. */
export const WORD: Record<BotMode, { one: string; many: string; gen: string; near: string; far: string; Many: string }> = {
  fade: { one: "лімітка", many: "лімітки", gen: "ліміток", near: "ближча лімітка", far: "дальня лімітка", Many: "Лімітки" },
  breakout: { one: "стоп-ордер", many: "стоп-ордери", gen: "стоп-ордерів", near: "ближчий стоп-ордер", far: "дальній стоп-ордер", Many: "Стоп-ордери" },
  channel: { one: "вхід", many: "входи", gen: "входів", near: "вхід", far: "вхід", Many: "Входи" },
  carry: { one: "позиція", many: "позиції", gen: "позицій", near: "позиція", far: "позиція", Many: "Позиції" },
};

/** Підсумок групи ордерів бота (як TubeGroup у рушії): R після комісій. */
export interface Group {
  orders: number;
  filled: number;
  cancelled: number;
  pending: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  target: number;
  stop: number;
  timeout: number;
  winRate: number | null;
  avgR: number | null;
  totalR: number;
  fillRate: number | null;
}

export const SIDE = { long: { text: "Лонг", icon: "▲", color: c.up }, short: { text: "Шорт", icon: "▼", color: c.down } } as const;

export const OUTCOME: Record<Outcome, { text: string; icon: string; color: string }> = {
  win: { text: "у плюсі", icon: "✓", color: c.up },
  loss: { text: "у мінусі", icon: "✗", color: c.down },
  open: { text: "відкрита", icon: "◷", color: c.blue },
  pending: { text: "чекає", icon: "◷", color: c.blue },
  cancelled: { text: "знята", icon: "–", color: c.faint },
};

export function GroupLine({ name, g }: { name: string; g: Group }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "8px 0", borderBottom: `1px solid ${c.line}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 14 }}>
        <span style={{ fontWeight: 600 }}>{name}</span>
        <span style={{ ...num, fontWeight: 700, color: g.closed ? tone(g.totalR) : c.dim }}>{g.closed ? `${signed(g.totalR)}R` : "—"}</span>
      </div>
      {g.closed > 0 ? (
        <>
          <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", gap: 2 }} aria-hidden>
            {g.wins > 0 && <div style={{ width: `${(g.wins / g.closed) * 100}%`, background: c.up }} />}
            {g.losses > 0 && <div style={{ flex: 1, background: `${c.down}AA` }} />}
          </div>
          <span style={{ ...num, fontSize: 12, color: c.dim }}>
            ✓ {g.wins} · ✗ {g.losses} · {pct(g.winRate)} у плюсі · середнє {g.avgR === null ? "—" : `${signed(g.avgR, 3)}R`}
          </span>
        </>
      ) : (
        <span style={{ fontSize: 12, color: c.dim }}>{g.filled ? `${g.filled} угод, жодна ще не закрилась` : "угод немає"}</span>
      )}
    </div>
  );
}

/** Бектест стратегії на історії: ті самі правила й код виконання, що в боті (npm run backtest:tube, backtest:channel). */
export function Backtest({ id, mode }: { id: Exclude<BotId, "carry">; mode: BotMode }) {
  const b = BOT_BACKTESTS[id];
  const [open, setOpen] = useState(false);
  const row = (s: (typeof b.periods)[number]) => (
    <div key={s.key} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 0", borderBottom: `1px solid ${c.line}` }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 52px 44px 64px", gap: 6, fontSize: 13 }}>
        <span style={{ fontWeight: 600 }}>{s.label}</span>
        <span style={{ ...num, textAlign: "right" }}>{s.trades}</span>
        <span style={{ ...num, textAlign: "right" }}>{pct(s.winRate)}</span>
        <span style={{ ...num, textAlign: "right", fontWeight: 700, color: tone(s.avgR) }}>{signed(s.avgR, 3)}R</span>
      </div>
      <span style={{ fontSize: 11, color: c.dim }}>{s.note}</span>
    </div>
  );
  const full = b.periods.find((x) => x.key === "full")!;
  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <h2 style={h2}>Бектест</h2>
        <span style={{ fontSize: 12, color: c.dim, marginLeft: "auto" }}>
          {b.from} — {b.to}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        {full.perDay < 0.5 ? <Stat label="Угод на місяць" value={(full.perDay * 30).toFixed(1)} /> : <Stat label="Угод на добу" value={full.perDay.toFixed(1)} />}
        <Stat label="У плюсі" value={pct(full.winRate)} />
        <Stat label="Середнє" value={`${signed(full.avgR, 3)}R`} color={tone(full.avgR)} sub={full.ci ? `95%: ${signed(full.ci[0])}…${signed(full.ci[1])}` : undefined} />
        <Stat label="Разом" value={`${signed(full.totalR, 0)}R`} color={tone(full.totalR)} />
        <Stat label="Просадка" value={`${full.maxDrawdownR.toFixed(0)}R`} color={c.down} />
        {full.fillRate === null ? <Stat label="Угод" value={String(full.trades)} /> : <Stat label="Виконалось" value={pct(full.fillRate)} sub={WORD[mode].gen} />}
      </div>
      <p style={{ ...p, fontSize: 13 }}>{b.verdict}</p>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 52px 44px 64px", gap: 6, fontSize: 11, color: c.faint }}>
        <span />
        <span style={{ textAlign: "right" }}>угод</span>
        <span style={{ textAlign: "right" }}>у плюсі</span>
        <span style={{ textAlign: "right" }}>середнє</span>
      </div>
      {b.periods.filter((x) => x.key !== "full").map(row)}
      <button type="button" onClick={() => setOpen(!open)} style={{ background: "none", border: 0, color: c.blue, font: "600 13px Inter, system-ui, sans-serif", textAlign: "left", padding: 0, minHeight: 32, cursor: "pointer" }}>
        {open ? "Сховати ▴" : "Що ще перевірено ▾"}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {b.findings.map((f) => (
            <p key={f} style={{ ...dim, fontSize: 12 }}>
              • {f}
            </p>
          ))}
        </div>
      )}
      <p style={{ ...dim, fontSize: 11 }}>{b.source}</p>
    </section>
  );
}

export type Period = "all" | "30" | "7";
export const PERIODS: [Period, string][] = [["all", "Увесь час"], ["30", "30 днів"], ["7", "7 днів"]];
