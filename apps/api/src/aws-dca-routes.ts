import type { Handler } from 'hono'
import { createFactory } from 'hono/factory'

type HonoEnv = {
  Bindings: Env
}

type AwsDcaHandlers = {
  activity: Handler<HonoEnv>
  state: Handler<HonoEnv>
}

const factory = createFactory<HonoEnv>()

export const createAwsDcaRoutes = (handlers: AwsDcaHandlers) => factory
  .createApp()
  .post('/activity', handlers.activity)
  .post('/state', handlers.state)
