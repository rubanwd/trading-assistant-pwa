import type { Side } from "../shared/risk";
import { stopDistancePct } from "../shared/risk";
import type { Candle } from "./market/types";
import type { MarketMood, MarketRegime, Trend } from "./regime";
import { trend } from "./regime";
import { compactSymbol, type NewsField } from "./report/input";
import { round, type Snapshot } from "./snapshot";

/**
 * Ідея скану: щопів години одна монета, напрямок і ціна входу, найкращі серед списку.
 * Рахує код: бал технічного аналізу, ціни входу, стоп і ціль. Модель лише вибирає один із кількох
 * найкращих за балом варіантів (або жодного) і пояснює вибір. Це не сигнал: сигнал публікується,
 * лише коли згодні детектор, аналітик і скептик. Результат кожної ідеї рахує код за свічками 1h.
 */

/**
 * Стиль балу. short (типово) — напрямок «на зараз»: ринок за останні години (орієнтир і ширина на 1h)
 * і швидкий тренд монети на 1h і 15m; тренд 4h і 1d лише фон. Тож у глобальному спаді денний відскок дає лонги.
 * swing — попередній стиль: тренд 1d і 4h, настрій ринку за 4h. Бектест 2023-11 — 2026-10 (без моделі, після комісій):
 * у середньому обидва ≈ −0.01R на ідею; swing добре заробляє в сильних трендах і програє в боковику та на розворотах,
 * short тримає лонги й шорти приблизно порівну, крива рівніша (просадка 358R проти 416R), але в трендах заробляє менше.
 * Стоп і горизонт однакові: коротші (стоп від ATR 1h, горизонт 6–12 год) у бектесті гірші, бо комісії з'їдають більшу частку R.
 */
export type PickStyle = "short" | "swing";
export const PICK_STYLES: readonly PickStyle[] = ["short", "swing"];

/** Стоп ідеї: 1.5 ATR(14) 4h від входу, але не ближче за min_stop_pct. */
export const PICK_STOP: { tf: "1h" | "4h"; atr: number } = { tf: "4h", atr: 1.5 };
/** Ціль ідеї: 2R від входу. */
export const PICK_TARGET_R = 2;
/** Скільки найкращих за балом варіантів іде до моделі. */
export const PICK_TOP = 3;
/** Бал, нижче якого ідея вважається слабкою: ринок без чіткої переваги. */
export const PICK_MIN_SCORE = 60;
/** Відкат для лімітного входу: від 0.3 до 1.5 ATR(14) 1h від поточної ціни. */
const PULLBACK_ATR = { min: 0.3, max: 1.5 } as const;

export interface PickFactor {
  /** Внесок у бал: плюс на користь напрямку, мінус проти. */
  points: number;
  note: string;
}

export interface PickLevels {
  entry: number;
  stop: number;
  target: number;
  stopPct: number;
}

/** Варіант ідеї, порахований кодом. */
export interface PickOption {
  symbol: string;
  side: Side;
  /** Бал технічного аналізу 0–100: 50 нейтрально. */
  score: number;
  factors: PickFactor[];
  price: number;
  /** Вхід за ринком і лімітний вхід на відкаті (null, якщо поруч немає опори). */
  market: PickLevels;
  pullback: PickLevels | null;
  /** Відстань до найближчого рівня проти угоди: у стилі short рівень 1h в ATR 1h, у swing рівень 4h в ATR 4h; null, якщо рівня немає. */
  roomAtr: number | null;
}

const TREND_NAME: Record<Trend, string> = { up: "вгору", down: "вниз", range: "боковик" };
const MOOD_NAME = { risk_on: "ризик-он", risk_off: "ризик-оф", mixed: "змішаний" } as const;

/** Рівні для входу: стоп за `stopAtr` ATR (не ближче min_stop_pct), ціль 2R. */
export function pickLevels(side: Side, entry: number, atr: number, minStopPct: number, stopAtr = PICK_STOP.atr): PickLevels {
  const dir = side === "long" ? 1 : -1;
  const risk = Math.max(stopAtr * atr, (entry * minStopPct) / 100);
  const stop = round(entry - dir * risk)!;
  const target = round(entry + dir * PICK_TARGET_R * risk)!;
  return { entry: round(entry)!, stop, target, stopPct: Number(stopDistancePct(entry, stop).toFixed(2)) };
}

