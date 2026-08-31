self.addEventListener('push', (event) => {
  const payload = event.data ? event.data.json() : {}
  const title = typeof payload.title === 'string' ? payload.title : 'Moondi'
  const body = typeof payload.body === 'string' ? payload.body : ''
  const url = typeof payload.url === 'string' ? payload.url : '/'
  const tag = typeof payload.tag === 'string' ? payload.tag : 'moondi-sync'

  event.waitUntil(self.registration.showNotification(title, {
    badge: '/icon-192.png',
    body,
    data: { url },
    icon: '/icon-192.png',
    tag,
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data && typeof event.notification.data.url === 'string' ? event.notification.data.url : '/'

  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).pathname === url)
    return existing ? existing.focus() : self.clients.openWindow(url)
  }))
})
