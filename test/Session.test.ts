import * as Pi from "@earendil-works/pi-coding-agent"
import * as it from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import * as Session from "../src/Session.js"
import * as FakeSdk from "./FakeSdk.js"

const id = Schema.decodeUnknownSync(Session.Id)("sdk-session")
const dependencies = Layer.mergeAll(NodeServices.layer, KeyValueStore.layerMemory)

const config = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "effect-pi-sdk-test-" })
  const modelRuntime = yield* Effect.tryPromise({
    try: (signal) => Pi.ModelRuntime.create({
      authPath: path.join(cwd, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      signal
    }),
    catch: (cause) => new Session.Error({ sessionId: id, operation: "make", message: String(cause) })
  })
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5")
  if (model === undefined) {
    return yield* new Session.Error({ sessionId: id, operation: "make", message: "Missing test model" })
  }
  return {
    cwd,
    configure: () => ({
      modelRuntime,
      model,
      noTools: "all",
      settingsManager: Pi.SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false }
      }),
      // No filesystem discovery, extensions, credentials, or models from HOME.
      resourceLoader: {
        getExtensions: () => ({ extensions: [], errors: [], runtime: Pi.createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => "Test session",
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {}
      }
    })
  } satisfies Session.Config
})

it.effect("makes a real scoped SDK session and restores its Pi JSONL", () =>
  Effect.gen(function*() {
    const options = yield* config
    const jsonl = yield* Effect.scoped(Effect.gen(function*() {
      const session = yield* Session.make({ ...options, id })
      const current = yield* session.snapshot
      it.expect(current.id).toBe(id)
      it.expect(current.messageCount).toBe(0)
      return yield* session.jsonl
    }))

    const store = yield* KeyValueStore.KeyValueStore
    it.expect(yield* store.get(`effect-pi/sessions/${id}`)).toBe(jsonl)

    const restoredJsonl = yield* Effect.scoped(Effect.gen(function*() {
      const restored = yield* Session.make({ ...options, id })
      it.expect((yield* restored.snapshot).id).toBe(id)
      return yield* restored.jsonl
    }))
    it.expect(restoredJsonl.startsWith(jsonl)).toBe(true)
    it.expect(yield* store.get(`effect-pi/sessions/${id}`)).toBe(restoredJsonl)
  }).pipe(Effect.scoped, Effect.provide(dependencies)))

it.effect("restores nonempty conversation trees using the real SessionManager", () =>
  Effect.gen(function*() {
    const options = yield* config
    const manager = Pi.SessionManager.create(options.cwd, options.cwd, { id })
    const user = manager.appendMessage({ role: "user", content: "question", timestamp: 0 })
    manager.appendMessage(FakeSdk.assistant("first branch"))
    manager.branch(user)
    manager.appendMessage(FakeSdk.assistant("second branch"))
    const jsonl = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n"
    const store = yield* KeyValueStore.KeyValueStore
    yield* store.set(`effect-pi/sessions/${id}`, jsonl)
    const session = yield* Session.make({ ...options, id })
    it.expect((yield* session.snapshot).lastAssistantText).toBe("second branch")
    it.expect((yield* session.snapshot).messageCount).toBe(2)
    it.expect(yield* session.jsonl).toContain("first branch")
    it.expect(yield* session.jsonl).toContain("second branch")
  }).pipe(Effect.scoped, Effect.provide(dependencies)))

it.effect("rejects torn JSONL without overwriting the durable document", () =>
  Effect.gen(function*() {
    const options = yield* config
    const store = yield* KeyValueStore.KeyValueStore
    const manager = Pi.SessionManager.create(options.cwd, options.cwd, { id })
    const damaged = JSON.stringify(manager.getHeader()) + '\n{"type":"message","message":'
    yield* store.set(`effect-pi/sessions/${id}`, damaged)
    const error = yield* Session.make({ ...options, id }).pipe(Effect.scoped, Effect.flip)
    it.expect(error._tag).toBe("SessionError")
    it.expect(error.operation).toBe("load")
    it.expect(yield* store.get(`effect-pi/sessions/${id}`)).toBe(damaged)
  }).pipe(Effect.scoped, Effect.provide(dependencies)))

it.effect("rejects mismatched session identities without rewriting the store", () =>
  Effect.gen(function*() {
    const options = yield* config
    const store = yield* KeyValueStore.KeyValueStore
    const manager = Pi.SessionManager.create(options.cwd, options.cwd, { id: "other-session" })
    const wrong = JSON.stringify(manager.getHeader()) + "\n"
    yield* store.set(`effect-pi/sessions/${id}`, wrong)
    it.expect((yield* Session.make({ ...options, id }).pipe(Effect.scoped, Effect.flip)).operation).toBe("load")
    it.expect(yield* store.get(`effect-pi/sessions/${id}`)).toBe(wrong)
  }).pipe(Effect.scoped, Effect.provide(dependencies)))