/** Лімітний вхід: найближча до ціни опора 1h (рівень або EMA20 1h) на відстані 0.3–1.5 ATR 1h у бік відкату. */
export function pullbackEntry(s: Snapshot, side: Side): number | null {
  const atr1h = s.tf["1h"].atr14;
  if (atr1h === null || atr1h <= 0) return null;
  const dir = side === "long" ? 1 : -1;
  const levels = side === "long" ? s.levels["1h"].support : s.levels["1h"].resistance;
  const options = [s.tf["1h"].ema20, ...levels.map((l) => l.price)].filter((p): p is number => p !== null);
  const fit = options.filter((p) => {
    const d = ((s.price - p) * dir) / atr1h;
    return d >= PULLBACK_ATR.min && d <= PULLBACK_ATR.max;
  });
  if (!fit.length) return null;
  // Найближча до ціни: її найімовірніше торкнуться.
  return fit.reduce((best, p) => (Math.abs(s.price - p) < Math.abs(s.price - best) ? p : best));
}

/**
 * Бал технічного аналізу для одного напрямку. Старт 50; кожна ознака додає або віднімає бали,
 * і кожна записується з поясненням: застосунок і модель бачать, з чого склався бал.
 */
export function scoreSide(s: Snapshot, side: Side, market: MarketRegime, leader = "BTCUSDT"): { score: number; factors: PickFactor[]; roomAtr: number | null } {
  const dir = side === "long" ? 1 : -1;
  const factors: PickFactor[] = [];
  const add = (points: number, note: string) => {
    if (points !== 0) factors.push({ points, note });
  };
  const trendPoints = (t: Trend | null, weight: number) => (t === "up" ? weight * dir : t === "down" ? -weight * dir : 0);

  // Загальний ринок.
  if (market.mood !== "mixed") add(market.mood === "risk_on" ? 10 * dir : -10 * dir, `ринок ${MOOD_NAME[market.mood]}`);
  if (market.btcTrend && market.btcTrend !== "range" && s.symbol !== leader) add(trendPoints(market.btcTrend, 5), `${leader.replace(/USDT$/, "")} 4h ${TREND_NAME[market.btcTrend]}`);

  // Тренд монети на трьох таймфреймах.
  const t1h = trend(s.tf["1h"]);
  for (const [t, weight, name] of [
    [s.regime.higherTrend, 10, "1d"],
    [s.regime.trend, 12, "4h"],
    [t1h, 5, "1h"],
  ] as const) {
    if (t && t !== "range") add(trendPoints(t, weight), `тренд ${name} ${TREND_NAME[t]}`);
  }

  // Імпульс: RSI 4h у робочій зоні, без перегріву.
  const rsi = s.tf["4h"].rsi14;
  if (rsi !== null) {
    const r = side === "long" ? rsi : 100 - rsi;
    if (r > 75) add(-8, `RSI 4h ${Math.round(rsi)}: перегрів у бік угоди`);
    else if (r >= 52 && r <= 68) add(6, `RSI 4h ${Math.round(rsi)}: імпульс без перегріву`);
    else if (r < 45) add(-5, `RSI 4h ${Math.round(rsi)}: імпульс проти угоди`);
  }

  // Розтягнутість від EMA20 4h: вхід навздогін гірший.
  const atr4h = s.tf["4h"].atr14;
  const ema20 = s.tf["4h"].ema20;
  if (atr4h && ema20 !== null) {
    const ext = ((s.price - ema20) / atr4h) * dir;
    if (ext > 3) add(-8, `ціна ${ext.toFixed(1)} ATR від EMA20 4h: вхід навздогін`);
    else if (ext >= 0 && ext <= 1.5) add(4, "ціна біля EMA20 4h з правильного боку");
    else if (ext < -1) add(-4, "ціна з іншого боку EMA20 4h");
  }

  // Обсяг підтверджує рух.
  const vol = s.tf["4h"].volumeRatio;
  const ch4 = s.tf["4h"].changePct;
  if (vol !== null && ch4 !== null && vol >= 1.3 && Math.sign(ch4) === dir) add(4, `обсяг 4h ×${vol.toFixed(1)} у бік угоди`);

  // Фандинг: перегрітий у бік угоди — мінус, проти натовпу — невеликий плюс.
  if (s.funding) {
    const f = s.funding.rate * 100 * dir;
    if (f > 0.03) add(-5, `фандинг ${(s.funding.rate * 100).toFixed(3)}%: натовп уже в цьому боці`);
    else if (f < 0) add(2, `фандинг ${(s.funding.rate * 100).toFixed(3)}%: натовп проти угоди`);
  }

  // Відкритий інтерес росте разом із ціною в бік угоди.
  const oi = s.openInterest?.change24hPct ?? null;
  const ch1d = s.tf["1d"].changePct;
  if (oi !== null && ch1d !== null && oi > 3 && Math.sign(ch1d) === dir) add(3, `відкритий інтерес +${oi.toFixed(1)}% за добу`);

  // Простір до найближчого рівня 4h проти угоди.
  let roomAtr: number | null = null;
  if (atr4h) {
    const near = (side === "long" ? s.levels["4h"].resistance : s.levels["4h"].support)[0];
    if (near) {
      roomAtr = Number((Math.abs(near.price - s.price) / atr4h).toFixed(2));
      if (roomAtr < 1) add(-6, `рівень ${near.price} ближче 1 ATR: мало простору`);
      else if (roomAtr > 2.5) add(3, "до найближчого рівня понад 2.5 ATR");
    } else add(3, "рівнів 4h проти угоди поруч немає");
  }

  const score = Math.max(0, Math.min(100, 50 + factors.reduce((sum, f) => sum + f.points, 0)));
  return { score, factors: factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)), roomAtr };
}

