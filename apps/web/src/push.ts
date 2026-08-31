export type PushSubscribeResult =
  | { status: 'denied' }
  | { status: 'unsupported' }
  | { status: 'subscribed'; subscription: PushSubscription }

export const isPushSupported = (): boolean => (
  typeof window !== 'undefined'
  && 'Notification' in window
  && 'PushManager' in window
  && 'serviceWorker' in navigator
)

const base64urlToUint8Array = (base64url: string): Uint8Array<ArrayBuffer> => {
  const padded = base64url + '='.repeat((4 - (base64url.length % 4)) % 4)
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

const getRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
  if (!isPushSupported()) return null
  return await navigator.serviceWorker.ready
}

export const getCurrentPushSubscription = async (): Promise<PushSubscription | null> => {
  const registration = await getRegistration()
  return registration ? await registration.pushManager.getSubscription() : null
}

export const subscribeToPush = async (vapidPublicKey: string): Promise<PushSubscribeResult> => {
  if (!isPushSupported()) return { status: 'unsupported' }

  const permission = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission
  if (permission !== 'granted') return { status: 'denied' }

  const registration = await getRegistration()
  if (!registration) return { status: 'unsupported' }

  const existing = await registration.pushManager.getSubscription()
  if (existing) return { status: 'subscribed', subscription: existing }

  const subscription = await registration.pushManager.subscribe({
    applicationServerKey: base64urlToUint8Array(vapidPublicKey),
    userVisibleOnly: true,
  })
  return { status: 'subscribed', subscription }
}

export const unsubscribeFromPush = async (): Promise<string | null> => {
  const subscription = await getCurrentPushSubscription()
  if (!subscription) return null
  const endpoint = subscription.endpoint
  await subscription.unsubscribe()
  return endpoint
}
