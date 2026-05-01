self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : {};
    const options = {
        body: data.body || 'Новое сообщение',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🐱</text></svg>',
        vibrate: [200, 100, 200, 100, 200],
        tag: data.tag || 'catogram',
        requireInteraction: false
    };
    event.waitUntil(
        self.registration.showNotification(data.title || 'Catogram 🐱', options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow('/')
    );
});