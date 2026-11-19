// 비트밥스 서비스 워커: 홈 화면 앱으로 설치할 수 있게 하고, 인터넷이 끊겼을 때 마지막으로 본 화면을 보여 줌
// 항상 새 파일을 먼저 받아서(네트워크 우선) 업데이트가 바로 반영됨. 다른 사이트(지도·음악·서버) 요청은 건드리지 않음
const CACHE = "song-meal-v4.6";
const SHELL = ["./", "index.html", "lang.js", "lang-data.js", "privacy.html", "icon-192.png?v=4", "icon-512.png?v=4", "apple-touch-icon.png?v=4", "mascot.png?v=4"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error()))));
});
