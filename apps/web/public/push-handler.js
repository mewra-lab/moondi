self.addEventListener('push', (event) => {
  let payload = {}
  try {
    const parsed = event.data ? event.data.json() : {}
    if (parsed && typeof parsed === 'object') payload = parsed
  } catch {
    payload = {}
  }
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
  const requestedUrl = event.notification.data && typeof event.notification.data.url === 'string' ? event.notification.data.url : '/'
  let url = new URL('/', self.location.origin)
  try {
    const parsed = new URL(requestedUrl, self.location.origin)
    if (parsed.origin === self.location.origin) url = parsed
  } catch {
    // Keep the safe same-origin fallback.
  }

  event.waitUntil(self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
    const existing = clients.find((client) => {
      const clientUrl = new URL(client.url)
      return clientUrl.origin === url.origin && clientUrl.pathname === url.pathname
    })
    return existing ? existing.focus() : self.clients.openWindow(url.href)
  }))
})
