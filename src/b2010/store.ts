/**
 * Стан бота в SQLite (node:sqlite): сигнали, наміри ордерів, угоди, виконання, фандинг, події, денна equity.
 * Час — у UTC (ISO-рядки або мс). API-ключі сюди не пишуться.
 */
import { DatabaseSync } from "node:sqlite";
import { dec, dsum, type Dec } from "./decimal";
import type { Side } from "./types";

export type SignalStatus = "detected" | "entering" | "entered" | "skipped" | "expired" | "ignored";
export type IntentKind = "entry" | "close";
export type IntentStatus = "pending" | "sent" | "unknown" | "done" | "failed";

export interface SignalRow {
  day: string;
  side: Side;
  close: string;
  upper: string;
  lower: string;
  status: SignalStatus;
  reason: string | null;
  message: string | null;
}

export interface IntentRow {
  link_id: string;
  kind: IntentKind;
  signal_day: string | null;
  trade_id: number | null;
  side: Side;
  qty: string;
  stop: string | null;
  planned_risk: string | null;
  entry_ref: string | null;
  status: IntentStatus;
  order_id: string | null;
  detail: string | null;
  created_at: string;
}

export interface TradeRow {
  id: number;
  signal_day: string;
  side: Side;
  qty: string;
  entry_price: string;
  entry_ref: string;
  entry_time: number;
  entry_fee: string;
  initial_stop: string;
  stop: string;
  planned_risk: string;
  exit_price: string | null;
  exit_ref: string | null;
  exit_time: number | null;
  exit_fee: string | null;
  exit_reason: string | null;
  funding: string;
  net: string | null;
  status: "open" | "closed";
}

export interface EventRow {
  id: number;
  ts: string;
  level: "info" | "warn" | "critical";
  kind: string;
  message: string;
}

