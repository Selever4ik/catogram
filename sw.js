self.addEventListener('install', (event) => {
    console.log('🐱 Service Worker установлен');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('🐱 Service Worker активирован');
    event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    const options = {
        body: data.body || 'Новое сообщение',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🐱</text></svg>',
        badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🐱</text></svg>',
        vibrate: [200, 100, 200, 100, 200],
        tag: data.tag || 'catogram-msg',
        requireInteraction: false,
        renotify: true,
        data: { url: data.url || '/' }
    };
    event.waitUntil(
        self.registration.showNotification(data.title || '🐱 Catogram', options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes(url) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(url);
            }
        })
    );
});