// Plot CRM service worker — FCM background push + FAST caching
// HTML pages = network-first (update turant dikhe), baaki assets = cache-first / SWR (fast).
importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCZ_kgx4ErVZjw0YYPyJiCT70DFyE0HUTA",
  authDomain: "plot-crm.firebaseapp.com",
  projectId: "plot-crm",
  storageBucket: "plot-crm.firebasestorage.app",
  messagingSenderId: "795511910978",
  appId: "1:795511910978:web:04483a426fe865c96c73db"
});
firebase.messaging();   // background notifications (auto-display)

const APP_URL = 'https://akshardhamassociate.github.io/plot-crm/';
const CACHE = 'plotcrm-v3';   // bump → purani cache (stale calllog.html) apne aap saaf

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));   // purani cache saaf
  await self.clients.claim();
})()));

// app-icon badge on push
self.addEventListener('push', e => {
  try {
    const data = e.data ? e.data.json() : {};
    const n = (data.data && data.data.badge) ? parseInt(data.data.badge, 10) : 0;
    if (self.registration && navigator.setAppBadge) { n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge(); }
  } catch (_) {}
});
// notification tap → app kholo
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.includes('plot-crm') && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(APP_URL);
  }));
});

// ── caching ──
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url; try { url = new URL(req.url); } catch (_) { return; }

  // NEVER cache live data (Firestore / auth / FCM) — seedha network
  if (/firestore\.googleapis|firebaseinstallations|fcmregistrations|identitytoolkit|securetoken|firebasedatabase/.test(url.href)) return;

  // Firebase SDK + Google Fonts = kabhi badalte nahi → cache-first (sabse bada speed win)
  if (url.hostname === 'www.gstatic.com' || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin === self.location.origin) {
    // HTML pages (index.html / calllog.html / navigations) → NETWORK-FIRST:
    // hamesha latest lao; net na ho to cache se. Isse koi bhi update turant dikhta hai.
    const isPage = req.mode === 'navigate' || req.destination === 'document' || url.pathname.endsWith('.html');
    if (isPage) {
      e.respondWith((async () => {
        const c = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          if (res && res.ok) c.put(req, res.clone());
          return res;
        } catch (_) {
          return (await c.match(req)) || (await c.match(APP_URL));
        }
      })());
      return;
    }
    // baaki app files (icons, manifest, etc.) → stale-while-revalidate (fast + background update)
    e.respondWith(caches.open(CACHE).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(res => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }

  // baaki sab: network, fail ho to cache
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});