// ── Короткий стиль ─────────────────────────────────────────────────────────

/**
 * Швидкий тренд таймфрейму: up, коли close > EMA20 > EMA50; down дзеркально; інакше range.
 * На відміну від `trend` не чекає EMA200, тож розворот видно за години, а не за тижні.
 */
export function fastTrend(f: { close: number | null; ema20: number | null; ema50: number | null }): Trend | null {
  const { close, ema20, ema50 } = f;
  if (close === null || ema20 === null || ema50 === null) return null;
  if (close > ema20 && ema20 > ema50) return "up";
  if (close < ema20 && ema20 < ema50) return "down";
  return "range";
}

/** Ринок «зараз»: орієнтир і ширина ринку на 1h. */
export interface ShortMarket {
  mood: MarketMood;
  /** Швидкий тренд орієнтира на 1h і 15m. */
  leaderTrend1h: Trend | null;
  leaderTrend15m: Trend | null;
  /** Частка монет із ціною вище EMA20 1h (0..1); null, якщо даних немає. */
  breadth: number | null;
}

/**
 * risk_on, коли орієнтир на 1h росте (close > EMA20 > EMA50) і щонайменше 60% монет вище EMA20 1h;
 * risk_off дзеркально (не більше 40%); інакше mixed. Тренд 4h і 1d тут не враховується навмисно.
 */
export function shortMarket(snapshots: Snapshot[], leader = "BTCUSDT"): ShortMarket {
  const lead = snapshots.find((s) => s.symbol === leader);
  const leaderTrend1h = lead ? fastTrend(lead.tf["1h"]) : null;
  const leaderTrend15m = lead ? fastTrend(lead.tf["15m"]) : null;
  const known = snapshots.filter((s) => s.tf["1h"].ema20 !== null);
  const breadth = known.length ? known.filter((s) => s.price > s.tf["1h"].ema20!).length / known.length : null;
  let mood: MarketMood = "mixed";
  if (breadth !== null) {
    if (leaderTrend1h === "up" && breadth >= 0.6) mood = "risk_on";
    else if (leaderTrend1h === "down" && breadth <= 0.4) mood = "risk_off";
  }
  return { mood, leaderTrend1h, leaderTrend15m, breadth: breadth === null ? null : Number(breadth.toFixed(2)) };
}

/**
 * Бал короткого стилю: напрямок «на зараз». Головне — ринок за останні години і тренд монети на 15m і 1h;
 * тренд 4h і 1d лише трохи важить, тож у глобальному спаді денний відскок дає лонги.
 */
