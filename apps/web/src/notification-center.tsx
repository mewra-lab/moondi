import { lazy, Suspense, useRef, useState } from 'react'
import { BellIcon } from './icons'

const NotificationDrawer = lazy(() => import('./notification-drawer'))
const notificationStorageKey = 'moondi.notifications.v1'

export type NotificationItem = {
  id: string
  title: string
  detail?: string
  occurredAt: number
  target: 'transactions' | 'sync' | 'settings' | 'overview'
}

const readNotifications = (): string[] => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(notificationStorageKey) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

export const NotificationCenter = ({ dates, items, language, onOpen }: {
  dates: Intl.DateTimeFormat
  items: NotificationItem[]
  language: 'th' | 'en'
  onOpen: (target: NotificationItem['target']) => void
}) => {
  const trigger = useRef<HTMLButtonElement>(null)
  const pendingTarget = useRef<NotificationItem['target'] | null>(null)
  const [open, setOpen] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)
  const th = language === 'th'
  const [readIds, setReadIds] = useState(readNotifications)
  const read = new Set(readIds)
  const unread = items.filter((item) => !read.has(item.id)).length
  const title = th ? 'การแจ้งเตือน' : 'Notifications'

  const markRead = (ids: string[]) => {
    const next = [...new Set([...ids, ...readIds])].slice(0, 200)
    setReadIds(next)
    try {
      localStorage.setItem(notificationStorageKey, JSON.stringify(next))
    } catch {
      return
    }
  }

  const openTarget = (target: NotificationItem['target']) => {
    pendingTarget.current = target
    setOpen(false)
  }

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? `${title} · ${unread} ${th ? 'ยังไม่ได้อ่าน' : 'unread'}` : title}
        className="topbar-icon-btn notification-toggle"
        onClick={() => { setHasOpened(true); setOpen(true) }}
        ref={trigger}
        title={title}
        type="button"
      >
        <BellIcon />
        {unread ? <span aria-hidden="true" className="notification-dot" /> : null}
      </button>
      {hasOpened ? <Suspense fallback={null}>
        <NotificationDrawer
          closeLabel={th ? 'ปิด' : 'Close'}
          onClosed={() => {
            const target = pendingTarget.current
            pendingTarget.current = null
            if (target) onOpen(target)
          }}
          onOpenChange={setOpen}
          open={open}
          title={title}
          trigger={trigger}
        >
          <div className="notification-toolbar">
            <button className="chart-link" disabled={!unread} onClick={() => markRead(items.map((item) => item.id))} type="button">{th ? 'อ่านทั้งหมด' : 'Mark all as read'}</button>
            <button className="chart-link" onClick={() => openTarget('settings')} type="button">{th ? 'ตั้งค่า Push' : 'Push settings'}</button>
          </div>
          {items.length ? <ul className="notification-feed">
            {items.map((item) => <li key={item.id}>
              <button className={read.has(item.id) ? 'notification-row' : 'notification-row is-unread'} onClick={() => {
                markRead([item.id])
                openTarget(item.target)
              }} type="button">
                <span className="notification-marker" aria-label={read.has(item.id) ? undefined : (th ? 'ยังไม่ได้อ่าน' : 'Unread')} />
                <span className="notification-copy">
                  <strong>{item.title}</strong>
                  {item.detail ? <span>{item.detail}</span> : null}
                </span>
                <time dateTime={new Date(item.occurredAt).toISOString()}>{dates.format(item.occurredAt)}</time>
              </button>
            </li>)}
          </ul> : <p className="notification-empty">{th ? 'ยังไม่มีการแจ้งเตือน' : 'No notifications yet'}</p>}
        </NotificationDrawer>
      </Suspense> : null}
    </>
  )
}
