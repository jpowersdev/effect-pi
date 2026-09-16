/** Create one session, send a prompt, and save its history in SQLite. */
import * as Pi from "@earendil-works/pi-coding-agent"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import { Session } from "@jpowersdev/effect-pi"

class ExampleError extends Schema.TaggedError<ExampleError>()("ExampleError", {
  message: Schema.String
}) {}

// This example does not discover extensions, skills, or context files on disk.
const resources = (): Pi.ResourceLoader => {
  const extensions = { extensions: [], errors: [], runtime: Pi.createExtensionRuntime() }
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are a helpful assistant. Use the read-only tools only when asked to inspect files.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {}
  }
}

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

  const modelRuntime = yield* Effect.tryPromise({
    try: (signal) => Pi.ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      signal
    }),
    catch: (cause) => new ExampleError({ message: String(cause) })
  })
  const model = modelRuntime.getModel(provider, modelId)
  if (model === undefined) {
    return yield* new ExampleError({ message: `Unknown model ${provider}/${modelId}` })
  }
  yield* Effect.tryPromise({
    try: (signal) => modelRuntime.setRuntimeApiKey(provider, Redacted.value(apiKey), { signal }),
    catch: (cause) => new ExampleError({ message: String(cause) })
  })

  const SqlLive = SqliteClient.layer({ filename: path.join(directory, "sessions.sqlite") })
  const StoreLive = KeyValueStore.layerSql({ table: "pi_sessions" }).pipe(Layer.provide(SqlLive))
  yield* Effect.gen(function*() {
    const session = yield* Session.make({
      id,
      cwd,
      configure: () => ({
        modelRuntime,
        model,
        tools: ["read", "grep", "find", "ls"],
        settingsManager: Pi.SettingsManager.inMemory({ retry: { enabled: false } }),
        resourceLoader: resources()
      })
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
  }).pipe(Effect.scoped, Effect.provide(StoreLive))
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

// Exiting the scope settles work, saves the session, and releases its resources.
NodeRuntime.runMain(program)
