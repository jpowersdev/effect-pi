/** Share sessions by id and reopen them across separate request scopes. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"

import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import { LocalSessions, ModelRuntime, ResourceLoader, Session, Sessions } from "@jpowersdev/effect-pi"

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

const SqlLive = SqliteClient.layer({
  filename: ".data/effect-pi/sessions.sqlite"
})

const StoreLive = KeyValueStore.layerSql({ table: "pi_sessions" }).pipe(
  Layer.provide(SqlLive)
)

const SessionsLive = LocalSessions.layer({
  cwd: ".",
  idleTimeToLive: "1 minute",
  configure: () => ({ tools: ["read", "grep", "find", "ls"] })
}).pipe(
  Layer.provide([ModelLive, StoreLive]),
  Layer.provide(NodeServices.layer)
)

const program = Effect.gen(function* () {
  const sessions = yield* Sessions

  const id = Session.Id.make("pooled-session")

  // A request holds a reference to the session for the duration of its scope.
  yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* sessions.open(id)

      if (process.argv[2] === "--snapshot") {
        return yield* Console.log(yield* session.snapshot)
      }

      yield* session.events.pipe(
        Stream.runForEach((event) => Console.log(event)),
        Effect.catch((error) => Console.warn(error)),
        Effect.forkScoped({ startImmediately: true })
      )

      const text = process.argv.slice(2).join(" ") || "Say hello in one short sentence."

      const result = yield* session.prompt(text).pipe(Effect.timeout("2 minutes"))

      yield* Console.log("Result:", result)
    })
  )

  // Reuse the same live session before the idle TTL; after eviction, restore from SQLite.
  yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* sessions.open(id)

      yield* Console.log("Reopened:", yield* session.snapshot)
    })
  )
}).pipe(
  Effect.scoped,
  Effect.provide(SessionsLive)
)

NodeRuntime.runMain(program)
