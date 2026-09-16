import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"

import { Session } from "@jpowersdev/effect-pi"
import * as Shared from "./Shared.js"

const program = Effect.gen(function*() {
  const config = yield* Shared.sessionConfig
  const id = yield* Shared.sessionId("direct-demo")
  const session = yield* Session.make({ ...config, id })
  yield* Shared.run(session)
}).pipe(Effect.scoped, Effect.provide(Shared.SessionDependencies))

NodeRuntime.runMain(program)