export function scoreShort(s: Snapshot, side: Side, now: ShortMarket, leader = "BTCUSDT"): { score: number; factors: PickFactor[]; roomAtr: number | null } {
  const dir = side === "long" ? 1 : -1;
  const factors: PickFactor[] = [];
  const add = (points: number, note: string) => {
    if (points !== 0) factors.push({ points, note });
  };
  const trendPoints = (t: Trend | null, weight: number) => (t === "up" ? weight * dir : t === "down" ? -weight * dir : 0);
  const name = leader.replace(/USDT$/, "");

  // Ринок зараз.
  if (now.mood !== "mixed") add(now.mood === "risk_on" ? 10 * dir : -10 * dir, `ринок за 1h ${MOOD_NAME[now.mood]}`);
  if (s.symbol !== leader && now.leaderTrend1h && now.leaderTrend1h !== "range") add(trendPoints(now.leaderTrend1h, 5), `${name} 1h ${TREND_NAME[now.leaderTrend1h]}`);

  // Тренд монети: 1h головний, 15m підтверджує, 4h і 1d лише фон.
  for (const [t, weight, label] of [
    [fastTrend(s.tf["1h"]), 12, "1h"],
    [fastTrend(s.tf["15m"]), 6, "15m"],
    [fastTrend(s.tf["4h"]), 4, "4h"],
    [s.regime.higherTrend, 2, "1d"],
  ] as const) {
    if (t && t !== "range") add(trendPoints(t, weight), `тренд ${label} ${TREND_NAME[t]}`);
  }

  // Імпульс: RSI 1h у робочій зоні, без перегріву.
  const rsi = s.tf["1h"].rsi14;
  if (rsi !== null) {
    const r = side === "long" ? rsi : 100 - rsi;
    if (r > 75) add(-8, `RSI 1h ${Math.round(rsi)}: перегрів у бік угоди`);
    else if (r >= 52 && r <= 68) add(6, `RSI 1h ${Math.round(rsi)}: імпульс без перегріву`);
    else if (r < 45) add(-5, `RSI 1h ${Math.round(rsi)}: імпульс проти угоди`);
  }

  // Розтягнутість від EMA20 1h.
  const atr1h = s.tf["1h"].atr14;
  const ema20 = s.tf["1h"].ema20;
  if (atr1h && ema20 !== null) {
    const ext = ((s.price - ema20) / atr1h) * dir;
    if (ext > 3) add(-8, `ціна ${ext.toFixed(1)} ATR від EMA20 1h: вхід навздогін`);
    else if (ext >= 0 && ext <= 1.5) add(4, "ціна біля EMA20 1h з правильного боку");
    else if (ext < -1) add(-4, "ціна з іншого боку EMA20 1h");
  }

  // Обсяг 1h підтверджує рух.
  const vol = s.tf["1h"].volumeRatio;
  const ch1 = s.tf["1h"].changePct;
  if (vol !== null && ch1 !== null && vol >= 1.3 && Math.sign(ch1) === dir) add(4, `обсяг 1h ×${vol.toFixed(1)} у бік угоди`);

  // Фандинг: перегрітий у бік угоди — мінус, проти натовпу — невеликий плюс.
  if (s.funding) {
    const f = s.funding.rate * 100 * dir;
    if (f > 0.03) add(-5, `фандинг ${(s.funding.rate * 100).toFixed(3)}%: натовп уже в цьому боці`);
    else if (f < 0) add(2, `фандинг ${(s.funding.rate * 100).toFixed(3)}%: натовп проти угоди`);
  }

  // Простір до найближчого рівня 1h проти угоди, в ATR 1h.
  let roomAtr: number | null = null;
  if (atr1h) {
    const near = (side === "long" ? s.levels["1h"].resistance : s.levels["1h"].support)[0];
    if (near) {
      roomAtr = Number((Math.abs(near.price - s.price) / atr1h).toFixed(2));
      if (roomAtr < 1) add(-6, `рівень ${near.price} ближче 1 ATR 1h: мало простору`);
      else if (roomAtr > 2.5) add(3, "до найближчого рівня 1h понад 2.5 ATR");
    } else add(3, "рівнів 1h проти угоди поруч немає");
  }

  const score = Math.max(0, Math.min(100, 50 + factors.reduce((sum, f) => sum + f.points, 0)));
  return { score, factors: factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points)), roomAtr };
}

