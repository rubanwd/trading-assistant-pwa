import { useEffect, useState } from "react";
import { useDesk } from "./ui";

/** Ціна маркування з повідомлення потоку: Binance кладе її в p, Bybit — у data.markPrice (не в кожному оновленні). */
function markPrice(raw: string): number | null {
  try {
    const m = JSON.parse(raw) as { p?: string; data?: { markPrice?: string } };
    const v = Number(m.p ?? m.data?.markPrice);
    return m.p === undefined && m.data?.markPrice === undefined ? null : Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Жива ціна маркування з WebSocket біржі напряму з браузера: між сканами рушій не навантажується.
 * Крипто — потік Binance, акції — потік лінійних контрактів Bybit.
 * Якщо з'єднання немає (мережа, локація), повертає null, і екран показує ціну останнього скану.
 */
export function useLivePrice(symbol: string | null): number | null {
  const desk = useDesk();
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    if (!symbol) return;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let attempts = 0;
    let stopped = false;
    const connect = () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        ws =
          desk === "stocks"
            ? new WebSocket("wss://stream.bybit.com/v5/public/linear")
            : new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@markPrice@1s`);
      } catch {
        return;
      }
      if (desk === "stocks") {
        const sock = ws;
        sock.onopen = () => {
          sock.send(JSON.stringify({ op: "subscribe", args: [`tickers.${symbol}`] }));
          // Bybit закриває тихе з'єднання: пінг кожні 20 с.
          clearInterval(ping);
          ping = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify({ op: "ping" })), 20_000);
        };
      }
      ws.onmessage = (e) => {
        const p = markPrice(String(e.data));
        if (p !== null) {
          attempts = 0;
          setPrice(p);
        }
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (stopped || attempts >= 5) return;
        retry = setTimeout(connect, Math.min(30_000, 2_000 * 2 ** attempts++));
      };
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") ws?.close();
      else if (!ws || ws.readyState === WebSocket.CLOSED) {
        attempts = 0;
        connect();
      }
    };
    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      document.removeEventListener("visibilitychange", onVisibility);
      ws?.close();
    };
  }, [symbol, desk]);
  return price;
}

/** Округлення ціни до розумної кількості знаків. */
export function fmtPrice(p: number): string {
  const digits = p >= 1000 ? 1 : p >= 10 ? 2 : p >= 1 ? 3 : 5;
  return p.toLocaleString("uk-UA", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
