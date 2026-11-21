import { Dialog } from '@base-ui/react/dialog'
import { Drawer } from '@base-ui/react/drawer'
import { useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { CloseIcon } from './icons'

const mobileQuery = '(max-width: 700px)'

const subscribeToMobileLayout = (onChange: () => void) => {
  const query = window.matchMedia(mobileQuery)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

const isMobileLayout = () => window.matchMedia(mobileQuery).matches

export default function AppOverlay({ children, closeLabel, description, onClose, open, popupRef, title }: {
  children: ReactNode
  closeLabel: string
  description?: string
  onClose: () => void
  open: boolean
  popupRef?: RefObject<HTMLDivElement | null>
  title: string
}) {
  const mobile = useSyncExternalStore(subscribeToMobileLayout, isMobileLayout)
  const onOpenChange = (next: boolean) => { if (!next) onClose() }

  if (mobile) {
    return (
      <Drawer.Root open={open} onOpenChange={onOpenChange} swipeDirection="down">
        <Drawer.Portal>
          <Drawer.Backdrop className="app-overlay-backdrop app-overlay-backdrop-swipe" />
          <Drawer.Viewport className="app-overlay-viewport app-overlay-viewport-sheet">
            <Drawer.Popup className="app-overlay-popup app-overlay-sheet" ref={popupRef}>
              <div aria-hidden="true" className="app-overlay-handle" />
              <header className="app-overlay-header">
                <div>
                  <Drawer.Title>{title}</Drawer.Title>
                  {description ? <Drawer.Description>{description}</Drawer.Description> : null}
                </div>
                <Drawer.Close aria-label={closeLabel} className="portfolio-card-close"><CloseIcon height={16} width={16} /></Drawer.Close>
              </header>
              <Drawer.Content className="app-overlay-content">{children}</Drawer.Content>
            </Drawer.Popup>
          </Drawer.Viewport>
        </Drawer.Portal>
      </Drawer.Root>
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="app-overlay-backdrop" />
        <Dialog.Viewport className="app-overlay-viewport">
          <Dialog.Popup className="app-overlay-popup" ref={popupRef}>
            <header className="app-overlay-header">
              <div>
                <Dialog.Title>{title}</Dialog.Title>
                {description ? <Dialog.Description>{description}</Dialog.Description> : null}
              </div>
              <Dialog.Close aria-label={closeLabel} className="portfolio-card-close"><CloseIcon height={16} width={16} /></Dialog.Close>
            </header>
            <div className="app-overlay-content">{children}</div>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
