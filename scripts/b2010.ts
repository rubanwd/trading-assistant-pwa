/**
 * Бот пробою 20/10 для BTCUSDT (Bybit linear perpetual). Локально, не на Cloudflare.
 *   npm run b2010 -- download
 *   npm run b2010 -- backtest [--from 2020-04-15] [--to 2026-10-31]
 *   npm run b2010 -- paper
 *   npm run b2010 -- status | export
 * Довідка: npm run b2010 -- --help
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runBacktest, DataGapError, type BacktestConfig, type BacktestInput } from "../src/b2010/backtest";
import { bybitFeed } from "../src/b2010/broker";
import { BybitClient, BybitMarket, MAINNET, TESTNET } from "../src/b2010/bybit";
import { BybitBroker } from "../src/b2010/bybitBroker";
import { credentials, liveAllowed, loadConfig, loadEnvFile, type BotConfig } from "../src/b2010/config";
import { dec } from "../src/b2010/decimal";
import { describeGap, formatChecks, loadHistory, monthOf } from "../src/b2010/history";
import { acquireLock } from "../src/b2010/lock";
import { PaperBroker } from "../src/b2010/paper";
import { equityCsv, formatSummary, signalsCsv, summarize, tradesCsv } from "../src/b2010/report";
import { Runner } from "../src/b2010/runner";
import { Store, type TradeRow } from "../src/b2010/store";
import { DAY_MS, dayStart, isoDay } from "../src/b2010/strategy";
import type { InstrumentSpec } from "../src/b2010/types";

const HELP = `Бот пробою 20/10, BTCUSDT linear perpetual на Bybit.

  npm run b2010 -- <команда> [параметри]

Команди:
  download            завантажити й закешувати історію Bybit (денні й годинні свічки, ціна маркування, фандинг, спот)
  backtest            бектест: повний період, до контрольного й контрольний (останні 12 повних місяців),
                      базове та подвійне прослизання; файли в <data>/out/<from>_<to>/
  paper               paper-торгівля на публічних даних mainnet (режим за замовчуванням, без ключів)
  testnet             торгівля на testnet Bybit (BYBIT_TESTNET_API_KEY / _SECRET)
  live                реальні гроші: потрібні --confirm-live, B2010_LIVE_ENABLED=yes і BYBIT_API_KEY / _SECRET
  status              стан бота: позиція, блокування, сигнали, події (--mode paper|testnet|live)
  export              журнал угод у CSV (--mode, --out файл)

Параметри:
  --from YYYY-MM-DD   перша доба бектесту (типово перша, для якої є 20 свічок розігріву)
  --to YYYY-MM-DD     остання доба бектесту (типово кінець попереднього повного місяця)
  --mode M            для status/export: paper (типово), testnet, live
  --out FILE          для export: куди записати CSV (типово <data>/<mode>-trades.csv)
  --env FILE          файл оточення (типово .env)
  --confirm-live      дозвіл на live разом із B2010_LIVE_ENABLED=yes

Усе інше — у .env (див. .env.example): B2010_BALANCE, B2010_RISK_PCT, B2010_TAKER_FEE_PCT, B2010_SLIPPAGE_PCT,
B2010_ENTRY_WINDOW_SEC, B2010_POLL_MS, B2010_DATA_DIR.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string" },
    to: { type: "string" },
    mode: { type: "string" },
    out: { type: "string" },
    env: { type: "string" },
    "confirm-live": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0] ?? "paper";
if (values.help) {
  console.log(HELP);
  process.exit(0);
}
loadEnvFile(values.env ?? ".env");
const cfg = loadConfig();

const parseDay = (s: string, name: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`--${name}: очікується YYYY-MM-DD`);
  return Date.parse(`${s}T00:00:00Z`);
};

/** Кінець попереднього повного місяця. */
const lastFullMonthEnd = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - DAY_MS;
};

const addMonths = (ts: number, n: number) => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate());
};

