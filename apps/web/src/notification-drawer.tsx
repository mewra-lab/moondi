import { Drawer } from '@base-ui/react/drawer'
import type { ReactNode, RefObject } from 'react'
import { CloseIcon } from './icons'

export default function NotificationDrawer({ children, closeLabel, onClosed, onOpenChange, open, title, trigger }: {
  children: ReactNode
  closeLabel: string
  onClosed: () => void
  onOpenChange: (open: boolean) => void
  open: boolean
  title: string
  trigger: RefObject<HTMLButtonElement | null>
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} onOpenChangeComplete={(isOpen) => { if (!isOpen) onClosed() }}>
      <Drawer.Portal>
        <Drawer.Backdrop className="notification-backdrop" />
        <Drawer.Viewport className="notification-viewport">
          <Drawer.Popup className="notification-dialog" finalFocus={trigger}>
            <div className="notification-handle" aria-hidden="true" />
            <header className="notification-heading">
              <Drawer.Title>{title}</Drawer.Title>
              <Drawer.Close aria-label={closeLabel} className="portfolio-card-close"><CloseIcon /></Drawer.Close>
            </header>
            <Drawer.Content className="notification-drawer">
              {children}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
