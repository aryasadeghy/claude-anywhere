// Shows what the server pushes (lib/push.mjs) and opens the right session on a click. It caches
// nothing and handles no fetches: the app is always served live, and a worker that cached it
// would be one more stale copy to suspect when a change "does nothing".

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  // A push must always show something (userVisibleOnly): iOS drops the subscription of a worker that does not.
  e.waitUntil(self.registration.showNotification(d.title || 'Claude', {
    body: d.body || '', tag: d.tag || 'claude-anywhere', icon: '/icon-192.png', badge: '/icon-192.png',
    data: { url: d.url || '/', sessionId: d.sessionId || '' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = all.find((c) => new URL(c.url).origin === self.location.origin);
    // The app is open somewhere: show the session there rather than a second copy of the app.
    if (mine) { mine.postMessage({ t: 'open', url }); await mine.focus().catch(() => {}); return; }
    await self.clients.openWindow(url);
  })());
});
