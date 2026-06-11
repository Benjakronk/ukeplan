'use strict';

const CACHE = 'ukeplan-shell-v13';
const ASSETS = [
  './',
  'index.html',
  'teacher.html',
  'rich.js',
  'docx.js',
  'script.js',
  'teacher.js',
  'styles.css',
  'teacher.css',
  'manifest.json',
  'icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Apps Script API: never intercept — let localStorage handle data caching.
  if (url.hostname.includes('script.google.com')) return;

  // Same-origin GETs only: cache-first, with background revalidation.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