async function instrumentSpec(market: BybitMarket, file: string): Promise<{ spec: InstrumentSpec; fetched: string }> {
  try {
    const spec = await market.instrument();
    const fetched = new Date().toISOString();
    await writeFile(file, JSON.stringify({ fetched, spec: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, String(v)])) }));
    return { spec, fetched };
  } catch (e) {
    if (!existsSync(file)) throw e;
    const saved = JSON.parse(await readFile(file, "utf8")) as { fetched: string; spec: Record<string, string> };
    console.warn(`instruments-info недоступний (${(e as Error).message}); беру збережені обмеження від ${saved.fetched}`);
    const s = saved.spec;
    return {
      fetched: saved.fetched,
      spec: { symbol: s.symbol, status: s.status, tickSize: dec(s.tickSize), qtyStep: dec(s.qtyStep), minOrderQty: dec(s.minOrderQty), minNotional: dec(s.minNotional), maxMktOrderQty: dec(s.maxMktOrderQty) },
    };
  }
}

async function history(c: BotConfig, fromMonth: string, toMonth: string) {
  const market = new BybitMarket(new BybitClient({ base: MAINNET }), c.symbol);
  const cacheDir = join(c.dataDir, "cache");
  await mkdir(cacheDir, { recursive: true });
  const spec = await instrumentSpec(market, join(cacheDir, `${c.symbol}-instrument.json`));
  const h = await loadHistory({ market, cacheDir, fromMonth, toMonth, log: (m) => console.log(m) });
  return { ...h, ...spec };
}

const retryHint = () => `Повторити: npm run b2010 -- ${process.argv.slice(2).join(" ")}`;

async function download() {
  const now = Date.now();
  const h = await history(cfg, values.from ? monthOf(parseDay(values.from, "from")) : "2020-03", monthOf(values.to ? parseDay(values.to, "to") : now));
  console.log(formatChecks(h.checks).join("\n"));
  console.log(`Обмеження контракту (instruments-info, ${h.fetched}): tickSize ${h.spec.tickSize}, qtyStep ${h.spec.qtyStep}, minOrderQty ${h.spec.minOrderQty}, minNotionalValue ${h.spec.minNotional}, maxMktOrderQty ${h.spec.maxMktOrderQty}, статус ${h.spec.status}`);
}

