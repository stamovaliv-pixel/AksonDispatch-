self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data ? event.data.json() : {} } catch { payload = { body: event.data?.text() || '' } }
  const title = payload.title || 'Аксон Диспетчерская'
  const options = {
    body: payload.body || 'Поступило новое уведомление.',
    icon: '/apple-touch-icon.png',
    badge: '/apple-touch-icon.png',
    tag: payload.tag || 'akson-dispatch-notification',
    renotify: true,
    data: { url: payload.url || '/' }
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        await client.focus()
        if ('navigate' in client) await client.navigate(target)
        return
      }
    }
    if (clients.openWindow) await clients.openWindow(target)
  })())
})
