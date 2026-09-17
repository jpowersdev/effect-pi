/** Start a runner and a separate cluster client in one process, then shut both down. */
import * as Path from "node:path"

import * as NodeClusterSocket from "@effect/platform-node/NodeClusterSocket"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"

import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as MessageStorage from "effect/unstable/cluster/MessageStorage"
import * as RunnerAddress from "effect/unstable/cluster/RunnerAddress"
import * as RunnerStorage from "effect/unstable/cluster/RunnerStorage"
import * as ShardingConfig from "effect/unstable/cluster/ShardingConfig"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import { ClusterSessions, ModelRuntime, ResourceLoader, Session, Sessions } from "@jpowersdev/effect-pi"

const DataDirectory = Config.NonEmptyString("EFFECT_PI_DATA_DIR").pipe(
  Config.withDefault(".data/effect-pi"),
  Config.map((value) => Path.resolve(value))
)

const Cwd = Config.NonEmptyString("EFFECT_PI_CWD").pipe(
  Config.withDefault("."),
  Config.map((value) => Path.resolve(value))
)

const DirectoryLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    yield* fs.makeDirectory(yield* DataDirectory, { recursive: true, mode: 0o700 })
  })
)

// Model and resource configuration belongs to the runner, not the cluster client.
const ResourcesLive = ResourceLoader.layerEmpty({
  systemPrompt: "You are a helpful assistant. Use the read-only tools only when asked to inspect files.",
  settings: { retry: { enabled: false } }
})

const ModelLive = ModelRuntime.layerConfig(
  Config.all({
    provider: Config.NonEmptyString("EFFECT_PI_PROVIDER"),
    modelId: Config.NonEmptyString("EFFECT_PI_MODEL"),
    apiKey: Config.Redacted("EFFECT_PI_API_KEY"),
    directory: DataDirectory
  }).pipe(
    Config.map(({ provider, modelId, apiKey, directory }) => ({
      model: { provider, id: modelId },
      apiKeys: { [provider]: apiKey },
      authPath: Path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false
    }))
  )
).pipe(
  Layer.provide([ResourcesLive, DirectoryLive])
)

const SqlLive = SqliteClient.layerConfig({
  filename: DataDirectory.pipe(
    Config.map((directory) => Path.join(directory, "sessions.sqlite"))
  )
}).pipe(
  Layer.provide(DirectoryLive)
)

const StoreLive = KeyValueStore.layerSql({ table: "pi_sessions" }).pipe(
  Layer.provide(SqlLive)
)

// Both runtimes share in-memory discovery; only conversation documents use SQLite.
const DiscoveryLive = Layer.merge(RunnerStorage.layerMemory, MessageStorage.layerMemory).pipe(
  Layer.provide(ShardingConfig.layer())
)

// The socket adapter has no layerConfig: unwrap only its config-dependent construction.
const RunnerSharding = Layer.unwrap(
  Config.Port("EFFECT_PI_RUNNER_PORT").pipe(
    Config.withDefault(34431),
    Effect.map((port) =>
      NodeClusterSocket.layer({
        storage: "byo",
        serialization: "ndjson",
        shardingConfig: {
          runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port))
        }
      })
    )
  )
).pipe(
  Layer.fresh,
  Layer.provide(DiscoveryLive)
)

// Fresh sharding runtimes make requests travel over the socket, not local dispatch.
const ClientSharding = NodeClusterSocket.layer({
  clientOnly: true,
  storage: "byo",
  serialization: "ndjson",
  shardingConfig: { runnerAddress: Option.none() }
}).pipe(
  Layer.fresh,
  Layer.provide(DiscoveryLive)
)

const RunnerLive = ClusterSessions.runnerLayerConfig({
  cwd: Cwd,
  configure: Config.succeed(() => ({ tools: ["read", "grep", "find", "ls"] }))
}).pipe(
  Layer.provide([ModelLive, StoreLive, RunnerSharding])
)

const ClientLive = ClusterSessions.clientLayer.pipe(
  Layer.provide(ClientSharding),
  // Register the runner first and keep it alive until the client exits.
  Layer.provide(RunnerLive),
  Layer.provide(NodeServices.layer)
)

const program = Effect.gen(function* () {
  const sessions = yield* Sessions

  const id = yield* Config.schema(Session.Id, "EFFECT_PI_SESSION_ID").pipe(
    Config.withDefault(Session.Id.make("cluster-session"))
  )

  const session = yield* sessions.open(id)

  if (process.argv[2] === "--snapshot") {
    return yield* Console.log(yield* session.snapshot)
  }

  // Remote subscriptions are best-effort; use the prompt result to reconcile.
  yield* session.events.pipe(
    Stream.runForEach((event) => Console.log(event)),
    Effect.catch((error) => Console.warn(error)),
    Effect.forkScoped({ startImmediately: true })
  )

  const text = process.argv.slice(2).join(" ") || "Say hello in one short sentence."

  const result = yield* session.prompt(text).pipe(Effect.timeout("2 minutes"))

  yield* Console.log("Result:", result)
}).pipe(
  Effect.scoped,
  Effect.provide(ClientLive)
)

NodeRuntime.runMain(program)
