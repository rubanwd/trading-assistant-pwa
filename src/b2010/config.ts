/**
 * Налаштування бота з оточення (файл .env, див. .env.example). Ключі API читаються лише тут
 * і передаються в BybitClient; в журнал, БД чи помилки вони не потрапляють.
 */
import { existsSync } from "node:fs";
import { dec, type Dec } from "./decimal";

export type Mode = "backtest" | "paper" | "testnet" | "live";

export interface BotConfig {
  symbol: string;
  /** Стартовий капітал бота (виділений), USDT. */
  balance: Dec;
  /** Плановий ризик на угоду, частка. */
  riskFraction: Dec;
  /** Taker-комісія за сторону, частка. */
  takerFee: Dec;
  /** Несприятливе прослизання за сторону, частка. */
  slippage: Dec;
  /** Комісія споту для порівняння з купівлею BTC, частка. */
  spotFee: Dec;
  /** Плече першої версії — 1x, не налаштовується. */
  leverage: Dec;
  entryWindowMs: number;
  pollMs: number;
  dataDir: string;
}

const num = (env: NodeJS.ProcessEnv, key: string, fallback: string, min: number, max: number): Dec => {
  const raw = env[key]?.trim() || fallback;
  const v = dec(raw);
  if (!v.isFinite() || v.lt(min) || v.gt(max)) throw new Error(`${key}=${raw}: очікується число від ${min} до ${max}`);
  return v;
};

/** Підвантажити .env (Node 22: process.loadEnvFile), якщо файл є. Наявні змінні оточення не перезаписуються. */
export function loadEnvFile(path = ".env") {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const symbol = (env.B2010_SYMBOL?.trim() || "BTCUSDT").toUpperCase();
  if (symbol !== "BTCUSDT") throw new Error("перша версія торгує лише BTCUSDT");
  return {
    symbol,
    balance: num(env, "B2010_BALANCE", "500", 1, 1e9),
    riskFraction: num(env, "B2010_RISK_PCT", "0.5", 0.01, 5).div(100),
    takerFee: num(env, "B2010_TAKER_FEE_PCT", "0.055", 0, 1).div(100),
    slippage: num(env, "B2010_SLIPPAGE_PCT", "0.05", 0, 5).div(100),
    spotFee: num(env, "B2010_SPOT_FEE_PCT", "0.1", 0, 1).div(100),
    leverage: dec(1),
    entryWindowMs: num(env, "B2010_ENTRY_WINDOW_SEC", "120", 10, 3600).toNumber() * 1000,
    pollMs: num(env, "B2010_POLL_MS", "2000", 500, 60000).toNumber(),
    dataDir: env.B2010_DATA_DIR?.trim() || ".b2010",
  };
}

export function credentials(mode: "testnet" | "live", env: NodeJS.ProcessEnv = process.env): { key: string; secret: string } {
  const [k, s] = mode === "testnet" ? ["BYBIT_TESTNET_API_KEY", "BYBIT_TESTNET_API_SECRET"] : ["BYBIT_API_KEY", "BYBIT_API_SECRET"];
  const key = env[k]?.trim();
  const secret = env[s]?.trim();
  if (!key || !secret) throw new Error(`${mode}: задайте ${k} і ${s} в оточенні або .env`);
  return { key, secret };
}

/** Live лише за явного вибору режиму, прапорця --confirm-live і B2010_LIVE_ENABLED=yes. */
export function liveAllowed(flag: boolean, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!flag) return "live потребує прапорця --confirm-live";
  if (env.B2010_LIVE_ENABLED?.trim() !== "yes") return "live потребує B2010_LIVE_ENABLED=yes в оточенні";
  return null;
}
