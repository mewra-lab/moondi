import fs from 'node:fs'
import path from 'node:path'

const workerConfigs = ['apps/api/wrangler.jsonc', 'apps/sync-worker/wrangler.jsonc']

const requiredOptionNames = [
  'dbId',
  'dbName',
  'pagesOrigin',
  'apiWorkerName',
  'syncWorkerName',
  'kvId',
]

export const configureWorkerExamples = ({ apiExample, syncExample, options }) => {
  const api = structuredClone(apiExample)
  const sync = structuredClone(syncExample)

  api.name = options.apiWorkerName
  sync.name = options.syncWorkerName
  api.vars.ALLOWED_ORIGIN = options.pagesOrigin

  for (const config of [api, sync]) {
    const database = config.d1_databases?.find(({ binding }) => binding === 'DB')
    const namespace = config.kv_namespaces?.find(({ binding }) => binding === 'CACHE')

    if (!database || !namespace) throw new Error('The Worker example configuration is missing DB or CACHE bindings.')

    database.database_name = options.dbName
    database.database_id = options.dbId
    namespace.id = options.kvId
  }

  const syncService = api.services?.find(({ binding }) => binding === 'SYNC')
  if (!syncService) throw new Error('The API example configuration is missing the SYNC service binding.')
  syncService.service = options.syncWorkerName

  return { api, sync }
}

const parseOptions = (argumentsList) => {
  const options = {}

  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index]
    const value = argumentsList[index + 1]
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`Expected --name value, received ${flag ?? ''}`)
    options[flag.slice(2)] = value
  }

  for (const name of requiredOptionNames) {
    if (!options[name]) throw new Error(`Missing --${name}`)
  }

  return options
}

const writeConfig = (filePath, value) => {
  if (fs.existsSync(filePath)) throw new Error(`Refusing to overwrite existing local configuration: ${filePath}`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const main = () => {
  const options = parseOptions(process.argv.slice(2))
  const root = process.cwd()
  const apiExample = JSON.parse(fs.readFileSync(path.join(root, 'apps/api/wrangler.example.jsonc'), 'utf8'))
  const syncExample = JSON.parse(fs.readFileSync(path.join(root, 'apps/sync-worker/wrangler.example.jsonc'), 'utf8'))
  const configs = configureWorkerExamples({ apiExample, syncExample, options })

  for (const relativePath of workerConfigs) {
    if (fs.existsSync(path.join(root, relativePath))) {
      throw new Error(`Refusing to overwrite existing local configuration: ${relativePath}`)
    }
  }

  writeConfig(path.join(root, workerConfigs[0]), configs.api)
  writeConfig(path.join(root, workerConfigs[1]), configs.sync)
}

if (import.meta.main) main()