const SCHEMA = `
create table if not exists kv (key text primary key, value text not null);
create table if not exists signals (
  day text primary key, side text not null, close text not null, upper text not null, lower text not null,
  status text not null, reason text, message text, created_at text not null, updated_at text not null
);
create table if not exists intents (
  link_id text primary key, kind text not null, signal_day text, trade_id integer, side text not null, qty text not null,
  stop text, planned_risk text, entry_ref text, status text not null, order_id text, detail text,
  created_at text not null, updated_at text not null
);
create table if not exists trades (
  id integer primary key autoincrement, signal_day text not null unique, side text not null, qty text not null,
  entry_price text not null, entry_ref text not null, entry_time integer not null, entry_fee text not null,
  initial_stop text not null, stop text not null, planned_risk text not null,
  exit_price text, exit_ref text, exit_time integer, exit_fee text, exit_reason text,
  funding text not null default '0', net text, status text not null
);
create table if not exists fills (
  exec_id text primary key, trade_id integer, link_id text, side text not null, qty text not null, price text not null,
  fee text not null, time integer not null
);
create table if not exists funding (ts integer not null, trade_id integer not null, amount text not null, primary key (ts, trade_id));
create table if not exists events (id integer primary key autoincrement, ts text not null, level text not null, kind text not null, message text not null);
create table if not exists equity (day text primary key, equity text not null);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly clock: () => number = Date.now,
    private readonly echo: (e: Omit<EventRow, "id">) => void = () => {},
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  private iso() {
    return new Date(this.clock()).toISOString();
  }

  close() {
    this.db.close();
  }

  get(key: string): string | null {
    const r = this.db.prepare("select value from kv where key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  set(key: string, value: string | null) {
    if (value === null) this.db.prepare("delete from kv where key = ?").run(key);
    else this.db.prepare("insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
  }

  event(level: EventRow["level"], kind: string, message: string) {
    const ts = this.iso();
    this.db.prepare("insert into events (ts, level, kind, message) values (?, ?, ?, ?)").run(ts, level, kind, message);
    this.echo({ ts, level, kind, message });
  }

  events(limit = 50): EventRow[] {
    return this.db.prepare("select * from events order by id desc limit ?").all(limit) as unknown as EventRow[];
  }

  /** Записати сигнал один раз. false — цей день уже оброблено (повтор події або рестарт). */
  insertSignal(s: Omit<SignalRow, "status" | "reason" | "message">): boolean {
    const now = this.iso();
    const r = this.db
      .prepare("insert or ignore into signals (day, side, close, upper, lower, status, created_at, updated_at) values (?, ?, ?, ?, ?, 'detected', ?, ?)")
      .run(s.day, s.side, s.close, s.upper, s.lower, now, now);
    return Number(r.changes) === 1;
  }

  signal(day: string): SignalRow | null {
    return (this.db.prepare("select * from signals where day = ?").get(day) as unknown as SignalRow | undefined) ?? null;
  }

  signals(): SignalRow[] {
    return this.db.prepare("select * from signals order by day").all() as unknown as SignalRow[];
  }

  setSignal(day: string, status: SignalStatus, reason: string | null = null, message: string | null = null) {
    this.db.prepare("update signals set status = ?, reason = ?, message = ?, updated_at = ? where day = ?").run(status, reason, message, this.iso(), day);
  }

  insertIntent(i: Omit<IntentRow, "status" | "order_id" | "detail" | "created_at">): boolean {
    const now = this.iso();
    const r = this.db
      .prepare(
        "insert or ignore into intents (link_id, kind, signal_day, trade_id, side, qty, stop, planned_risk, entry_ref, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run(i.link_id, i.kind, i.signal_day, i.trade_id, i.side, i.qty, i.stop, i.planned_risk, i.entry_ref, now, now);
    return Number(r.changes) === 1;
  }

  intent(link: string): IntentRow | null {
    return (this.db.prepare("select * from intents where link_id = ?").get(link) as unknown as IntentRow | undefined) ?? null;
  }

  /** Наміри без підтвердженого кінцевого стану. */
  unresolvedIntents(): IntentRow[] {
    return this.db.prepare("select * from intents where status in ('pending', 'sent', 'unknown') order by created_at").all() as unknown as IntentRow[];
  }

  intentsForTrade(tradeId: number): IntentRow[] {
    return this.db.prepare("select * from intents where trade_id = ?").all(tradeId) as unknown as IntentRow[];
  }

  setIntent(link: string, status: IntentStatus, patch: { order_id?: string; detail?: string; trade_id?: number } = {}) {
    this.db
      .prepare(
        "update intents set status = ?, order_id = coalesce(?, order_id), detail = coalesce(?, detail), trade_id = coalesce(?, trade_id), updated_at = ? where link_id = ?",
      )
      .run(status, patch.order_id ?? null, patch.detail ?? null, patch.trade_id ?? null, this.iso(), link);
  }

  openTrade(): TradeRow | null {
    return (this.db.prepare("select * from trades where status = 'open' order by id desc limit 1").get() as unknown as TradeRow | undefined) ?? null;
  }

  trade(id: number): TradeRow | null {
    return (this.db.prepare("select * from trades where id = ?").get(id) as unknown as TradeRow | undefined) ?? null;
  }

  trades(): TradeRow[] {
    return this.db.prepare("select * from trades order by id").all() as unknown as TradeRow[];
  }

  insertTrade(t: Omit<TradeRow, "id" | "exit_price" | "exit_ref" | "exit_time" | "exit_fee" | "exit_reason" | "funding" | "net" | "status" | "stop">): number {
    const r = this.db
      .prepare(
        "insert into trades (signal_day, side, qty, entry_price, entry_ref, entry_time, entry_fee, initial_stop, stop, planned_risk, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')",
      )
      .run(t.signal_day, t.side, t.qty, t.entry_price, t.entry_ref, t.entry_time, t.entry_fee, t.initial_stop, t.initial_stop, t.planned_risk);
    return Number(r.lastInsertRowid);
  }

  setStop(id: number, stop: string) {
    this.db.prepare("update trades set stop = ? where id = ?").run(stop, id);
  }

  closeTrade(id: number, x: { exit_price: string; exit_ref: string; exit_time: number; exit_fee: string; exit_reason: string; net: string }) {
    this.db
      .prepare("update trades set exit_price = ?, exit_ref = ?, exit_time = ?, exit_fee = ?, exit_reason = ?, net = ?, status = 'closed' where id = ?")
      .run(x.exit_price, x.exit_ref, x.exit_time, x.exit_fee, x.exit_reason, x.net, id);
  }

  /** Виконання записуються один раз (exec_id). */
  insertFill(f: { exec_id: string; trade_id: number | null; link_id: string; side: string; qty: string; price: string; fee: string; time: number }): boolean {
    const r = this.db
      .prepare("insert or ignore into fills (exec_id, trade_id, link_id, side, qty, price, fee, time) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(f.exec_id, f.trade_id, f.link_id, f.side, f.qty, f.price, f.fee, f.time);
    return Number(r.changes) === 1;
  }

  fillIds(): Set<string> {
    return new Set((this.db.prepare("select exec_id from fills").all() as { exec_id: string }[]).map((r) => r.exec_id));
  }

  /** Нарахування фандингу один раз на момент; оновлює суму в угоді. */
  addFunding(tradeId: number, ts: number, amount: Dec): boolean {
    const r = this.db.prepare("insert or ignore into funding (ts, trade_id, amount) values (?, ?, ?)").run(ts, tradeId, amount.toString());
    if (Number(r.changes) !== 1) return false;
    const rows = this.db.prepare("select amount from funding where trade_id = ?").all(tradeId) as { amount: string }[];
    this.db.prepare("update trades set funding = ? where id = ?").run(dsum(rows.map((x) => dec(x.amount))).toString(), tradeId);
    return true;
  }

  /** Капітал бота: стартовий + чистий результат закритих угод − комісія входу й + фандинг відкритої. */
  equity(start: Dec): Dec {
    let eq = start;
    for (const t of this.trades()) {
      if (t.status === "closed") eq = eq.add(dec(t.net ?? "0"));
      else eq = eq.sub(dec(t.entry_fee)).add(dec(t.funding));
    }
    return eq;
  }

  /** Реалізований капітал без відкритої угоди: від нього рахується ризик нової. */
  realizedEquity(start: Dec): Dec {
    return this.trades()
      .filter((t) => t.status === "closed")
      .reduce((s, t) => s.add(dec(t.net ?? "0")), start);
  }

  setEquity(day: string, equity: Dec) {
    this.db.prepare("insert into equity (day, equity) values (?, ?) on conflict(day) do update set equity = excluded.equity").run(day, equity.toString());
  }

  blockReasons(): string[] {
    const raw = this.get("block");
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  setBlock(reasons: string[]) {
    this.set("block", reasons.length ? JSON.stringify([...new Set(reasons)]) : null);
  }
}

