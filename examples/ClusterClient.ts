import * as NodeClusterSocket from "@effect/platform-node/NodeClusterSocket"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

import { ClusterSessions, Sessions } from "@jpowersdev/effect-pi"
import * as Shared from "./Shared.js"

const ClusterLive = NodeClusterSocket.layer({
  clientOnly: true,
  storage: "sql",
  serialization: "ndjson",
  shardingConfig: { runnerAddress: Option.none() }
}).pipe(Layer.provide(Shared.SqlLive))

const ClientLive = ClusterSessions.clientLayer.pipe(Layer.provide(ClusterLive))

const program = Effect.gen(function*() {
  const sessions = yield* Sessions
  const id = yield* Shared.sessionId("cluster-demo")
  const session = yield* sessions.open(id)
  yield* Shared.run(session)
}).pipe(Effect.scoped, Effect.provide(ClientLive))

NodeRuntime.runMain(program)
