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
