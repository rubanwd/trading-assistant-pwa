/** Розбір RSS і Atom без DOM: у Workers немає DOMParser. Беремо лише заголовок, посилання й дату. */

export interface FeedItem {
  title: string;
  url: string;
  /** Час публікації, мс UTC; null, якщо стрічка його не дала. */
  ts: number | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1]!.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

/** Текст елемента: знімає CDATA, теги, сутності та керівні символи. */
function clean(raw: string): string {
  const text = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? clean(m[1]!) : null;
}

function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]!);
  const pick = links.find((a) => /rel=["']alternate["']/i.test(a)) ?? links.find((a) => !/rel=/i.test(a)) ?? links[0];
  const href = pick && /href=["']([^"']+)["']/i.exec(pick);
  return href ? decodeEntities(href[1]!) : null;
}

function httpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseFeed(xml: string, maxItems = 50): FeedItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].slice(0, maxItems);
  const out: FeedItem[] = [];
  for (const [block, kind] of blocks) {
    const title = tag(block, "title");
    const url = httpUrl(kind!.toLowerCase() === "entry" ? atomLink(block) : tag(block, "link"));
    if (!title || !url) continue;
    const date = tag(block, "pubDate") ?? tag(block, "published") ?? tag(block, "updated") ?? tag(block, "dc:date");
    const ts = date ? Date.parse(date) : NaN;
    out.push({ title: title.slice(0, 300), url, ts: Number.isFinite(ts) ? ts : null });
  }
  return out;
}

/** Ключ дедуплікації: адреса без параметрів запиту та фрагмента. */
export async function newsHash(url: string): Promise<string> {
  const u = new URL(url);
  const key = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
