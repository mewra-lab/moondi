export const updateInstallTimeoutMs = 15_000

export type UpdateRegistration = {
  installing: Pick<ServiceWorker, 'addEventListener' | 'removeEventListener' | 'state'> | null
  update: () => Promise<unknown>
}

export type UpdateCheckOutcome = 'failed' | 'installed' | 'none'

export const checkForServiceWorkerUpdate = async (registration: UpdateRegistration, timeoutMs: number = updateInstallTimeoutMs): Promise<UpdateCheckOutcome> => {
  await registration.update()
  const installing = registration.installing
  if (!installing) return 'none'
  if (installing.state !== 'installing') return installing.state === 'redundant' ? 'failed' : 'installed'
  return await new Promise<UpdateCheckOutcome>((resolve) => {
    const finish = (outcome: UpdateCheckOutcome) => {
      clearTimeout(timer)
      installing.removeEventListener('statechange', onStateChange)
      resolve(outcome)
    }
    const onStateChange = () => {
      if (installing.state !== 'installing') finish(installing.state === 'redundant' ? 'failed' : 'installed')
    }
    const timer = setTimeout(() => finish('failed'), timeoutMs)
    installing.addEventListener('statechange', onStateChange)
  })
}

export const localSettingsPrefix = 'moondi.'

export const clearLocalSettings = (storage: Pick<Storage, 'key' | 'length' | 'removeItem'>, keep: readonly string[] = []): number => {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null && key.startsWith(localSettingsPrefix) && !keep.includes(key)) keys.push(key)
  }
  keys.forEach((key) => storage.removeItem(key))
  return keys.length
}