/**
 * Найкращий напрямок для кожної монети, від найвищого балу. Монети без ATR не беруться,
 * як і монети з `exclude` (по них уже є відкрита ідея: нова чекає, поки та закриється).
 * Стиль short (типово) рахує ринок «зараз» за всіма знімками, зокрема виключених монет.
 * `stop` — інший стоп для бектесту; рушій бере PICK_STOP.
 */
export function rankPicks(
  snapshots: Snapshot[],
  market: MarketRegime,
  opts: { minStopPct: number; top?: number; exclude?: ReadonlySet<string>; leader?: string; style?: PickStyle; stop?: { tf: "1h" | "4h"; atr: number } },
): PickOption[] {
  const style = opts.style ?? "short";
  const stop = opts.stop ?? PICK_STOP;
  const now = style === "short" ? shortMarket(snapshots, opts.leader) : null;
  const out: PickOption[] = [];
  for (const s of snapshots) {
    if (opts.exclude?.has(s.symbol)) continue;
    const atr = s.tf[stop.tf].atr14;
    if (!atr || atr <= 0 || !(s.price > 0)) continue;
    const sides = (["long", "short"] as const).map((side) => ({
      side,
      ...(now ? scoreShort(s, side, now, opts.leader) : scoreSide(s, side, market, opts.leader)),
    }));
    const best = sides[0]!.score >= sides[1]!.score ? sides[0]! : sides[1]!;
    const pb = pullbackEntry(s, best.side);
    out.push({
      symbol: s.symbol,
      side: best.side,
      score: best.score,
      factors: best.factors,
      price: s.price,
      market: pickLevels(best.side, s.price, atr, opts.minStopPct, stop.atr),
      pullback: pb === null ? null : pickLevels(best.side, pb, atr, opts.minStopPct, stop.atr),
      roomAtr: best.roomAtr,
    });
  }
  // За рівного балу вище стоїть монета з більшим простором до рівня.
  out.sort((a, b) => b.score - a.score || (b.roomAtr ?? 99) - (a.roomAtr ?? 99));
  return out.slice(0, opts.top ?? PICK_TOP);
}

// ── Модель ─────────────────────────────────────────────────────────────────

export interface PickInputArgs {
  options: PickOption[];
  snapshots: Map<string, Snapshot>;
  btc: Snapshot | null;
  market: MarketRegime;
  news: NewsField[];
  horizonHours: number;
  minutesToMacro: number | null;
  /** Стиль балу і ринок «зараз» (для short). */
  style?: PickStyle;
  marketNow?: ShortMarket | null;
}

const levelsOut = (l: PickLevels) => ({ entry: l.entry, stop: l.stop, target: l.target, stop_distance_pct: l.stopPct });

/** Вхід для моделі: варіанти від коду з балом і ознаками, стиснуті знімки, поля новин. Сирих свічок немає. */
export function pickInput(a: PickInputArgs) {
  return {
    horizon_hours: a.horizonHours,
    direction_basis: (a.style ?? "short") === "short" ? "short_term" : "higher_timeframes",
    market: { mood: a.market.mood, btc_trend_4h: a.market.btcTrend, share_above_ema200_4h: a.market.breadth },
    market_now: a.marketNow
      ? { mood_1h: a.marketNow.mood, btc_trend_1h: a.marketNow.leaderTrend1h, btc_trend_15m: a.marketNow.leaderTrend15m, share_above_ema20_1h: a.marketNow.breadth }
      : null,
    btc: a.btc ? compactSymbol(a.btc) : null,
    minutes_to_macro_event: a.minutesToMacro,
    options: a.options.map((o, index) => {
      const snap = a.snapshots.get(o.symbol);
      return {
        index,
        symbol: o.symbol,
        side: o.side,
        tech_score: o.score,
        score_factors: o.factors.map((f) => `${f.points > 0 ? "+" : ""}${f.points}: ${f.note}`),
        room_to_level_atr_4h: o.roomAtr,
        entry_market: levelsOut(o.market),
        entry_pullback: o.pullback ? levelsOut(o.pullback) : null,
        snapshot: snap && o.symbol !== a.btc?.symbol ? compactSymbol(snap) : null,
        news_last_12h: a.news.filter((n) => n.symbols.includes(o.symbol)).slice(0, 4),
      };
    }),
    market_news_last_12h: a.news.filter((n) => n.symbols.includes("MARKET")).slice(0, 4),
  };
}

