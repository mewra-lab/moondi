import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const usage = 'Usage: node scripts/import-bitkub-history.mjs --account <account-id> --before <UTC ISO timestamp> --timezone <±HH:MM> --input-dir <directory> --last-page <positive integer> --expected-records <positive integer> --output <absolute /tmp path> [--confirmed-missing-symbol-ids <JSON file>]'
const retainedHistoryWindowMs = 90 * 24 * 60 * 60 * 1_000

const required = (value, message) => {
  if (!value) throw new Error(message)
  return value
}

const parseArguments = (argumentsList) => {
  const values = new Map()
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index]
    const value = argumentsList[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(usage)
    values.set(key.slice(2), value)
  }
  return {
    accountId: required(values.get('account'), usage),
    before: required(values.get('before'), usage),
    confirmedMissingSymbolIds: values.get('confirmed-missing-symbol-ids'),
    expectedRecords: required(values.get('expected-records'), usage),
    inputDirectory: required(values.get('input-dir'), usage),
    lastPage: required(values.get('last-page'), usage),
    output: required(values.get('output'), usage),
    timezone: required(values.get('timezone'), usage),
  }
}

const sqlString = (value) => `'${value.replaceAll("'", "''")}'`

const sqlNumber = (value) => {
  if (!Number.isFinite(value)) throw new Error('History contains a non-finite number')
  return String(value)
}

const safeAsset = (value) => {
  if (typeof value !== 'string' || !/^[A-Z0-9_-]{1,20}$/.test(value)) throw new Error('History contains an invalid asset')
  return value
}

const safeSourceId = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('History contains an invalid source record ID')
  return value
}

const finiteNonNegative = (value, field) => {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`History contains an invalid ${field}`)
  return number
}

