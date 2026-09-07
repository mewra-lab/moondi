import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)

test('normalizes complete pre-cutoff Bitkub history without copying private fields', async () => {
  const directory = await mkdtemp('/tmp/moondi-history-test-')
  const output = join(directory, 'normalized.sql')
  try {
    await writeFile(join(directory, 'confirmed-missing-symbols.json'), JSON.stringify(['trade-one']))
    await writeFile(join(directory, 'history-1.json'), JSON.stringify([
      { _id: 'trade-one', address: 'private-address', amount: '1', created_at: '2024-01-01 00:00:00', currency: 'BTC', fee: '2', rate: '100', related_amount: '102', side: 'buy', status: 'complete', symbol: '' },
      { _id: 'deposit-one', amount: '500', created_at: '2024-01-02 00:00:00', currency: 'THB', fee: '0', side: 'deposit', status: 'complete', to_bank_accno: 'private-bank-account' },
      { _id: 'current-one', amount: '1', created_at: '2025-07-01 00:00:00', currency: 'SOL', fee: '0', rate: '100', related_amount: '100', side: 'buy', status: 'complete', symbol: 'SOL_THB' },
    ]))
    const { stdout } = await execute(process.execPath, [
      'scripts/import-bitkub-history.mjs',
      '--account', 'bitkub-main',
      '--before', '2025-01-01T00:00:00.000Z',
      '--timezone', '+07:00',
      '--input-dir', directory,
      '--last-page', '1',
      '--expected-records', '3',
      '--output', output,
      '--confirmed-missing-symbol-ids', join(directory, 'confirmed-missing-symbols.json'),
    ], { cwd: process.cwd() })
    const summary = JSON.parse(stdout)
    const sql = await readFile(output, 'utf8')

    assert.deepEqual(summary, { cryptoTransfers: 0, fiatTransfers: 1, skippedCurrent: 1, trades: 1, files: 1, output, sourceRecords: 3 })
    assert.match(sql, /INSERT INTO trades/)
    assert.match(sql, /INSERT INTO fiat_transfers/)
    assert.match(sql, /INSERT INTO bitkub_pnl_archive_imports/)
    assert.match(sql, /archive:trade-one/)
    assert.match(sql, /1704042000000/)
    assert.doesNotMatch(sql, /\bBEGIN\b|\bCOMMIT\b/)
    assert.doesNotMatch(sql, /private-address|private-bank-account|related_amount|address/)

    const database = new DatabaseSync(':memory:')
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(await readFile('db/schema.sql', 'utf8'))
    database.prepare('INSERT INTO accounts (id, exchange, label, owner_email, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('bitkub-main', 'bitkub', 'Bitkub Main', 'owner@example.test', 1)
    database.exec(sql)
    assert.deepEqual(database.prepare('SELECT archive_before, source_record_count FROM bitkub_pnl_archive_imports').all().map((row) => ({ ...row })), [{ archive_before: 1_735_689_600_000, source_record_count: 2 }])
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM trades').get().count, 1)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM fiat_transfers').get().count, 1)

    await assert.rejects(
      execute(process.execPath, [
        'scripts/import-bitkub-history.mjs',
        '--account', 'bitkub-main',
        '--before', '2025-01-01T00:00:00.000Z',
        '--timezone', '+07:00',
        '--input-dir', directory,
        '--last-page', '1',
        '--expected-records', '3',
        '--output', output,
      ], { cwd: process.cwd() }),
      /has no symbol; confirm its THB pair explicitly/,
    )

    await assert.rejects(
      execute(process.execPath, [
        'scripts/import-bitkub-history.mjs',
        '--account', 'bitkub-main',
        '--before', '2099-01-01T00:00:00.000Z',
        '--timezone', '+07:00',
        '--input-dir', directory,
        '--last-page', '1',
        '--expected-records', '3',
        '--output', output,
      ], { cwd: process.cwd() }),
      /at least 90 days/,
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('refuses to mark an archive verified when a confirmed page is missing', async () => {
  const directory = await mkdtemp('/tmp/moondi-history-test-')
  const output = join(directory, 'normalized.sql')
  try {
    await writeFile(join(directory, 'history-1.json'), '[]')
    await assert.rejects(
      execute(process.execPath, [
        'scripts/import-bitkub-history.mjs',
        '--account', 'bitkub-main',
        '--before', '2025-01-01T00:00:00.000Z',
        '--timezone', '+07:00',
        '--input-dir', directory,
        '--last-page', '2',
        '--expected-records', '1',
        '--output', output,
      ], { cwd: process.cwd() }),
      /exactly history-1\.json through history-2\.json/,
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
