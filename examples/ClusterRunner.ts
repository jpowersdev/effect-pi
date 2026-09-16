import * as NodeClusterSocket from "@effect/platform-node/NodeClusterSocket"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as RunnerAddress from "effect/unstable/cluster/RunnerAddress"

import { ClusterSessions } from "@jpowersdev/effect-pi"
import * as Shared from "./Shared.js"

const program = Effect.gen(function*() {
  const config = yield* Shared.sessionConfig
  const port = yield* Config.Port("EFFECT_PI_RUNNER_PORT").pipe(Config.withDefault(34431))
  // Local-machine example: runners and clients share one SQLite file. For
  // multiple machines, replace SQLite with a shared SQL service such as Postgres.
  const ClusterLive = NodeClusterSocket.layer({
    storage: "sql",
    serialization: "ndjson",
    shardingConfig: {
      runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port))
    }
  }).pipe(Layer.provide(Shared.SqlLive))
  const RunnerLive = ClusterSessions.runnerLayer(config).pipe(
    Layer.provide([Shared.SessionDependencies, ClusterLive])
  )
  yield* Console.log(`Starting Pi runner on 127.0.0.1:${port}`)
  yield* Layer.launch(RunnerLive)
})

NodeRuntime.runMain(program)
