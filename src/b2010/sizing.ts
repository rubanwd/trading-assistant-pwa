/**
 * Розмір позиції від планового ризику. Усе в десятковій арифметиці; кількість лише вниз до qtyStep.
 */
import { dec, dmin, floorToStep, ZERO, type Dec } from "./decimal";
import type { InstrumentSpec, OrderSide, Side } from "./types";

/** Ціна з несприятливим прослизанням: купівля дорожче, продаж дешевше. */
export const adverse = (price: Dec, side: OrderSide, slippage: Dec): Dec =>
  side === "Buy" ? price.mul(dec(1).add(slippage)) : price.mul(dec(1).sub(slippage));

export interface SizingInput {
  side: Side;
  /** Капітал бота, USDT. Кошти інших стратегій сюди не входять. */
  equity: Dec;
  /** Плановий ризик на угоду, частка (0.005 = 0.5%). */
  riskFraction: Dec;
  /** E: очікувана ціна входу з несприятливим прослизанням. */
  entry: Dec;
  /** X: очікувана ціна виконання стопа з несприятливим прослизанням. */
  stopExec: Dec;
  /** f: taker-комісія за одну сторону, частка. */
  fee: Dec;
  /** Доступна боту маржа, USDT. */
  availableMargin: Dec;
  leverage: Dec;
  spec: Pick<InstrumentSpec, "qtyStep" | "minOrderQty" | "minNotional" | "maxMktOrderQty">;
}

export type SkipReason =
  | "invalid_stop"
  | "no_margin"
  | "qty_below_min"
  | "notional_below_min";

export interface SizingDetail {
  riskBudget: Dec;
  lossPerUnit: Dec;
  rawQty: Dec;
  /** Найбільша кількість за маржею з резервом на комісії входу й виходу. */
  marginQty: Dec;
}

export type SizingResult =
  | ({ ok: true; qty: Dec; notional: Dec; plannedLoss: Dec; cappedBy: "risk" | "margin" | "max_order" } & SizingDetail)
  | ({ ok: false; reason: SkipReason; message: string } & Partial<SizingDetail>);

/**
 * riskBudget = equity × riskFraction; lossPerUnit = |E − X| + E·f + X·f; rawQty = riskBudget / lossPerUnit.
 * Далі обмеження маржею (плече, резерв на комісії) і maxMktOrderQty, округлення ВНИЗ до qtyStep,
 * перевірка minOrderQty і minNotionalValue. Обсяг ніколи не округлюється вгору до мінімуму.
 */
export function sizePosition(input: SizingInput): SizingResult {
  const { side, equity, riskFraction, entry: E, stopExec: X, fee: f, availableMargin, leverage, spec } = input;
  if (side === "long" ? !X.lt(E) : !X.gt(E)) return { ok: false, reason: "invalid_stop", message: `стоп ${X} не з того боку від входу ${E}` };
  const riskBudget = equity.mul(riskFraction);
  const lossPerUnit = E.sub(X).abs().add(E.mul(f)).add(X.mul(f));
  const rawQty = riskBudget.div(lossPerUnit);
  // На 1 одиницю: маржа E/плече плюс резерв на комісію входу й виходу.
  const perUnitMargin = E.div(leverage).add(E.mul(f)).add(X.mul(f));
  const marginQty = availableMargin.gt(ZERO) ? availableMargin.div(perUnitMargin) : ZERO;
  const detail: SizingDetail = { riskBudget, lossPerUnit, rawQty, marginQty };
  if (!availableMargin.gt(ZERO)) return { ok: false, reason: "no_margin", message: "немає доступної маржі", ...detail };
  let capped = rawQty;
  let cappedBy: "risk" | "margin" | "max_order" = "risk";
  if (marginQty.lt(capped)) {
    capped = marginQty;
    cappedBy = "margin";
  }
  if (spec.maxMktOrderQty.gt(ZERO) && spec.maxMktOrderQty.lt(capped)) {
    capped = dmin(capped, spec.maxMktOrderQty);
    cappedBy = "max_order";
  }
  const qty = floorToStep(capped, spec.qtyStep);
  if (qty.lte(ZERO) || qty.lt(spec.minOrderQty))
    return {
      ok: false,
      reason: "qty_below_min",
      message: `кількість ${qty} (сира ${rawQty.toSignificantDigits(8)}, ліміт ${cappedBy}) менша за minOrderQty ${spec.minOrderQty} / qtyStep ${spec.qtyStep}`,
      ...detail,
    };
  const notional = qty.mul(E);
  if (notional.lt(spec.minNotional))
    return { ok: false, reason: "notional_below_min", message: `номінал ${notional.toFixed(2)} USDT менший за minNotionalValue ${spec.minNotional}`, ...detail };
  return { ok: true, qty, notional, plannedLoss: qty.mul(lossPerUnit), cappedBy, ...detail };
}
