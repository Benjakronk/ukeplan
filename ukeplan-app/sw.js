'use strict';

const CACHE = 'ukeplan-shell-v33';
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

  // Same-origin GETs only: network-first so code/style changes show up on the
  // next load; fall back to the cached copy only when offline.
  if (url.origin !== self.location.origin) return;

  // `cache: 'no-cache'` forces the browser to revalidate against the server
  // (conditional request) so a stale HTTP-cached copy of script.js/styles.css
  // can't be served. Falls back to the SW cache only when offline.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(res => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
