import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

const buildDatabase = (statements) => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const statement of statements) database.exec(statement)
  return database
}

const describeDatabase = (database) => {
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all()

  return Object.fromEntries(tables.map(({ name }) => {
    const columns = database.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all()
      .map(({ name: columnName, type, notnull, dflt_value: defaultValue, pk }) => ({ columnName, defaultValue, notnull, pk, type }))
      .toSorted((left, right) => left.columnName.localeCompare(right.columnName))
    const indexes = database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
      ORDER BY name
    `).all(name).map(({ name: indexName, sql }) => ({
      columns: database.prepare(`PRAGMA index_info(${JSON.stringify(indexName)})`).all().map(({ name: columnName }) => columnName),
      indexName,
      unique: /CREATE UNIQUE INDEX/i.test(sql),
    }))
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all()
      .map(({ from, table, to }) => ({ from, table, to }))
      .toSorted((left, right) => `${left.from}:${left.table}:${left.to}`.localeCompare(`${right.from}:${right.table}:${right.to}`))
    return [name, { columns, foreignKeys, indexes }]
  }))
}

test('schema.sql matches the result of applying every migration', () => {
  const migrationsDirectory = `${repositoryRoot}db/migrations`
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()
    .map((name) => readFileSync(`${migrationsDirectory}/${name}`, 'utf8'))
  const migrated = buildDatabase(migrations)
  const schema = buildDatabase([readFileSync(`${repositoryRoot}db/schema.sql`, 'utf8')])

  assert.deepEqual(describeDatabase(schema), describeDatabase(migrated))
})

test('sparse snapshot migration preserves verified Bitkub archive coverage', () => {
  const migrationsDirectory = `${repositoryRoot}db/migrations`
  const migrationNames = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()
  const database = buildDatabase(migrationNames
    .filter((name) => name < '0017_sparse_snapshots_and_history_coverage.sql')
    .map((name) => readFileSync(`${migrationsDirectory}/${name}`, 'utf8')))

  database.prepare('INSERT INTO accounts (id, exchange, label, owner_email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('bitkub-main', 'bitkub', 'Bitkub Main', 'owner@example.test', 1)
  database.prepare('INSERT INTO bitkub_pnl_archive_imports (account_id, archive_before, source_record_count, verified_at) VALUES (?, ?, ?, ?)')
    .run('bitkub-main', 100, 10, 90)
  for (const dataType of ['trades', 'crypto_transfers', 'fiat_transfers']) {
    database.prepare('INSERT INTO sync_state (account_id, data_type, last_synced_at, cursor) VALUES (?, ?, ?, NULL)')
      .run('bitkub-main', dataType, 200)
  }

  database.exec(readFileSync(`${migrationsDirectory}/0017_sparse_snapshots_and_history_coverage.sql`, 'utf8'))

  assert.deepEqual(database.prepare(`
    SELECT data_type, covered_from
    FROM sync_state
    WHERE account_id = 'bitkub-main'
    ORDER BY data_type
  `).all().map((row) => ({ ...row })), [
    { covered_from: 100, data_type: 'crypto_transfers' },
    { covered_from: 100, data_type: 'fiat_transfers' },
    { covered_from: 100, data_type: 'trades' },
  ])
})

test('coverage repair migration realigns checkpoints reset by migration 0017', () => {
  const migrationsDirectory = `${repositoryRoot}db/migrations`
  const migrationNames = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && name < '0018_restore_verified_history_coverage.sql')
    .toSorted()
  const database = buildDatabase(migrationNames.map((name) => readFileSync(`${migrationsDirectory}/${name}`, 'utf8')))

  database.prepare('INSERT INTO accounts (id, exchange, label, owner_email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('bitkub-main', 'bitkub', 'Bitkub Main', 'owner@example.test', 1)
  database.prepare('INSERT INTO bitkub_pnl_archive_imports (account_id, archive_before, source_record_count, verified_at) VALUES (?, ?, ?, ?)')
    .run('bitkub-main', 100, 10, 90)
  for (const [dataType, coveredFrom] of [['trades', 150], ['crypto_transfers', 150], ['fiat_transfers', null]]) {
    database.prepare('INSERT INTO sync_state (account_id, data_type, last_synced_at, covered_from, cursor) VALUES (?, ?, ?, ?, NULL)')
      .run('bitkub-main', dataType, 200, coveredFrom)
  }

  database.exec(readFileSync(`${migrationsDirectory}/0018_restore_verified_history_coverage.sql`, 'utf8'))

  assert.deepEqual(database.prepare(`
    SELECT data_type, covered_from
    FROM sync_state
    WHERE account_id = 'bitkub-main'
    ORDER BY data_type
  `).all().map((row) => ({ ...row })), [
    { covered_from: 100, data_type: 'crypto_transfers' },
    { covered_from: 100, data_type: 'fiat_transfers' },
    { covered_from: 100, data_type: 'trades' },
  ])
})

test('derived buy amount migration truncates only over-precise THB buys', () => {
  const migrationsDirectory = `${repositoryRoot}db/migrations`
  const migrationNames = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && name < '0019_truncate_derived_buy_amounts.sql')
    .toSorted()
  const database = buildDatabase(migrationNames.map((name) => readFileSync(`${migrationsDirectory}/${name}`, 'utf8')))

  database.prepare('INSERT INTO accounts (id, exchange, label, owner_email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('bitkub-main', 'bitkub', 'Bitkub Main', 'owner@example.test', 1)
  const insert = database.prepare(`
    INSERT INTO trades (id, account_id, external_id, side, base_asset, quote_asset, price, amount, quote_amount, fee, fee_asset, executed_at, raw_json)
    VALUES (?, 'bitkub-main', ?, ?, ?, 'THB', 2000.07, ?, ?, 1.25, 'THB', 1, '{}')
  `)
  insert.run('overprecise', 'overprecise', 'buy', 'SOL', 0.24936627218047, 498.75)
  insert.run('exact', 'exact', 'buy', 'SOL', 0.24936627, 498.75)
  insert.run('large-exact', 'large-exact', 'buy', 'IOST', 27000.1234567, 550.5)
  insert.run('sell', 'sell', 'sell', 'SOL', 0.24936627218047, 498.75)

  database.exec(readFileSync(`${migrationsDirectory}/0019_truncate_derived_buy_amounts.sql`, 'utf8'))

  assert.deepEqual(Object.fromEntries(database.prepare('SELECT id, amount, quote_amount FROM trades').all()
    .map(({ id, amount, quote_amount: quoteAmount }) => [id, [amount, quoteAmount]])), {
    exact: [0.24936627, 498.75],
    'large-exact': [27000.1234567, 550.5],
    overprecise: [0.24936627, 498.75],
    sell: [0.24936627218047, 498.75],
  })
})

test('overlap migration removes only archive records that have a live twin', () => {
  const migrationsDirectory = `${repositoryRoot}db/migrations`
  const migrationNames = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql') && name < '0020_remove_overlapping_archive_records.sql')
    .toSorted()
  const database = buildDatabase(migrationNames.map((name) => readFileSync(`${migrationsDirectory}/${name}`, 'utf8')))
  database.prepare('INSERT INTO accounts (id, exchange, label, owner_email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('bitkub-main', 'bitkub', 'Bitkub Main', 'owner@example.test', 1)

  const transfer = database.prepare(`
    INSERT INTO crypto_transfers (id, account_id, external_id, direction, asset, amount, fee, tx_hash, executed_at, raw_json)
    VALUES (?, 'bitkub-main', ?, ?, ?, ?, 0, NULL, ?, '{}')
  `)
  transfer.run('archive-duplicate', 'archive:1', 'withdraw', 'XAAA', 100.5, 1_000_000)
  transfer.run('live-twin', 'LIVE1', 'withdraw', 'XAAA', 100.5, 1_038_000)
  transfer.run('archive-unique', 'archive:2', 'withdraw', 'XAAA', 7, 2_000_000)
  transfer.run('archive-far-from-live', 'archive:3', 'deposit', 'XAAA', 5, 3_000_000)
  transfer.run('live-far-from-archive', 'LIVE3', 'deposit', 'XAAA', 5, 3_600_000)
  transfer.run('archive-other-asset', 'archive:4', 'withdraw', 'XBBB', 100.5, 1_000_000)
  transfer.run('archive-pair-a', 'archive:5', 'deposit', 'XAAA', 9, 4_000_000)
  transfer.run('archive-pair-b', 'archive:6', 'deposit', 'XAAA', 9, 4_000_500)
  database.prepare('INSERT INTO crypto_transfer_cost_basis (transfer_id, total_cost_thb, updated_at) VALUES (?, ?, ?)').run('archive-duplicate', 10, 1)
  database.prepare('INSERT INTO crypto_transfer_cost_basis (transfer_id, total_cost_thb, updated_at) VALUES (?, ?, ?)').run('archive-unique', 20, 1)

  const fiat = database.prepare(`
    INSERT INTO fiat_transfers (id, account_id, external_id, direction, currency, amount, fee, executed_at, raw_json)
    VALUES (?, 'bitkub-main', ?, 'deposit', 'THB', ?, 0, ?, '{}')
  `)
  fiat.run('fiat-archive-duplicate', 'archive:f1', 500, 1_000_000)
  fiat.run('fiat-live-twin', 'LIVEF1', 500, 1_010_000)
  fiat.run('fiat-archive-unique', 'archive:f2', 500, 5_000_000)

  const trade = database.prepare(`
    INSERT INTO trades (id, account_id, external_id, side, base_asset, quote_asset, price, amount, quote_amount, fee, fee_asset, executed_at, raw_json)
    VALUES (?, 'bitkub-main', ?, ?, 'XAAA', 'THB', ?, ?, 100, 1, 'THB', ?, '{}')
  `)
  trade.run('trade-archive-duplicate', 'archive:t1', 'buy', 2.5, 40, 1_000_000)
  trade.run('trade-live-twin', 'LIVET1', 'buy', 2.5, 40.0000001, 1_020_000)
  trade.run('trade-archive-different-side', 'archive:t2', 'sell', 2.5, 40, 1_000_000)
  trade.run('trade-archive-pair-a', 'archive:t3', 'sell', 3, 10, 6_000_000)
  trade.run('trade-archive-pair-b', 'archive:t4', 'sell', 3, 10, 6_000_100)

  database.exec(readFileSync(`${migrationsDirectory}/0020_remove_overlapping_archive_records.sql`, 'utf8'))

  const ids = (table) => database.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(({ id }) => id)
  assert.deepEqual(ids('crypto_transfers'), [
    'archive-far-from-live',
    'archive-other-asset',
    'archive-pair-a',
    'archive-pair-b',
    'archive-unique',
    'live-far-from-archive',
    'live-twin',
  ])
  assert.deepEqual(database.prepare('SELECT transfer_id FROM crypto_transfer_cost_basis').all().map(({ transfer_id: id }) => id), ['archive-unique'])
  assert.deepEqual(ids('fiat_transfers'), ['fiat-archive-unique', 'fiat-live-twin'])
  assert.deepEqual(ids('trades'), ['trade-archive-different-side', 'trade-archive-pair-a', 'trade-archive-pair-b', 'trade-live-twin'])
})

const migrationSql = (name) => readFileSync(`${repositoryRoot}db/migrations/${name}`, 'utf8')
const migrationNamesBefore = (limit) => readdirSync(`${repositoryRoot}db/migrations`)
  .filter((name) => name.endsWith('.sql') && name < limit)
  .toSorted()

test('index migration only adds indexes and leaves every stored row untouched', () => {
  const name = '0022_reduce_hot_query_scans.sql'
  const statements = migrationSql(name).split(';').map((statement) => statement.replace(/--.*$/gm, '').trim()).filter(Boolean)
  assert.ok(statements.length > 0)
  for (const statement of statements) assert.match(statement, /^CREATE INDEX IF NOT EXISTS \w+\s+ON \w+\(/)

  const database = buildDatabase(migrationNamesBefore(name).map(migrationSql))
  database.prepare('INSERT INTO accounts (id, exchange, label, owner_email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('bitkub-main', 'bitkub', 'Bitkub Main', 'owner@example.test', 1)
  for (let index = 0; index < 40; index += 1) {
    database.prepare('INSERT INTO sync_events (account_id, data_type, status, detail, occurred_at) VALUES (?, ?, ?, ?, ?)')
      .run('bitkub-main', index % 2 === 0 ? 'balances' : 'trades', 'success', `event ${index}`, 1_000 + index)
    database.prepare('INSERT INTO portfolio_asset_value_snapshots (account_id, asset, interval, snapshot_at, quantity, value) VALUES (?, ?, ?, ?, ?, ?)')
      .run('bitkub-main', index % 2 === 0 ? 'BTC' : 'SOL', 100 + Math.floor(index / 2), 1_000 + index, 1 + index, 10 + index)
  }
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name: table }) => table)
  const snapshot = () => Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map((row) => ({ ...row }))]))
  const before = snapshot()

  database.exec(migrationSql(name))

  assert.deepEqual(snapshot(), before)
  assert.ok(Object.values(before).some((rows) => rows.length >= 40))
})

test('the busiest dashboard queries read through indexes instead of scanning or sorting whole tables', () => {
  const migrationsDirectory = `${repositoryRoot}db/migrations`
  const database = buildDatabase(readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).toSorted().map(migrationSql))
  const plan = (sql) => database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail)

  const allAccounts = plan(`
    SELECT sync_events.id FROM sync_events JOIN accounts ON accounts.id = sync_events.account_id
    WHERE accounts.archived_at IS NULL ORDER BY sync_events.occurred_at DESC, sync_events.id DESC LIMIT 100
  `)
  assert.ok(!allAccounts.some((detail) => /TEMP B-TREE/.test(detail)), allAccounts.join(' | '))
  assert.ok(allAccounts.some((detail) => /sync_events_recent_idx/.test(detail)), allAccounts.join(' | '))

  const oneAccount = plan(`
    SELECT sync_events.id FROM sync_events JOIN accounts ON accounts.id = sync_events.account_id
    WHERE accounts.archived_at IS NULL AND sync_events.account_id = 'a' ORDER BY sync_events.occurred_at DESC, sync_events.id DESC LIMIT 100
  `)
  assert.ok(!oneAccount.some((detail) => /TEMP B-TREE/.test(detail)), oneAccount.join(' | '))

  const replace = plan("DELETE FROM portfolio_asset_value_snapshots WHERE account_id = 'a' AND interval = 1")
  assert.ok(replace.some((detail) => /account_id=\? AND interval=\?/.test(detail)), replace.join(' | '))
})
