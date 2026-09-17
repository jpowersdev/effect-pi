import * as Pi from "@earendil-works/pi-coding-agent"
import * as it from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Redacted from "effect/Redacted"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import * as ModelRuntime from "../src/ModelRuntime.js"
import * as ResourceLoader from "../src/ResourceLoader.js"
import * as Session from "../src/Session.js"
import * as FakeSdk from "./FakeSdk.js"

it.afterEach(() => it.vi.restoreAllMocks())

const setup = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "effect-pi-model-test-" })
  const authPath = path.join(cwd, "auth.json")
  const options: ModelRuntime.Options = {
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    authPath,
    modelsPath: null,
    refreshOnCreate: false,
    apiKeys: { anthropic: Redacted.make("unused-test-key") }
  }
  return { fs, cwd, options, authPath }
})
const dependencies = Layer.merge(NodeServices.layer, ResourceLoader.layerEmpty())
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.scoped,
  Effect.provide(dependencies)
)

it.effect("captures resources and creates isolated SDK bindings with runtime-only credentials", () => provide(
  Effect.gen(function*() {
    const { fs, cwd, options, authPath } = yield* setup
    const runtime = yield* ModelRuntime.make(options)
    const first = yield* runtime.sessionOptions(cwd)
    const second = yield* runtime.sessionOptions(cwd)
    it.expect(first.model?.id).toBe("claude-sonnet-4-5")
    it.expect(first.modelRuntime.hasConfiguredAuth("anthropic")).toBe(true)
    it.expect(first.modelRuntime).not.toBe(second.modelRuntime)
    it.expect(first.resourceLoader).not.toBe(second.resourceLoader)
    it.expect(first.settingsManager).not.toBe(second.settingsManager)
    const auth = yield* fs.readFileString(authPath)
    it.expect(auth).not.toContain("unused-test-key")
    it.expect(auth).not.toContain("anthropic")
  })
))

it.effect("unknown model selection is a typed model error", () => provide(Effect.gen(function*() {
  const { cwd, options } = yield* setup
  const runtime = yield* ModelRuntime.make({ ...options, model: { provider: "missing", id: "missing" } })
  const error = yield* runtime.sessionOptions(cwd).pipe(Effect.flip)
  it.expect(error._tag).toBe("ModelRuntimeError")
  it.expect(error.operation).toBe("model")
})))

it.effect("runtime creation failures are typed and do not expose SDK error payloads", () => provide(Effect.gen(function*() {
  const { cwd, options } = yield* setup
  it.vi.spyOn(Pi.ModelRuntime, "create").mockRejectedValue(new globalThis.Error("secret credential"))
  const resources = yield* ResourceLoader.ResourceLoader
  let released = false
  const runtime = yield* ModelRuntime.make(options).pipe(Effect.provideService(ResourceLoader.ResourceLoader, {
    load: (cwd) => resources.load(cwd).pipe(Effect.tap((loaded) => Effect.sync(() => {
      loaded.resourceLoader.getExtensions().runtime.trackEventBusSubscription(() => { released = true })
    })))
  }))
  const error = yield* runtime.sessionOptions(cwd).pipe(Effect.scoped, Effect.flip)
  it.expect(error._tag).toBe("ModelRuntimeError")
  it.expect(error.operation).toBe("create")
  it.expect(JSON.stringify(error)).not.toContain("secret credential")
  it.expect(released).toBe(true)
})))

it.effect("credential failures do not retain keys embedded in upstream exceptions", () => provide(Effect.gen(function*() {
  const { cwd, options } = yield* setup
  it.vi.spyOn(Pi.ModelRuntime.prototype, "setRuntimeApiKey").mockRejectedValue({ key: "unused-test-key" })
  const runtime = yield* ModelRuntime.make(options)
  const error = yield* runtime.sessionOptions(cwd).pipe(Effect.flip)
  it.expect(error._tag).toBe("ModelRuntimeError")
  it.expect(error.operation).toBe("credentials")
  it.expect(JSON.stringify(error)).not.toContain("unused-test-key")
})))

it.effect("passes cancellation through to SDK runtime creation", () => provide(Effect.gen(function*() {
  const { cwd, options } = yield* setup
  const started = FakeSdk.gate()
  let signal: AbortSignal | undefined
  it.vi.spyOn(Pi.ModelRuntime, "create").mockImplementation((options) => new Promise((_, reject) => {
    signal = options?.signal
    signal?.addEventListener("abort", () => reject(new globalThis.Error("aborted")), { once: true })
    started.resolve()
  }))
  const runtime = yield* ModelRuntime.make(options)
  const fiber = yield* runtime.sessionOptions(cwd).pipe(Effect.scoped, Effect.forkScoped)
  yield* started.wait
  yield* Fiber.interrupt(fiber)
  it.expect(signal?.aborted).toBe(true)
})))

it.effect("passes cancellation through to credential setup", () => provide(Effect.gen(function*() {
  const { cwd, options } = yield* setup
  const started = FakeSdk.gate()
  let signal: AbortSignal | undefined
  it.vi.spyOn(Pi.ModelRuntime.prototype, "setRuntimeApiKey").mockImplementation((_, _key, options) =>
    new Promise((_, reject) => {
      signal = options?.signal
      signal?.addEventListener("abort", () => reject(new globalThis.Error("aborted")), { once: true })
      started.resolve()
    }))
  const runtime = yield* ModelRuntime.make(options)
  const fiber = yield* runtime.sessionOptions(cwd).pipe(Effect.scoped, Effect.forkScoped)
  yield* started.wait
  yield* Fiber.interrupt(fiber)
  it.expect(signal?.aborted).toBe(true)
})))

it.effect("omitting model selection leaves restoration and defaults to Pi", () => provide(Effect.gen(function*() {
  const { cwd, authPath } = yield* setup
  const runtime = yield* ModelRuntime.make({ authPath, modelsPath: null, refreshOnCreate: false })
  const binding = yield* runtime.sessionOptions(cwd)
  it.expect(binding.model).toBeUndefined()
})))

it.effect("registers extension-provided models before model selection", () => provide(Effect.gen(function*() {
  const { cwd, options } = yield* setup
  const ResourcesLive = ResourceLoader.layer({
    agentDir: cwd,
    settings: {},
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.registerProvider("test-provider", {
        baseUrl: "http://127.0.0.1:1",
        api: "openai-completions",
        apiKey: "unused-test-key",
        models: [{
          id: "extension-model", name: "Extension model", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024
        }]
      })
    }]
  })
  const runtime = yield* ModelRuntime.make({
    ...options, model: { provider: "test-provider", id: "extension-model" }
  }).pipe(Effect.provide(ResourcesLive))
  const binding = yield* runtime.sessionOptions(cwd)
  it.expect(binding.resourceLoader.getExtensions().errors).toEqual([])
  it.expect(binding.model?.provider).toBe("test-provider")
  it.expect(binding.model?.id).toBe("extension-model")
})))

it.effect("session construction maps model failures into Session.Error", () => provide(Effect.gen(function*() {
  const { cwd, options } = yield* setup
  const ModelLive = ModelRuntime.layer({ ...options, model: { provider: "missing", id: "missing" } })
  const error = yield* Session.make({ cwd, id: Session.Id.make("missing-model") }).pipe(
    Effect.provide([ModelLive, KeyValueStore.layerMemory]),
    Effect.flip
  )
  it.expect(error._tag).toBe("SessionError")
  it.expect(error.operation).toBe("make")
})))
