import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { LocalSessions, Sessions } from "@jpowersdev/effect-pi"
import * as Shared from "./Shared.js"

const LocalLive = Layer.unwrap(Shared.sessionConfig.pipe(
  Effect.map((config) => LocalSessions.layer({ ...config, idleTimeToLive: "1 minute" }))
)).pipe(Layer.provide(Shared.SessionDependencies))

const program = Effect.gen(function*() {
  const sessions = yield* Sessions
  const id = yield* Shared.sessionId("local-demo")
  const session = yield* sessions.open(id)
  yield* Shared.run(session)
}).pipe(Effect.scoped, Effect.provide(LocalLive))

NodeRuntime.runMain(program)
