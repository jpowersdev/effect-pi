/** Create one session, send a prompt, and save its history in SQLite. */
import * as Path from "node:path"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import { ModelRuntime, ResourceLoader, Session } from "@jpowersdev/effect-pi"

// Config values are recipes, resolved through ConfigProvider when the layers build.
const DataDirectory = Config.NonEmptyString("EFFECT_PI_DATA_DIR").pipe(
  Config.withDefault(".data/effect-pi"), Config.map((value) => Path.resolve(value))
)
const Cwd = Config.NonEmptyString("EFFECT_PI_CWD").pipe(
  Config.withDefault("."), Config.map((value) => Path.resolve(value))
)
const DirectoryLive = Layer.effectDiscard(Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(yield* DataDirectory, { recursive: true, mode: 0o700 })
}))
const ResourcesLive = ResourceLoader.layerEmpty({
  systemPrompt: "You are a helpful assistant. Use the read-only tools only when asked to inspect files.",
  settings: { retry: { enabled: false } }
})
const ModelLive = ModelRuntime.layerConfig(Config.all({
  provider: Config.NonEmptyString("EFFECT_PI_PROVIDER"),
  modelId: Config.NonEmptyString("EFFECT_PI_MODEL"),
  apiKey: Config.Redacted("EFFECT_PI_API_KEY"),
  directory: DataDirectory
}).pipe(Config.map(({ provider, modelId, apiKey, directory }) => ({
  model: { provider, id: modelId },
  apiKeys: { [provider]: apiKey },
  authPath: Path.join(directory, "auth.json"),
  modelsPath: null,
  refreshOnCreate: false
})))).pipe(Layer.provide([ResourcesLive, DirectoryLive]))
const SqlLive = SqliteClient.layerConfig({
  filename: DataDirectory.pipe(Config.map((directory) => Path.join(directory, "sessions.sqlite")))
}).pipe(Layer.provide(DirectoryLive))
const StoreLive = KeyValueStore.layerSql({ table: "pi_sessions" }).pipe(Layer.provide(SqlLive))
// Session.make itself also needs Node services, so retain them in the output.
const AppLive = Layer.merge(ModelLive, StoreLive).pipe(Layer.provideMerge(NodeServices.layer))

const program = Effect.gen(function*() {
  const id = yield* Config.schema(Session.Id, "EFFECT_PI_SESSION_ID").pipe(
    Config.withDefault(Session.Id.make("single-session"))
  )
  const session = yield* Session.make({
    id,
    cwd: yield* Cwd,
    configure: () => ({ tools: ["read", "grep", "find", "ls"] })
  })
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
}).pipe(Effect.scoped, Effect.provide(AppLive))

NodeRuntime.runMain(program)
