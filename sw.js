// Splanner 오프라인 캐시
// 앱 파일을 바꿔 배포할 때는 VERSION을 올리면 아이패드에 새 버전이 받아진다.
const VERSION = "splanner-v5";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/style.css",
  "css/stats.css",
  "js/app.js",
  "js/stats.js",
  "js/ink.js",
  "js/install.js",
  "assets/planner.png",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  // 브라우저 보관본(HTTP 캐시)을 건너뛰고 서버에서 새로 받아 담는다
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 글꼴 · 갈무리 · 펜 라이브러리(CDN): 한 번 받으면 캐시에서
  if (url.origin !== location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // 앱 파일: 캐시를 먼저 보여주고, 뒤에서 새 버전을 받아 둔다
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req, { cache: "no-cache" }).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit || caches.match("index.html"));
      return hit || net;
    })
  );
});