async function backtest() {
  const now = Date.now();
  const toReq = values.to ? parseDay(values.to, "to") : lastFullMonthEnd(now);
  const fromReq = values.from ? parseDay(values.from, "from") : null;
  // 21 день до першої доби — розігрів каналу; беремо з запасом місяць раніше.
  const fromMonth = fromReq === null ? "2020-03" : monthOf(fromReq - 40 * DAY_MS);
  const h = await history(cfg, fromMonth, monthOf(toReq));
  const lines: string[] = [];
  const out = (s = "") => {
    console.log(s);
    lines.push(s);
  };
  out("Перевірка даних Bybit:");
  for (const l of formatChecks(h.checks)) out(`  ${l}`);
  if (!h.daily.length) throw new Error("Bybit не повернув денних свічок");
  const from = Math.max(fromReq ?? 0, h.daily[Math.min(20, h.daily.length - 1)].openTime);
  const to = Math.min(toReq, h.daily[h.daily.length - 1].openTime);
  if (to <= from) throw new Error("порожній період");
  const daily = h.checks.find((c) => c.name.startsWith("денні свічки BTCUSDT perp"))!;
  const blocking = daily.gaps.filter((g) => g.to >= from - 20 * DAY_MS && g.from <= to + DAY_MS);
  if (blocking.length) {
    out("Неможливо перевірити: пропуски денних свічок у періоді (з розігрівом 20 діб):");
    for (const g of blocking) out(`  ${describeGap(g)}`);
    throw new DataGapError("звузьте --from/--to так, щоб період не містив пропусків");
  }
  for (const c of h.checks.filter((x) => x.name !== daily.name)) {
    const inPeriod = c.gaps.filter((g) => g.to >= from && g.from <= to + DAY_MS);
    if (inPeriod.length) out(`Увага: ${c.name} — пропусків у періоді: ${inPeriod.length}, перший ${describeGap(inPeriod[0])} (стоп/фандинг у ці години оцінено консервативно)`);
  }
  out("");
  out(`Обмеження ордера: сьогоднішні значення Bybit (instruments-info ${h.fetched.slice(0, 10)}) застосовано до всієї історії — датованих значень API не дає:`);
  out(`  tickSize ${h.spec.tickSize}, qtyStep ${h.spec.qtyStep}, minOrderQty ${h.spec.minOrderQty}, minNotionalValue ${h.spec.minNotional}, maxMktOrderQty ${h.spec.maxMktOrderQty}`);
  out(
    `Припущення: капітал ${cfg.balance} USDT, ризик ${cfg.riskFraction.mul(100)}%, taker ${cfg.takerFee.mul(100)}% і прослизання ${cfg.slippage.mul(100)}% за сторону, плече 1x; вхід за Open наступної доби.`,
  );
  out("");

  const input: BacktestInput = { daily: h.daily, hourly: h.hourly, markHourly: h.markHourly, funding: h.funding, spotDaily: h.spotDaily };
  const base: Omit<BacktestConfig, "from" | "to" | "slippage"> = {
    balance: cfg.balance,
    riskFraction: cfg.riskFraction,
    takerFee: cfg.takerFee,
    leverage: cfg.leverage,
    spec: h.spec,
    spotFee: cfg.spotFee,
  };
  // Контрольний період — останні 12 повних місяців до --to; параметри 20/10 за ним не підбираються.
  const toEnd = dayStart(to);
  const isMonthEnd = new Date(toEnd + DAY_MS).getUTCDate() === 1;
  const controlFrom = isMonthEnd ? addMonths(toEnd + DAY_MS, -12) : toEnd - 364 * DAY_MS;
  const periods: [string, number, number][] = [["Повний період", from, toEnd]];
  if (controlFrom - DAY_MS > from) periods.push(["До контрольного", from, controlFrom - DAY_MS]);
  if (controlFrom >= from) periods.push(["Контрольний (останні 12 повних місяців)", controlFrom, toEnd]);

  const dir = join(cfg.dataDir, "out", `${isoDay(from)}_${isoDay(toEnd)}`);
  await mkdir(dir, { recursive: true });
  const json: Record<string, unknown> = {};
  for (const [title, f, t] of periods) {
    const r = runBacktest(input, { ...base, from: f, to: t, slippage: cfg.slippage });
    const s = summarize(r);
    out(formatSummary(title, s));
    const r2 = runBacktest(input, { ...base, from: f, to: t, slippage: cfg.slippage.mul(2) });
    const s2 = summarize(r2);
    out(
      `  За подвійного прослизання (${cfg.slippage.mul(200)}%): ${s2.end.toFixed(2)} USDT (${s2.pnl.toFixed(2)}, ${s2.pnlPct.toFixed(2)}%), прослизання ${s2.slippage.toFixed(2)}, угод ${s2.trades}, просадка ${s2.maxDrawdownPct.toFixed(2)}%`,
    );
    out("");
    const tag = title.startsWith("Повний") ? "full" : title.startsWith("До") ? "pre" : "control";
    await writeFile(join(dir, `trades-${tag}.csv`), tradesCsv(r.trades));
    await writeFile(join(dir, `signals-${tag}.csv`), signalsCsv(r));
    await writeFile(join(dir, `equity-${tag}.csv`), equityCsv(r));
    json[tag] = { base: s, doubleSlippage: s2 };
  }
  await writeFile(join(dir, "report.txt"), lines.join("\n") + "\n");
  await writeFile(join(dir, "report.json"), JSON.stringify(json, (_k, v) => (v && typeof v === "object" && v.constructor?.name === "Decimal" ? String(v) : v), 2));
  console.log(`Файли: ${dir}/ (report.txt, report.json, trades-*.csv, signals-*.csv, equity-*.csv)`);
}

function openStore(mode: string, echo = true) {
  return new Store(join(cfg.dataDir, `${mode}.sqlite`), Date.now, (e) => {
    if (echo) console.log(`${e.ts} ${e.level.toUpperCase().padEnd(8)} ${e.kind}: ${e.message}`);
  });
}

