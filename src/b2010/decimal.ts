import { Decimal } from "decimal.js";

/**
 * Десяткова арифметика для грошей, цін і кількості. Окремий клон, щоб не міняти глобальні налаштування decimal.js.
 * 40 значущих цифр із запасом покривають ціни BTC з кроком 0.1 і кількості з кроком 0.001.
 */
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -30, toExpPos: 40 });
export type Dec = Decimal;

export const dec = (v: Decimal.Value): Dec => new D(v);
export const ZERO = dec(0);

/** Округлення вниз до кроку (кількість). */
export const floorToStep = (x: Dec, step: Dec): Dec => x.div(step).floor().mul(step);
/** Округлення вгору до кроку. */
export const ceilToStep = (x: Dec, step: Dec): Dec => x.div(step).ceil().mul(step);

export const dmax = (a: Dec, b: Dec): Dec => (a.gte(b) ? a : b);
export const dmin = (a: Dec, b: Dec): Dec => (a.lte(b) ? a : b);
export const dsum = (xs: Dec[]): Dec => xs.reduce((s, x) => s.add(x), ZERO);
