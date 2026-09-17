import * as it from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"

import * as Config from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as TestRunner from "effect/unstable/cluster/TestRunner"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import { ClusterSessions, LocalSessions, ModelRuntime, ResourceLoader, Session, Sessions } from "../src/index.js"

// The same top-level layer values are reusable with different ConfigProviders.
const ResourcesLive = ResourceLoader.layerEmptyConfig({
  systemPrompt: Config.NonEmptyString("SYSTEM_PROMPT"),
  settings: Config.succeed({ retry: { enabled: false } })
})

const ModelLive = ModelRuntime.layerConfig({
  model: {
    provider: Config.NonEmptyString("PROVIDER"),
    id: Config.NonEmptyString("MODEL")
  },
  apiKeys: { anthropic: Config.Redacted("API_KEY") },
  authPath: Config.NonEmptyString("AUTH_PATH"),
  modelsPath: Config.succeed(null),
  refreshOnCreate: Config.succeed(false)
}).pipe(
  Layer.provide(ResourcesLive)
)

const PoolLive = LocalSessions.layerConfig({
  cwd: Config.NonEmptyString("CWD"),
  keyPrefix: Config.NonEmptyString("PREFIX"),
  configure: Config.succeed(() => ({ noTools: "all" as const }))
}).pipe(
  Layer.provide(ModelLive)
)

const RunnerLive = ClusterSessions.runnerLayerConfig(
  Config.all({
    cwd: Config.NonEmptyString("CWD"),
    keyPrefix: Config.NonEmptyString("PREFIX")
  }).pipe(
    Config.map((options) => ({
      ...options,
      configure: () => ({ noTools: "all" as const })
    }))
  )
)

const ClusterLive = Layer.merge(RunnerLive, ClusterSessions.clientLayer).pipe(
  Layer.provide(ModelLive),
  Layer.provide(TestRunner.layer)
)

const DiscoveryLive = ResourceLoader.layerConfig(
  Config.all({
    agentDir: Config.NonEmptyString("CWD"),
    systemPrompt: Config.NonEmptyString("SYSTEM_PROMPT")
  }).pipe(
    Config.map((options) => ({
      ...options,
      settings: {},
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true
    }))
  )
)

const dependencies = Layer.merge(NodeServices.layer, KeyValueStore.layerMemory)

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.scoped,
  Effect.provide(dependencies)
)

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  const path = yield* Path.Path

  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "effect-pi-config-test-" })

  return {
    cwd,
    provider: (overrides: Readonly<Record<string, unknown>> = {}) => ConfigProvider.fromUnknown({
      CWD: cwd,
      PREFIX: "configured/",
      SYSTEM_PROMPT: "Configured prompt",
      PROVIDER: "anthropic",
      MODEL: "claude-sonnet-4-5",
      AUTH_PATH: path.join(cwd, "auth.json"),
      API_KEY: "unused-config-test-key",
      ...overrides
    })
  }
})

it.effect("config layers resolve lazily against each build's ConfigProvider", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, provider } = yield* fixture

      const inspect = Effect.gen(function* () {
        const runtime = yield* ModelRuntime.ModelRuntime

        const binding = yield* runtime.sessionOptions(cwd)

        it.expect(binding.model?.id).toBe("claude-sonnet-4-5")
        it.expect(binding.modelRuntime.hasConfiguredAuth("anthropic")).toBe(true)

        return binding.resourceLoader.getSystemPrompt()
      }).pipe(
        Effect.scoped,
        Effect.provide(ModelLive)
      )

      const first = yield* inspect.pipe(
        Effect.provide(ConfigProvider.layer(provider({ SYSTEM_PROMPT: "First" })))
      )

      const second = yield* inspect.pipe(
        Effect.provide(ConfigProvider.layer(provider({ SYSTEM_PROMPT: "Second" })))
      )

      it.expect(first).toBe("First")
      it.expect(second).toBe("Second")
    })
  )
)

it.effect("resource discovery accepts a complete Config of options", () =>
  provide(
    Effect.gen(function* () {
      const { cwd, provider } = yield* fixture

      yield* Effect.gen(function* () {
        const loader = yield* ResourceLoader.ResourceLoader

        const loaded = yield* loader.load(cwd)

        it.expect(loaded.resourceLoader.getSystemPrompt()).toBe("Configured prompt")
        it.expect(loaded.resourceLoader.getExtensions().extensions).toEqual([])
      }).pipe(
        Effect.scoped,
        Effect.provide(DiscoveryLive),
        Effect.provide(ConfigProvider.layer(provider()))
      )
    })
  )
)

const inspectSession = (id: Session.Id) => Effect.gen(function* () {
  const sessions = yield* Sessions

  const session = yield* sessions.open(id)

  it.expect((yield* session.snapshot).id).toBe(id)

  const document = yield* session.jsonl

  it.expect(document).toContain('"modelId":"claude-sonnet-4-5"')

  const store = yield* KeyValueStore.KeyValueStore

  it.expect(yield* store.get(`configured/${id}`)).toBe(document)
  it.expect(yield* store.get(`effect-pi/sessions/${id}`)).toBeUndefined()
})

it.effect("local layerConfig composes model, resources, storage, and configured pool options", () =>
  provide(
    Effect.gen(function* () {
      const { provider } = yield* fixture

      yield* inspectSession(Session.Id.make("config-pool")).pipe(
        Effect.scoped,
        Effect.provide(PoolLive),
        Effect.provide(ConfigProvider.layer(provider()))
      )
    })
  )
)

// Real SDK filesystem I/O can trigger cluster retries; those need a live clock.
it.live("runnerLayerConfig serves the public cluster client with configured storage options", () =>
  provide(
    Effect.gen(function* () {
      const { provider } = yield* fixture

      yield* inspectSession(Session.Id.make("config-cluster")).pipe(
        Effect.scoped,
        Effect.provide(ClusterLive),
        Effect.provide(ConfigProvider.layer(provider()))
      )
    })
  )
)

const expectConfigError = <A, R>(live: Layer.Layer<A, Config.ConfigError, R>) => Layer.build(live).pipe(
  Effect.flip,
  Effect.tap((error) =>
    Effect.sync(() => {
      it.expect(error._tag).toBe("ConfigError")
    })
  )
)

it.effect("all config constructors retain typed configuration failures", () =>
  provide(
    Effect.gen(function* () {
      yield* expectConfigError(ResourceLoader.layerConfig({ agentDir: Config.NonEmptyString("MISSING") }))
      yield* expectConfigError(ResourcesLive)
      yield* expectConfigError(ModelLive)
      yield* expectConfigError(PoolLive)
      yield* expectConfigError(ClusterLive)
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
    )
  )
)

it.effect("missing model configuration fails at layer build, before any session is opened", () =>
  provide(
    Effect.gen(function* () {
      const { provider } = yield* fixture

      yield* expectConfigError(ModelLive).pipe(
        Effect.provide(ConfigProvider.layer(provider({ MODEL: undefined })))
      )
    })
  )
)
