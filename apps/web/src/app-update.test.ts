import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkForServiceWorkerUpdate, clearLocalSettings, type UpdateRegistration } from './app-update'

class FakeWorker extends EventTarget {
  state: ServiceWorkerState = 'installing'
}

const makeStorage = (entries: Record<string, string>) => {
  const map = new Map(Object.entries(entries))
  return {
    map,
    get length() { return map.size },
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('checkForServiceWorkerUpdate', () => {
  it('reports none right after update when nothing is installing', async () => {
    const update = vi.fn(async () => undefined)
    await expect(checkForServiceWorkerUpdate({ installing: null, update })).resolves.toBe('none')
    expect(update).toHaveBeenCalledOnce()
  })

  it('does not wait when the worker already finished installing', async () => {
    const worker = new FakeWorker()
    worker.state = 'installed'
    await expect(checkForServiceWorkerUpdate({ installing: worker, update: async () => undefined })).resolves.toBe('installed')
  })

  it('reports failed when the worker is already redundant', async () => {
    const worker = new FakeWorker()
    worker.state = 'redundant'
    await expect(checkForServiceWorkerUpdate({ installing: worker, update: async () => undefined })).resolves.toBe('failed')
  })

  it('waits for the installing worker and reports installed', async () => {
    const worker = new FakeWorker()
    const registration: UpdateRegistration = { installing: worker, update: async () => undefined }
    let outcome: string | undefined
    const pending = checkForServiceWorkerUpdate(registration).then((value) => { outcome = value })
    await Promise.resolve()
    await Promise.resolve()
    expect(outcome).toBeUndefined()
    worker.state = 'installed'
    worker.dispatchEvent(new Event('statechange'))
    await pending
    expect(outcome).toBe('installed')
  })

  it('reports failed when the install ends redundant', async () => {
    const worker = new FakeWorker()
    const pending = checkForServiceWorkerUpdate({ installing: worker, update: async () => undefined })
    await Promise.resolve()
    await Promise.resolve()
    worker.state = 'redundant'
    worker.dispatchEvent(new Event('statechange'))
    await expect(pending).resolves.toBe('failed')
  })

  it('reports failed after the timeout when the worker never finishes', async () => {
    vi.useFakeTimers()
    const worker = new FakeWorker()
    const pending = checkForServiceWorkerUpdate({ installing: worker, update: async () => undefined }, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBe('failed')
  })

  it('propagates a failed update check', async () => {
    await expect(checkForServiceWorkerUpdate({ installing: null, update: async () => { throw new Error('offline') } })).rejects.toThrow('offline')
  })
})

describe('clearLocalSettings', () => {
  it('removes only moondi keys and reports the count', () => {
    const storage = makeStorage({
      'moondi.language.v1': 'en',
      'moondi.notifications.v1': '[]',
      'moondi.theme.v1': 'light',
      other: 'keep',
      'xmoondi.theme': 'keep',
    })
    expect(clearLocalSettings(storage)).toBe(3)
    expect([...storage.map.keys()].sort()).toEqual(['other', 'xmoondi.theme'])
  })

  it('keeps the listed keys', () => {
    const storage = makeStorage({ 'moondi.notification-preferences.v1': '{}', 'moondi.theme.v1': 'light' })
    expect(clearLocalSettings(storage, ['moondi.notification-preferences.v1'])).toBe(1)
    expect([...storage.map.keys()]).toEqual(['moondi.notification-preferences.v1'])
  })

  it('is a no-op on empty storage', () => {
    expect(clearLocalSettings(makeStorage({}))).toBe(0)
  })
})