export const PICK_SYSTEM = `Ти радник трейдера ф'ючерсів. Щопів години код вибирає кілька найкращих за технічним аналізом варіантів угоди серед списку монет: монета, напрямок, бал 0–100 і ознаки, з яких він склався, а також два способи входу з уже порахованими стопом і ціллю.
Твоє завдання: вибрати один варіант, який найкраще узгоджується з ринком (настрій, тренд BTC, ширина ринку, новини) і з картиною самої монети, або чесно сказати, що зараз жоден не вартий входу.
direction_basis показує, як код вибирав напрямок. short_term: за ринком останніх годин (market_now: настрій за 1h, тренд BTC на 1h і 15m, частка монет вище EMA20 1h) і трендом монети на 1h і 15m; market (4h) і денний тренд — лише фон. Угода проти старшого тренду в такому разі не помилка: якщо глобально ринок падає, а сьогодні йде вгору, лонг на цей відрізок доречний. Не відхиляй варіант лише через те, що він проти тренду 4h чи 1d; відхиляй, якщо проти нього market_now або сама монета на 1h. higher_timeframes: напрямок за трендом 1d і 4h і настроєм market.
Усі ціни порахував код: не змінюй їх і не пропонуй інших рівнів чи розміру позиції. Розмір позиції рахує код.
Вхід entry_market — за ринком зараз; entry_pullback — лімітний ордер на відкаті до опори (може не виконатися за horizon_hours). Обери pullback, якщо ціна розтягнута від середніх або поруч сильний рівень; market, якщо рух лише почався і відкат малоймовірний. Якщо entry_pullback немає, обирай market.
Імовірність означає одне: протягом horizon_hours після входу ціна дійде до target раніше, ніж до stop. Ціль 2R, тож без переваги це близько 30%; давай вище лише за конкретні ознаки, які називаєш. Ціле число від 5 до 95.
choice: index вибраного варіанта або -1, якщо жоден не вартий входу (ознаки суперечать одна одній, ринок проти в межах direction_basis, новина високого впливу, близька макроподія).
Пиши українською, коротко, по одному факту на пункт.
Поверни:
- choice, entry (market або pullback), probability_pct;
- summary: одне речення, чому саме цей варіант (або чому жоден);
- arguments_for: 2–4 аргументи за;
- arguments_against: 1–3 аргументи проти (вони є завжди);
- invalidation: що скасує ідею ще до стопа.`;

const text = { type: "string" } as const;
const texts = { type: "array", items: text } as const;

export const PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["choice", "entry", "probability_pct", "summary", "arguments_for", "arguments_against", "invalidation"],
  properties: {
    choice: { type: "integer" },
    entry: { type: "string", enum: ["market", "pullback"] },
    probability_pct: { type: "integer" },
    summary: text,
    arguments_for: texts,
    arguments_against: texts,
    invalidation: text,
  },
} as const;

export interface PickAi {
  /** Індекс варіанта або -1. */
  choice: number;
  entry: "market" | "pullback";
  /** 0..1 */
  probability: number;
  summary: string;
  argumentsFor: string[];
  argumentsAgainst: string[];
  invalidation: string;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 240)).filter(Boolean).slice(0, 4) : []);

/** Перевірка відповіді кодом: індекс у межах, ймовірність 5–95%, лімітний вхід лише там, де код його порахував. */
export function sanitizePick(raw: unknown, options: PickOption[]): PickAi {
  const r = (raw ?? {}) as Record<string, unknown>;
  const choice = r.choice;
  if (typeof choice !== "number" || !Number.isInteger(choice) || choice < -1 || choice >= options.length) throw new Error("модель дала невідомий варіант");
  const p = r.probability_pct;
  if (typeof p !== "number" || !Number.isFinite(p)) throw new Error("модель не дала ймовірності");
  const wantsPullback = r.entry === "pullback";
  const entry = choice >= 0 && wantsPullback && options[choice]!.pullback ? "pullback" : "market";
  return {
    choice,
    entry,
    probability: Math.min(95, Math.max(5, Math.round(p))) / 100,
    summary: str(r.summary, 300),
    argumentsFor: list(r.arguments_for),
    argumentsAgainst: list(r.arguments_against),
    invalidation: str(r.invalidation, 300),
  };
}

