import { useEffect, useState } from "react";

/**
 * Жива ціна маркування з WebSocket Binance напряму з браузера: між сканами рушій не навантажується.
 * Якщо з'єднання немає (мережа, локація), повертає null, і екран показує ціну останнього скану.
 */
export function useLivePrice(symbol: string | null): number | null {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    if (!symbol) return;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let stopped = false;
    const connect = () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@markPrice@1s`);
      } catch {
        return;
      }
      ws.onmessage = (e) => {
        attempts = 0;
        try {
          const p = Number((JSON.parse(String(e.data)) as { p?: string }).p);
          if (Number.isFinite(p)) setPrice(p);
        } catch {
          /* не JSON */
        }
      };
      ws.onclose = () => {
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
      document.removeEventListener("visibilitychange", onVisibility);
      ws?.close();
    };
  }, [symbol]);
  return price;
}

/** Округлення ціни до розумної кількості знаків. */
export function fmtPrice(p: number): string {
  const digits = p >= 1000 ? 1 : p >= 10 ? 2 : p >= 1 ? 3 : 5;
  return p.toLocaleString("uk-UA", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