const positiveInteger = (value, field) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${field}; use a positive integer`)
  return number
}

const parseUtcTimestamp = (value, field) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error(`Invalid ${field}; use a UTC ISO timestamp ending in Z`)
  }
  const timestamp = Date.parse(value)
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error(`Invalid ${field}`)
  return timestamp
}

const timezoneOffsetMinutes = (value) => {
  const match = typeof value === 'string' ? /^([+-])(\d{2}):(\d{2})$/.exec(value) : null
  if (!match) throw new Error('Invalid --timezone; use an explicit offset such as +07:00')
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > 23 || minutes > 59) throw new Error('Invalid --timezone; use an explicit offset such as +07:00')
  const offset = hours * 60 + minutes
  return match[1] === '+' ? offset : -offset
}

const createdAt = (value, timezone) => {
  if (typeof value !== 'string') throw new Error('History contains an invalid created_at')
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
  if (!match) throw new Error('History contains an invalid created_at')
  const [, year, month, day, hour, minute, second] = match
  const timestampWithoutOffset = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  const date = new Date(timestampWithoutOffset)
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
    || date.getUTCHours() !== Number(hour)
    || date.getUTCMinutes() !== Number(minute)
    || date.getUTCSeconds() !== Number(second)
  ) throw new Error('History contains an invalid created_at')
  const timestamp = timestampWithoutOffset - timezone * 60 * 1_000
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('History contains an invalid created_at')
  return timestamp
}

const archiveRecordId = (accountId, sourceId) => `${accountId.length}:${accountId}:archive:${sourceId}`

const tradeSql = (row, accountId, sourceId, executedAt, confirmedMissingSymbols) => {
  const side = row.side
  if (side !== 'buy' && side !== 'sell') throw new Error('History contains an invalid trade side')
  const baseAsset = safeAsset(row.currency)
  const missingSymbol = row.symbol === '' || row.symbol === null || row.symbol === undefined
  if (missingSymbol && !confirmedMissingSymbols.has(sourceId)) {
    throw new Error(`Trade ${sourceId} has no symbol; confirm its THB pair explicitly before import`)
  }
  const symbol = missingSymbol ? `${baseAsset}_THB` : row.symbol
  if (typeof symbol !== 'string' || symbol !== `${baseAsset}_THB`) throw new Error('Archive import supports only confirmed THB trade pairs')
  const rate = finiteNonNegative(row.rate, 'trade rate')
  if (rate === 0) throw new Error('History contains a zero trade rate')
  const fee = finiteNonNegative(row.fee, 'trade fee')
  const baseAmount = side === 'buy'
    ? finiteNonNegative(row.amount, 'buy amount')
    : finiteNonNegative(row.related_amount, 'sell amount')
  if (baseAmount === 0) throw new Error('History contains a zero trade amount')
  const quoteAmount = baseAmount * rate
  const externalId = `archive:${sourceId}`
  const id = archiveRecordId(accountId, sourceId)
  return `INSERT INTO trades (id, account_id, external_id, side, base_asset, quote_asset, price, amount, quote_amount, fee, fee_asset, executed_at, raw_json) VALUES (${sqlString(id)}, ${sqlString(accountId)}, ${sqlString(externalId)}, ${sqlString(side)}, ${sqlString(baseAsset)}, 'THB', ${sqlNumber(rate)}, ${sqlNumber(baseAmount)}, ${sqlNumber(quoteAmount)}, ${sqlNumber(fee)}, 'THB', ${sqlNumber(executedAt)}, '{}') ON CONFLICT(account_id, external_id) DO NOTHING;`
}

const transferSql = (row, accountId, sourceId, executedAt) => {
  const direction = row.side
  if (direction !== 'deposit' && direction !== 'withdraw') throw new Error('History contains an invalid transfer direction')
  const asset = safeAsset(row.currency)
  const amount = finiteNonNegative(row.amount, 'transfer amount')
  const fee = finiteNonNegative(row.fee, 'transfer fee')
  if (amount === 0) throw new Error('History contains a zero transfer amount')
  const externalId = `archive:${sourceId}`
  const id = archiveRecordId(accountId, sourceId)
  if (asset === 'THB') {
    return `INSERT INTO fiat_transfers (id, account_id, external_id, direction, currency, amount, fee, executed_at, raw_json) VALUES (${sqlString(id)}, ${sqlString(accountId)}, ${sqlString(externalId)}, ${sqlString(direction)}, 'THB', ${sqlNumber(amount)}, ${sqlNumber(fee)}, ${sqlNumber(executedAt)}, '{}') ON CONFLICT(account_id, external_id) DO NOTHING;`
  }
  return `INSERT INTO crypto_transfers (id, account_id, external_id, direction, asset, amount, fee, tx_hash, executed_at, raw_json) VALUES (${sqlString(id)}, ${sqlString(accountId)}, ${sqlString(externalId)}, ${sqlString(direction)}, ${sqlString(asset)}, ${sqlNumber(amount)}, ${sqlNumber(fee)}, NULL, ${sqlNumber(executedAt)}, '{}') ON CONFLICT(account_id, external_id) DO NOTHING;`
}

const importStateSql = (accountId, cutoff, sourceRecordCount, verifiedAt) => `
INSERT INTO bitkub_pnl_archive_imports (account_id, archive_before, source_record_count, verified_at)
SELECT id, ${sqlNumber(cutoff)}, ${sqlNumber(sourceRecordCount)}, ${sqlNumber(verifiedAt)}
FROM accounts
WHERE id = ${sqlString(accountId)} AND exchange = 'bitkub' AND archived_at IS NULL
ON CONFLICT(account_id) DO UPDATE SET
  archive_before = excluded.archive_before,
  source_record_count = excluded.source_record_count,
  verified_at = excluded.verified_at;
