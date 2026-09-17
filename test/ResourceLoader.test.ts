import * as Pi from "@earendil-works/pi-coding-agent"
import * as it from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"

import * as ResourceLoader from "../src/ResourceLoader.js"
import * as FakeSdk from "./FakeSdk.js"

it.afterEach(() => it.vi.restoreAllMocks())

it.effect("empty resource layers allocate isolated, scoped resources without discovery", () =>
  Effect.gen(function*() {
    const resources = yield* ResourceLoader.ResourceLoader
    const second = yield* resources.load("unused")
    let released = false
    const first = yield* Effect.scoped(Effect.gen(function*() {
      const loaded = yield* resources.load("unused")
      loaded.resourceLoader.getExtensions().runtime.trackEventBusSubscription(() => { released = true })
      it.expect(loaded.resourceLoader.getExtensions().extensions).toEqual([])
      it.expect(loaded.resourceLoader.getAgentsFiles().agentsFiles).toEqual([])
      it.expect(loaded.resourceLoader.getSystemPrompt()).toBe("Isolated")
      return loaded
    }))
    it.expect(released).toBe(true)
    it.expect(first.resourceLoader).not.toBe(second.resourceLoader)
    it.expect(first.settingsManager).not.toBe(second.settingsManager)
    it.expect(() => first.resourceLoader.getExtensions().runtime.assertActive()).toThrow()
    it.expect(() => second.resourceLoader.getExtensions().runtime.assertActive()).not.toThrow()
  }).pipe(Effect.scoped, Effect.provide(ResourceLoader.layerEmpty({ systemPrompt: "Isolated" }))))

const directory = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "effect-pi-resources-test-" })
})
const resources = (agentDir: string) => ResourceLoader.layer({
  agentDir,
  settings: {},
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  systemPrompt: "Explicit resources"
})

it.effect("loads configured Pi resources through the Effect service", () =>
  Effect.gen(function*() {
    const cwd = yield* directory
    yield* Effect.gen(function*() {
      const loader = yield* ResourceLoader.ResourceLoader
      const loaded = yield* loader.load(cwd)
      it.expect(loaded.resourceLoader.getSystemPrompt()).toBe("Explicit resources")
      it.expect(loaded.resourceLoader.getExtensions().errors).toEqual([])
    }).pipe(Effect.provide(resources(cwd)))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

it.effect("maps reload rejection to a typed error and invalidates loaded resources", () =>
  Effect.gen(function*() {
    const cwd = yield* directory
    let released = false
    it.vi.spyOn(Pi.DefaultResourceLoader.prototype, "reload").mockImplementation(async function(this: Pi.DefaultResourceLoader) {
      this.getExtensions().runtime.trackEventBusSubscription(() => { released = true })
      throw new globalThis.Error("SDK failure")
    })
    const error = yield* Effect.gen(function*() {
      const loader = yield* ResourceLoader.ResourceLoader
      return yield* loader.load(cwd)
    }).pipe(Effect.scoped, Effect.provide(resources(cwd)), Effect.flip)
    it.expect(error._tag).toBe("ResourceLoaderError")
    it.expect(error.operation).toBe("load")
    it.expect(released).toBe(true)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

it.effect("interruption waits for uncancellable reload before invalidating its runtime", () =>
  Effect.gen(function*() {
    const cwd = yield* directory
    const started = FakeSdk.gate()
    const finish = FakeSdk.gate()
    let released = false
    it.vi.spyOn(Pi.DefaultResourceLoader.prototype, "reload").mockImplementation(async function(this: Pi.DefaultResourceLoader) {
      this.getExtensions().runtime.trackEventBusSubscription(() => { released = true })
      started.resolve()
      await finish.promise
    })
    const fiber = yield* Effect.gen(function*() {
      const loader = yield* ResourceLoader.ResourceLoader
      return yield* loader.load(cwd)
    }).pipe(Effect.scoped, Effect.provide(resources(cwd)), Effect.forkScoped)
    yield* started.wait
    const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped)
    yield* Effect.yieldNow
    it.expect(released).toBe(false)
    yield* finish.open
    yield* Fiber.join(interrupted)
    it.expect(released).toBe(true)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
