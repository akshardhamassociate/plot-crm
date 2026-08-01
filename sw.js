// Plot CRM service worker — PWA offline cache + Firebase Cloud Messaging (background push)
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
firebase.messaging();   // enables auto-display of background notifications

// open the app when a notification is tapped
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('https://akshardhamassociate.github.io/plot-crm/'));
});

// offline cache (network-first)
const CACHE = 'plotcrm-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    fetch(req)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{}); return res; })
      .catch(() => caches.match(req))
  );
});
