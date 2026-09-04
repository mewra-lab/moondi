import type { Handler } from 'hono'
import { createFactory } from 'hono/factory'

type HonoEnv = {
  Bindings: Env
}

type AwsBitkubHandlers = {
  balances: Handler<HonoEnv>
  history: Handler<HonoEnv>
  state: Handler<HonoEnv>
}

const factory = createFactory<HonoEnv>()

export const createAwsBitkubRoutes = (handlers: AwsBitkubHandlers) => factory
  .createApp()
  .post('/balances', handlers.balances)
  .post('/history', handlers.history)
  .post('/state', handlers.state)
