// Appraisal Log service worker.
// Release checklist: bump CACHE_NAME and the ?v= numbers here AND in index.html / app.js imports.
const CACHE_NAME = "appraisallog-v1.1.0";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css?v=1.1.0",
  "./app.js?v=1.1.0",
  "./firebase-config.js?v=1.1.0",
  "./manifest.json",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png"
];
const CDN = [
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll([...APP_FILES, ...CDN]).catch(() => c.addAll(APP_FILES))));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Firestore, Google sign-in, Gemini: always network.
  if (/firestore\.googleapis|identitytoolkit|securetoken|googleapis\.com\/identity|generativelanguage|accounts\.google|apis\.google|firebaseapp\.com/.test(url.href)) return;

  // Versioned CDN libraries (Firebase SDK, jsPDF): cache first.
  if (url.hostname === "www.gstatic.com" || url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // App files: network first so updates show at once, cache when offline.
  if (url.origin === location.origin) {
    e.respondWith(fetch(req, { cache: "no-cache" }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: req.mode === "navigate" }).then(hit => hit || caches.match("./index.html"))));
  }
});
