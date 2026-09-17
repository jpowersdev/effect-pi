/** Create one session, send a prompt, and save its history in SQLite. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import { ModelRuntime, ResourceLoader, Session } from "@jpowersdev/effect-pi"

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.resolve(yield* Config.NonEmptyString("EFFECT_PI_DATA_DIR").pipe(
    Config.withDefault(".data/effect-pi")
  ))
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
  const cwd = path.resolve(yield* Config.NonEmptyString("EFFECT_PI_CWD").pipe(Config.withDefault(process.cwd())))
  const id = yield* Config.schema(Session.Id, "EFFECT_PI_SESSION_ID").pipe(
    Config.withDefault(Session.Id.make("single-session"))
  )
  const provider = yield* Config.NonEmptyString("EFFECT_PI_PROVIDER")
  const modelId = yield* Config.NonEmptyString("EFFECT_PI_MODEL")
  const apiKey = yield* Config.Redacted("EFFECT_PI_API_KEY")

  // No ambient extensions, context files, or settings. Each session gets fresh resources.
  const ResourcesLive = ResourceLoader.layerEmpty({
    systemPrompt: "You are a helpful assistant. Use the read-only tools only when asked to inspect files.",
    settings: { retry: { enabled: false } }
  })
  const ModelLive = ModelRuntime.layer({
    model: { provider, id: modelId },
    apiKeys: { [provider]: apiKey },
    authPath: path.join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false
  }).pipe(Layer.provide(ResourcesLive))
  const SqlLive = SqliteClient.layer({ filename: path.join(directory, "sessions.sqlite") })
  const StoreLive = KeyValueStore.layerSql({ table: "pi_sessions" }).pipe(Layer.provide(SqlLive))

  yield* Effect.gen(function*() {
    const session = yield* Session.make({
      id,
      cwd,
      configure: () => ({ tools: ["read", "grep", "find", "ls"] })
    })
    if (process.argv[2] === "--snapshot") {
      // Construct/restore the real session without making a model request.
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
  }).pipe(Effect.scoped, Effect.provide([ModelLive, StoreLive]))
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

NodeRuntime.runMain(program)
