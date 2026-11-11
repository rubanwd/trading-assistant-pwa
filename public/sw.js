// Мінімальний service worker: потрібен для встановлення PWA і майбутніх push.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