async function trade(mode: "paper" | "testnet" | "live") {
  if (mode === "live") {
    const why = liveAllowed(values["confirm-live"]);
    if (why) throw new Error(why);
  }
  await mkdir(cfg.dataDir, { recursive: true });
  // Один процес на акаунт і символ: акаунт визначається режимом (окремі ключі для testnet і live).
  const release = acquireLock(join(cfg.dataDir, `${mode}-${cfg.symbol}.lock`));
  const store = openStore(mode);
  const base = mode === "testnet" ? TESTNET : MAINNET;
  const client = new BybitClient({ base, credentials: mode === "paper" ? undefined : credentials(mode) });
  const feed = bybitFeed(new BybitMarket(mode === "paper" ? new BybitClient({ base: MAINNET }) : client, cfg.symbol));
  const broker = mode === "paper" ? new PaperBroker(store, feed, cfg.takerFee, cfg.slippage) : new BybitBroker(mode, client, cfg.symbol, cfg.leverage);
  const runner = new Runner(store, feed, broker, {
    startBalance: cfg.balance,
    riskFraction: cfg.riskFraction,
    takerFee: cfg.takerFee,
    slippage: cfg.slippage,
    leverage: cfg.leverage,
    entryWindowMs: cfg.entryWindowMs,
    pollMs: cfg.pollMs,
    linkPrefix: "b2010",
  });
  const shutdown = () => {
    console.log("зупинка після поточного кроку…");
    runner.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    await runner.run();
  } finally {
    store.close();
    release();
  }
}

const tradeCsv = (rows: TradeRow[]) =>
  [
    "id,signal_day,side,qty,entry_time,entry_price,entry_ref,entry_fee,initial_stop,stop,planned_risk,exit_time,exit_price,exit_ref,exit_fee,exit_reason,funding,net,status",
    ...rows.map((t) =>
      [
        t.id,
        t.signal_day,
        t.side,
        t.qty,
        new Date(t.entry_time).toISOString(),
        t.entry_price,
        t.entry_ref,
        t.entry_fee,
        t.initial_stop,
        t.stop,
        t.planned_risk,
        t.exit_time ? new Date(t.exit_time).toISOString() : "",
        t.exit_price ?? "",
        t.exit_ref ?? "",
        t.exit_fee ?? "",
        t.exit_reason ?? "",
        t.funding,
        t.net ?? "",
        t.status,
      ].join(","),
    ),
  ].join("\n") + "\n";

function modeArg() {
  const m = values.mode ?? "paper";
  if (m !== "paper" && m !== "testnet" && m !== "live") throw new Error("--mode: paper | testnet | live");
  return m;
}

function status() {
  const mode = modeArg();
  if (!existsSync(join(cfg.dataDir, `${mode}.sqlite`))) return console.log(`Бази ${mode} ще немає: бот не запускався.`);
  const store = openStore(mode, false);
  console.log(`Режим ${mode}. Капітал бота: ${store.equity(cfg.balance).toFixed(2)} USDT (старт ${cfg.balance}).`);
  const t = store.openTrade();
  console.log(t ? `Позиція: ${t.side} ${t.qty} з ${new Date(t.entry_time).toISOString()} за ${t.entry_price}, стоп ${t.stop}, фандинг ${t.funding}` : "Позиції немає.");
  const block = store.blockReasons();
  console.log(block.length ? `Нові входи заблоковано: ${block.join("; ")}` : "Блокувань немає.");
  const ld = store.get("last_day");
  console.log(`Остання оброблена доба: ${ld ? isoDay(Number(ld)) : "—"}`);
  console.log("Сигнали:");
  for (const s of store.signals().slice(-10)) console.log(`  ${s.day} ${s.side} ${s.status}${s.reason ? ` (${s.reason})` : ""}${s.message ? `: ${s.message}` : ""}`);
  console.log("Події:");
  for (const e of store.events(20).reverse()) console.log(`  ${e.ts} ${e.level} ${e.kind}: ${e.message}`);
  store.close();
}

async function exportCsv() {
  const mode = modeArg();
  const store = openStore(mode, false);
  const file = values.out ?? join(cfg.dataDir, `${mode}-trades.csv`);
  await writeFile(file, tradeCsv(store.trades()));
  console.log(`Журнал угод: ${file} (${store.trades().length})`);
  store.close();
}

try {
  if (command === "download") await download();
  else if (command === "backtest") await backtest();
  else if (command === "paper" || command === "testnet" || command === "live") await trade(command);
  else if (command === "status") status();
  else if (command === "export") await exportCsv();
  else {
    console.log(HELP);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`Помилка: ${e instanceof Error ? e.message : String(e)}`);
  if (command === "download" || command === "backtest") console.error(retryHint());
  process.exitCode = 1;
}
