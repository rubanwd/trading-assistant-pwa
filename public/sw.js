// Service worker: встановлення PWA, офлайн-кеш і сповіщення Web Push.
const CACHE = "assistant-v2";
// Відповіді API, які варто показати без мережі. Запити зі зміною даних (POST, PUT) не кешуються.
const API_CACHED = /^\/api\/(status|reports|signals|stats|candles|settings|playbook)(\/|\?|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add("/"))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Зберігає копію відповіді з позначкою часу: застосунок покаже, що дані з кешу. */
async function store(request, response) {
  const headers = new Headers(response.headers);
  headers.set("x-cached-at", new Date().toISOString());
  const copy = new Response(await response.clone().blob(), { status: response.status, statusText: response.statusText, headers });
  const cache = await caches.open(CACHE);
  await cache.put(request, copy);
}

/** Спершу мережа; без мережі збережена копія. Перенаправлення на вхід Access не кешується. */
async function networkFirst(request, fallbackUrl) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic" && !response.redirected) await store(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await caches.match(request)) ?? (fallbackUrl ? await caches.match(fallbackUrl) : undefined);
    if (cached) return cached;
    throw error;
  }
}

/** Зібрані файли мають хеш у назві, тож їх можна брати з кешу без перевірки. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/"));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else if (API_CACHED.test(url.pathname)) {
    event.respondWith(networkFirst(request));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" ? data.title : "Асистент трейдера";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      icon: "/icon.svg",
      data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/" },
    }),
  );
});

// Дотик до сповіщення відкриває свій звіт чи сигнал у вже відкритому застосунку або в новому вікні.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const open = clients[0];
      if (open) {
        await open.navigate(url).catch(() => {});
        return open.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
