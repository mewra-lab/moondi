import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const schema = readFileSync(new URL('../../../db/schema.sql', import.meta.url), 'utf8')

export const createSqliteD1 = () => {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec(schema)

  const isQuery = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql)
  const execute = (sql, params) => {
    const statement = database.prepare(sql)
    if (isQuery(sql)) return { meta: { changes: 0 }, results: statement.all(...params), success: true }
    const result = statement.run(...params)
    return { meta: { changes: Number(result.changes) }, results: [], success: true }
  }
  const prepared = (sql, params) => ({
    all: async () => execute(sql, params),
    bind: (...values) => prepared(sql, values),
    first: async () => database.prepare(sql).get(...params) ?? null,
    params,
    run: async () => execute(sql, params),
    sql,
  })

  const d1 = {
    batch: async (statements) => {
      database.exec('BEGIN')
      try {
        const results = statements.map((statement) => execute(statement.sql, statement.params))
        database.exec('COMMIT')
        return results
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    prepare: (sql) => prepared(sql, []),
  }
  return { d1, database }
}
