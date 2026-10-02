// Network first, so the remote is never stale; the cached shell only shows
// when the laptop is unreachable, which beats a browser error page.
const CACHE = "hypr-remote-v4";
const SHELL = ["/", "/app.js", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/fonts/Geist-Variable.woff2"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE && key !== "hypr-remote-share").map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Android's share sheet posts here with no token. Park what was shared and
  // reopen the page, which sends it on with the token.
  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith(
      (async () => {
        const data = await event.request.formData();
        const cache = await caches.open("hypr-remote-share");
        await cache.put("/shared", new Response(data));
        return Response.redirect("/?shared=1", 303);
      })(),
    );
    return;
  }
  // The tokenised manifest names a secret in start_url. Caching it by pathname
  // would hand that secret to the next reader, no-store on the response aside.
  if (url.search) return;
  // Only the shell. Screenshots, uploads and the socket always go live.
  if (event.request.method !== "GET" || !SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
        return response;
      })
      .catch(() => caches.match(url.pathname)),
  );
});
