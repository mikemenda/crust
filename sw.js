// ============================================================
// CRUST — Service Worker
// Enables installability + offline asset caching.
// Firebase requests always go to network (never cached here).
//
// DEPLOY INSTRUCTIONS:
// Every time you push a new build to Netlify, increment the
// number in APP_VERSION below by 1.
// That's the only change needed to force all devices to update.
// ============================================================

const APP_VERSION = 50; // ← bump this number on every deploy
const CACHE = `crust-v${APP_VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/ui-polish.css',
  '/app.js',
  '/globe.js',
  '/manifest.json',
];

// Install: pre-cache core assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// Activate: purge old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch: skip Firebase + Google APIs (always network);
// cache-first for our own static assets.
self.addEventListener('fetch', e => {
  const { hostname } = new URL(e.request.url);
  if (
    hostname.includes('firebase') ||
    hostname.includes('googleapis') ||
    hostname.includes('gstatic')
  ) return; // let browser handle it normally

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Cache successful GET responses for our own origin
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