`.trim()

const main = async () => {
  const { accountId, before, confirmedMissingSymbolIds, expectedRecords, inputDirectory, lastPage, output, timezone } = parseArguments(process.argv.slice(2))
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) throw new Error('Invalid account ID')
  const cutoff = parseUtcTimestamp(before, '--before')
  if (cutoff > Date.now() - retainedHistoryWindowMs) throw new Error('--before must be at least 90 days before now to avoid overlapping Bitkub live history')
  const offsetMinutes = timezoneOffsetMinutes(timezone)
  const expectedRecordCount = positiveInteger(expectedRecords, '--expected-records')
  const expectedLastPage = positiveInteger(lastPage, '--last-page')

  const repositoryRoot = resolve(process.cwd())
  const outputPath = resolve(output)
  if (!outputPath.startsWith(`${resolve('/tmp')}${sep}`) || outputPath.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error('Output must be an absolute path below /tmp and outside the repository')
  }

  const inputPath = resolve(inputDirectory)
  const files = (await readdir(inputPath))
    .filter((name) => /^history-\d+\.json$/.test(name))
    .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]))
  const expectedFiles = Array.from({ length: expectedLastPage }, (_, index) => `history-${index + 1}.json`)
  if (files.length !== expectedFiles.length || files.some((file, index) => file !== expectedFiles[index])) {
    throw new Error(`History pages must be exactly history-1.json through history-${expectedLastPage}.json`)
  }

  const rows = []
  for (const file of files) {
    const parsed = JSON.parse(await readFile(resolve(inputPath, file), 'utf8'))
    if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array`)
    rows.push(...parsed)
  }
  if (rows.length !== expectedRecordCount) throw new Error(`Expected ${expectedRecordCount} source records but found ${rows.length}`)

  const confirmedMissingSymbols = new Set()
  if (confirmedMissingSymbolIds) {
    const confirmed = JSON.parse(await readFile(resolve(confirmedMissingSymbolIds), 'utf8'))
    if (!Array.isArray(confirmed)) throw new Error('--confirmed-missing-symbol-ids must contain a JSON array')
    for (const value of confirmed) {
      const sourceId = safeSourceId(value)
      if (confirmedMissingSymbols.has(sourceId)) throw new Error('Confirmed missing-symbol IDs contain duplicates')
      confirmedMissingSymbols.add(sourceId)
    }
  }

  const sourceIds = new Set()
  const usedMissingSymbolConfirmations = new Set()
  const statements = []
  const counts = { cryptoTransfers: 0, fiatTransfers: 0, skippedCurrent: 0, trades: 0 }
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('History contains an invalid record')
    const sourceId = safeSourceId(row._id)
    if (sourceIds.has(sourceId)) throw new Error('History contains duplicate source record IDs')
    sourceIds.add(sourceId)
    if (row.status !== 'complete') throw new Error('History contains a non-complete record')
    const executedAt = createdAt(row.created_at, offsetMinutes)
    if (executedAt >= cutoff) {
      counts.skippedCurrent += 1
      continue
    }
    if (row.side === 'buy' || row.side === 'sell') {
      statements.push(tradeSql(row, accountId, sourceId, executedAt, confirmedMissingSymbols))
      if (row.symbol === '' || row.symbol === null || row.symbol === undefined) usedMissingSymbolConfirmations.add(sourceId)
      counts.trades += 1
      continue
    }
    const statement = transferSql(row, accountId, sourceId, executedAt)
    statements.push(statement)
    if (row.currency === 'THB') counts.fiatTransfers += 1
    else counts.cryptoTransfers += 1
  }

  const unusedConfirmations = [...confirmedMissingSymbols].filter((sourceId) => !usedMissingSymbolConfirmations.has(sourceId))
  if (unusedConfirmations.length > 0) throw new Error('Confirmed missing-symbol IDs include records that were not imported as missing-symbol trades')

  if (statements.length === 0) throw new Error('No complete archive records exist before --before')

  const sql = [...statements, importStateSql(accountId, cutoff, statements.length, Date.now()), ''].join('\n')
  await mkdir(resolve(outputPath, '..'), { recursive: true })
  await writeFile(outputPath, sql, { encoding: 'utf8', mode: 0o600 })
  process.stdout.write(`${JSON.stringify({ ...counts, files: files.length, output: outputPath, sourceRecords: rows.length }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
