/** Start a runner and a separate cluster client in one process, then shut both down. */
import * as NodeClusterSocket from "@effect/platform-node/NodeClusterSocket"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"

import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import * as MessageStorage from "effect/unstable/cluster/MessageStorage"
import * as RunnerAddress from "effect/unstable/cluster/RunnerAddress"
import * as RunnerStorage from "effect/unstable/cluster/RunnerStorage"
import * as ShardingConfig from "effect/unstable/cluster/ShardingConfig"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import { ClusterSessions, ModelRuntime, ResourceLoader, Session, Sessions } from "@jpowersdev/effect-pi"

// Model and resource configuration belongs to the runner, not the cluster client.
const ResourcesLive = ResourceLoader.layerEmpty({
  systemPrompt: "You are a helpful assistant. Use the read-only tools only when asked to inspect files.",
  settings: { retry: { enabled: false } }
})

const ModelLive = ModelRuntime.layerConfig(
  Config.all({
    provider: Config.NonEmptyString("EFFECT_PI_PROVIDER"),
    modelId: Config.NonEmptyString("EFFECT_PI_MODEL"),
    apiKey: Config.Redacted("EFFECT_PI_API_KEY")
  }).pipe(
    Config.map(({ provider, modelId, apiKey }) => ({
      model: { provider, id: modelId },
      apiKeys: { [provider]: apiKey },
      authPath: ".data/effect-pi/auth.json",
      modelsPath: null,
      refreshOnCreate: false
    }))
  )
).pipe(
  Layer.provide(ResourcesLive)
)

const StoreLive = KeyValueStore.layerSql({ table: "pi_sessions" }).pipe(
  Layer.provide(
    SqliteClient.layer({ filename: ".data/effect-pi/sessions.sqlite" })
  )
)

// Both runtimes share in-memory discovery; only conversation documents use SQLite.
const DiscoveryLive = Layer.merge(RunnerStorage.layerMemory, MessageStorage.layerMemory).pipe(
  Layer.provide(ShardingConfig.layer())
)

const RunnerSharding = NodeClusterSocket.layer({
  storage: "byo",
  serialization: "ndjson",
  shardingConfig: {
    runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", 34431))
  }
}).pipe(
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

const RunnerLive = ClusterSessions.runnerLayer({
  cwd: ".",
  configure: () => ({ tools: ["read", "grep", "find", "ls"] })
}).pipe(
  Layer.provide([ModelLive, StoreLive, RunnerSharding])
)

const ClientLive = ClusterSessions.clientLayer.pipe(
  Layer.provide(ClientSharding),
  // Register the runner first and keep it alive until the client exits.
  Layer.provide(RunnerLive)
)

const cli = Command.make("cluster-session", {
  prompt: Argument.String("prompt").pipe(
    Argument.withDefault("Say hello in one short sentence.")
  ),
  snapshot: Flag.Boolean("snapshot").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print saved state without calling a model")
  )
}, ({ prompt, snapshot }) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions

    const session = yield* sessions.open(Session.Id.make("cluster-session"))

    if (snapshot) {
      return yield* Console.log(yield* session.snapshot)
    }

    // Remote subscriptions are best-effort; use the prompt result to reconcile.
    yield* session.events.pipe(
      Stream.runForEach((event) => event._tag === "AssistantMessage"
        ? Effect.flatMap(event.content, (content) => Console.log(content))
        : Console.log(event)),
      Effect.catch((error) => Console.warn(error)),
      Effect.forkScoped({ startImmediately: true })
    )

    const result = yield* session.prompt(prompt).pipe(Effect.timeout("2 minutes"))

    yield* Console.log("Result:", result)
  }).pipe(Effect.scoped)
).pipe(
  Command.provide(ClientLive)
)

const program = Command.run(cli, { version: "0.2.0" }).pipe(
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program)
