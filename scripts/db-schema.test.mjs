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