/**
 * pick — модель вибрала варіант; pass — модель не радить жоден, показуємо найкращий за балом;
 * none — модель не викликалась (стеля витрат, збій), лише технічний аналіз.
 */
export type PickVerdict = "pick" | "pass" | "none";

export interface PickChoice {
  option: PickOption;
  entryKind: "market" | "pullback";
  levels: PickLevels;
  verdict: PickVerdict;
}

/** Що показати: вибір моделі, а без нього найкращий за балом варіант із входом за ринком. */
export function choosePick(options: PickOption[], ai: PickAi | null): PickChoice | null {
  const first = options[0];
  if (!first) return null;
  if (!ai) return { option: first, entryKind: "market", levels: first.market, verdict: "none" };
  if (ai.choice < 0) return { option: first, entryKind: "market", levels: first.market, verdict: "pass" };
  const option = options[ai.choice]!;
  const levels = ai.entry === "pullback" && option.pullback ? option.pullback : option.market;
  return { option, entryKind: levels === option.market ? "market" : "pullback", levels, verdict: "pick" };
}

// ── Результат ──────────────────────────────────────────────────────────────

export interface PickTrade {
  side: Side;
  entryKind: "market" | "pullback";
  entry: number;
  stop: number;
  target: number;
  /** мс UTC */
  createdAt: number;
  horizonMs: number;
}

export type PickStatus = "open" | "target" | "stop" | "expired" | "unfilled";

export interface PickOutcome {
  status: PickStatus;
  /** Результат у R без комісій; null, поки ідея відкрита або вхід не виконався. */
  resultR: number | null;
  filledAt: number | null;
  resolvedAt: number | null;
}

/**
 * Результат ідеї за свічками 1h. Вхід за ринком — у момент ідеї; лімітний — коли свічка, що відкрилась
 * після ідеї, торкнулась ціни входу. Стоп перевіряється раніше за ціль: порядок усередині свічки невідомий.
 * За horizon після ідеї: без входу — unfilled, з відкритою позицією — expired із результатом за закриттям.
 */
export function resolvePick(t: PickTrade, h1: Candle[], now: number): PickOutcome {
  const long = t.side === "long";
  const dir = long ? 1 : -1;
  const risk = Math.abs(t.entry - t.stop);
  const r = (price: number) => (risk === 0 ? 0 : Number((((price - t.entry) / risk) * dir).toFixed(2)));
  const deadline = t.createdAt + t.horizonMs;
  let filledAt: number | null = t.entryKind === "market" ? t.createdAt : null;
  let lastClose: number | null = null;
  for (const c of h1) {
    if (c.closeTime <= t.createdAt) continue;
    if (c.openTime >= deadline) break;
    lastClose = c.close;
    let fillCandle = false;
    if (filledAt === null) {
      // Лімітний ордер: лише свічки, що почались після ідеї, бо мінімум поточної міг бути раніше.
      if (c.openTime < t.createdAt) continue;
      if (long ? c.low > t.entry : c.high < t.entry) continue;
      filledAt = c.openTime;
      fillCandle = true;
    }
    if (long ? c.low <= t.stop : c.high >= t.stop) return { status: "stop", resultR: -1, filledAt, resolvedAt: c.closeTime };
    // У свічці входу на відкаті ціна спершу йшла проти угоди: ціль у ній не зараховуємо.
    if (!fillCandle && (long ? c.high >= t.target : c.low <= t.target)) return { status: "target", resultR: r(t.target), filledAt, resolvedAt: c.closeTime };
  }
  if (now < deadline) return { status: "open", resultR: null, filledAt, resolvedAt: null };
  if (filledAt === null) return { status: "unfilled", resultR: null, filledAt: null, resolvedAt: deadline };
  return { status: "expired", resultR: lastClose === null ? 0 : r(lastClose), filledAt, resolvedAt: deadline };
}
