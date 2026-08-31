import assert from 'node:assert/strict'
import test from 'node:test'

import { configureWorkerExamples } from './write-install-config.mjs'

test('writes installation-specific binding names without changing the examples', () => {
  const apiExample = {
    name: 'moondi-api',
    workers_dev: true,
    preview_urls: false,
    vars: { ALLOWED_ORIGIN: 'https://your-pages-project.pages.dev' },
    d1_databases: [{ binding: 'DB', database_name: 'moondi', database_id: 'placeholder' }],
    kv_namespaces: [{ binding: 'CACHE', id: 'placeholder' }],
    services: [{ binding: 'SYNC', service: 'moondi-sync' }],
  }
  const syncExample = {
    name: 'moondi-sync',
    workers_dev: false,
    preview_urls: false,
    d1_databases: [{ binding: 'DB', database_name: 'moondi', database_id: 'placeholder' }],
    kv_namespaces: [{ binding: 'CACHE', id: 'placeholder' }],
  }

  const { api, sync } = configureWorkerExamples({
    apiExample,
    syncExample,
    options: {
      apiWorkerName: 'owner-api',
      syncWorkerName: 'owner-sync',
      pagesOrigin: 'https://owner.pages.dev',
      dbName: 'owner-db',
      dbId: '11111111-1111-1111-1111-111111111111',
      kvId: '0123456789abcdef0123456789abcdef',
    },
  })

  assert.equal(api.name, 'owner-api')
  assert.equal(sync.name, 'owner-sync')
  assert.equal(api.vars.ALLOWED_ORIGIN, 'https://owner.pages.dev')
  assert.equal(api.workers_dev, true)
  assert.equal(api.preview_urls, false)
  assert.equal(sync.workers_dev, false)
  assert.equal(sync.preview_urls, false)
  assert.equal(api.services[0].service, 'owner-sync')
  assert.equal(api.d1_databases[0].database_name, 'owner-db')
  assert.equal(sync.d1_databases[0].database_id, '11111111-1111-1111-1111-111111111111')
  assert.equal(api.kv_namespaces[0].id, '0123456789abcdef0123456789abcdef')
  assert.equal(apiExample.name, 'moondi-api')
  assert.equal(syncExample.kv_namespaces[0].id, 'placeholder')
})
