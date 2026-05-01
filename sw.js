self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : {};
    event.waitUntil(
        self.registration.showNotification(data.title || 'Catogram 🐱', {
            body: data.body || 'Новое сообщение',
            vibrate: [200, 100, 200],
            tag: 'catogram'
        })
    );
});
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(clients.openWindow('/'));
});