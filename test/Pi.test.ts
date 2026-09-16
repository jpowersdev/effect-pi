import * as it from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import * as Session from "../src/Session.js"
import * as FakeSdk from "./FakeSdk.js"

const dependencies = Layer.merge(NodeServices.layer, KeyValueStore.layerMemory)
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.scoped,
  Effect.provide(dependencies)
)
const stored = (id: Session.Id) => Effect.gen(function*() {
  const store = yield* KeyValueStore.KeyValueStore
  return yield* store.get(`effect-pi/sessions/${id}`)
})

it.effect("serializes prompts while allowing snapshots and events", () => provide(Effect.gen(function*() {
  const finish = FakeSdk.gate()
  const fixture = yield* FakeSdk.make({ prompt: async ({ text, manager }) => {
    if (text === "first") await finish.promise
    manager.appendMessage(FakeSdk.assistant(text))
  } })
  const session = yield* fixture.session
  const event = yield* session.events.pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
  const first = yield* session.prompt("first").pipe(Effect.forkScoped)
  yield* fixture.promptStarted.wait
  const second = yield* session.prompt("second").pipe(Effect.forkScoped)
  yield* Effect.yieldNow
  it.expect(fixture.calls).toEqual(["first"])
  it.expect((yield* session.snapshot).status).toBe("streaming")
  it.expect((yield* Fiber.join(event))[0]?._tag).toBe("Status")
  yield* finish.open
  it.expect((yield* Fiber.join(first)).text).toBe("first")
  it.expect((yield* Fiber.join(second)).text).toBe("second")
  it.expect(yield* stored(fixture.id)).toContain("second")
})))

it.effect("interruption waits for Pi to settle and checkpoint before releasing the prompt gate", () => provide(Effect.gen(function*() {
  const finish = FakeSdk.gate()
  const fixture = yield* FakeSdk.make({ prompt: async ({ text, manager }) => {
    if (text === "first") await finish.promise
    manager.appendMessage(FakeSdk.assistant(text))
  } })
  const session = yield* fixture.session
  const first = yield* session.prompt("first").pipe(Effect.forkScoped)
  yield* fixture.promptStarted.wait
  const interrupted = yield* Fiber.interrupt(first).pipe(Effect.forkScoped)
  yield* fixture.abortRequested.wait
  const second = yield* session.prompt("second").pipe(Effect.forkScoped)
  yield* Effect.yieldNow
  it.expect(fixture.calls).toEqual(["first"])
  it.expect(fixture.lifecycle).not.toContain("settled")
  yield* finish.open
  yield* Fiber.join(interrupted)
  it.expect((yield* Fiber.join(second)).text).toBe("second")
  it.expect(yield* stored(fixture.id)).toContain("first")
})))

it.effect("keeps requesting abort when cancellation arrives during SDK preflight", () => provide(Effect.gen(function*() {
  const preflight = FakeSdk.gate()
  const finished = FakeSdk.gate()
  const entered = FakeSdk.gate()
  const fixture = yield* FakeSdk.make({
    preflight: async () => { entered.resolve(); await preflight.promise },
    prompt: async ({ manager }) => {
      await finished.promise
      manager.appendMessage(FakeSdk.assistant("cancelled", "aborted"))
    },
    abort: async () => { finished.resolve() }
  })
  const session = yield* fixture.session
  const prompt = yield* session.prompt("first").pipe(Effect.forkScoped)
  yield* entered.wait
  const interrupted = yield* Fiber.interrupt(prompt).pipe(Effect.forkScoped)
  yield* fixture.abortRequested.wait
  yield* preflight.open
  yield* fixture.promptStarted.wait
  yield* TestClock.adjust("25 millis")
  yield* Fiber.join(interrupted)
  it.expect(fixture.abortCount).toBeGreaterThanOrEqual(2)
  it.expect(yield* stored(fixture.id)).toContain("cancelled")
})))

it.effect("aborts an active prompt without waiting for its serialization gate", () => provide(Effect.gen(function*() {
  const finish = FakeSdk.gate()
  const fixture = yield* FakeSdk.make({
    prompt: async ({ manager }) => {
      await finish.promise
      manager.appendMessage(FakeSdk.assistant("aborted", "aborted"))
    },
    abort: async () => { finish.resolve() }
  })
  const session = yield* fixture.session
  const prompt = yield* session.prompt("work").pipe(Effect.forkScoped)
  yield* fixture.promptStarted.wait
  yield* session.abort
  const exit = yield* Fiber.await(prompt)
  it.expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  it.expect((yield* session.snapshot).status).toBe("idle")
  it.expect(yield* stored(fixture.id)).toContain("aborted")
})))

it.effect("cancels SDK compaction instead of waiting only for the agent abort path", () => provide(Effect.gen(function*() {
  const compaction = FakeSdk.gate()
  const fixture = yield* FakeSdk.make({
    prompt: async ({ manager }) => {
      await compaction.promise
      manager.appendMessage(FakeSdk.assistant("compaction stopped", "aborted"))
    },
    abortCompaction: () => { compaction.resolve() }
  })
  const session = yield* fixture.session
  const prompt = yield* session.prompt("compact").pipe(Effect.forkScoped)
  yield* fixture.promptStarted.wait
  yield* Fiber.interrupt(prompt)
  it.expect(yield* stored(fixture.id)).toContain("compaction stopped")
})))

it.effect("cancels queued prompts without aborting the active SDK invocation", () => provide(Effect.gen(function*() {
  const finish = FakeSdk.gate()
  const fixture = yield* FakeSdk.make({ prompt: async ({ manager }) => {
    await finish.promise
    manager.appendMessage(FakeSdk.assistant("reply"))
  } })
  const session = yield* fixture.session
  const first = yield* session.prompt("first").pipe(Effect.forkScoped)
  yield* fixture.promptStarted.wait
  const queued = yield* session.prompt("queued").pipe(Effect.forkScoped)
  yield* Fiber.interrupt(queued)
  it.expect(fixture.abortCount).toBe(0)
  yield* finish.open
  yield* Fiber.join(first)
  it.expect(fixture.calls).toEqual(["first"])
})))

it.effect("scope closure settles externally held prompts, saves, disposes, and removes temporary files", () => provide(Effect.gen(function*() {
  const finish = FakeSdk.gate()
  const fixture = yield* FakeSdk.make({
    prompt: async ({ manager }) => {
      await finish.promise
      manager.appendMessage(FakeSdk.assistant("last state", "aborted"))
    },
    abort: async () => { finish.resolve() }
  })
  const resourceScope = yield* Scope.fork(yield* Effect.scope)
  const session = yield* fixture.session.pipe(Scope.provide(resourceScope))
  const prompt = yield* session.prompt("work").pipe(Effect.forkScoped)
  yield* fixture.promptStarted.wait
  yield* Scope.close(resourceScope, Exit.void)
  yield* Fiber.await(prompt)
  it.expect(fixture.lifecycle).toEqual(["settled", "unsubscribe", "dispose"])
  it.expect(fixture.listenerCount).toBe(0)
  it.expect(yield* stored(fixture.id)).toContain("last state")
  const fs = yield* FileSystem.FileSystem
  it.expect(yield* fs.exists(fixture.sessionDirectory)).toBe(false)
  const error = yield* session.snapshot.pipe(Effect.flip)
  it.expect(error._tag).toBe("SessionError")
  it.expect(error.operation).toBe("snapshot")
  it.expect((yield* session.prompt("late").pipe(Effect.flip)).operation).toBe("prompt")
})))

it.effect("waits for an interrupted SDK acquisition and disposes its late result", () => provide(Effect.gen(function*() {
  const acquired = FakeSdk.gate()
  const fixture = yield* FakeSdk.make({ acquire: () => acquired.promise })
  const make = yield* fixture.session.pipe(Effect.scoped, Effect.forkScoped)
  yield* fixture.factoryStarted.wait
  const interrupted = yield* Fiber.interrupt(make).pipe(Effect.forkScoped)
  yield* Effect.yieldNow
  it.expect(fixture.lifecycle).toEqual([])
  yield* acquired.open
  yield* Fiber.join(interrupted)
  it.expect(fixture.lifecycle).toEqual(["dispose"])
  const fs = yield* FileSystem.FileSystem
  it.expect(yield* fs.exists(fixture.sessionDirectory)).toBe(false)
})))

it.effect("does not return an old answer when a prompt produces no assistant response", () => provide(Effect.gen(function*() {
  const fixture = yield* FakeSdk.make({ prompt: async ({ text, manager }) => {
    if (text === "first") manager.appendMessage(FakeSdk.assistant("old answer"))
  } })
  const session = yield* fixture.session
  yield* session.prompt("first")
  const error = yield* session.prompt("handled").pipe(Effect.flip)
  it.expect(error._tag).toBe("SessionError")
  it.expect(error.operation).toBe("prompt")
})))

it.effect("aggregates usage across a prompt's responses and nested tool work", () => provide(Effect.gen(function*() {
  const fixture = yield* FakeSdk.make({ prompt: async ({ manager }) => {
    manager.appendMessage(FakeSdk.assistant("tool turn", "toolUse"))
    manager.appendMessage({
      role: "toolResult", toolCallId: "tool-1", toolName: "nested", content: [], isError: false,
      timestamp: 0, usage: FakeSdk.assistant("").usage
    })
    manager.appendMessage(FakeSdk.assistant("final"))
  } })
  const session = yield* fixture.session
  const response = yield* session.prompt("work")
  it.expect(response.text).toBe("final")
  it.expect(response.inputTokens).toBe(6)
  it.expect(response.outputTokens).toBe(9)
  it.expect(response.totalTokens).toBe(18)
  it.expect(response.costUsd).toBeCloseTo(0.9)
})))

it.effect("surfaces terminal model errors instead of returning successful empty answers", () => provide(Effect.gen(function*() {
  const fixture = yield* FakeSdk.make({ prompt: async ({ manager }) => {
    manager.appendMessage({ ...FakeSdk.assistant("", "error"), errorMessage: "provider unavailable" })
  } })
  const session = yield* fixture.session
  const error = yield* session.prompt("work").pipe(Effect.flip)
  it.expect(error.operation).toBe("prompt")
  it.expect(error.message).toBe("provider unavailable")
  it.expect(yield* stored(fixture.id)).toContain("provider unavailable")
})))

it.effect("rejects empty local prompts before invoking the SDK", () => provide(Effect.gen(function*() {
  const fixture = yield* FakeSdk.make()
  const session = yield* fixture.session
  it.expect((yield* session.prompt("").pipe(Effect.flip)).operation).toBe("prompt")
  it.expect(fixture.calls).toEqual([])
})))

it.effect("bounds events and exposes sequence gaps to slow subscribers", () => provide(Effect.gen(function*() {
  const fixture = yield* FakeSdk.make()
  const session = yield* fixture.session
  const subscribed = FakeSdk.gate()
  const resume = FakeSdk.gate()
  const sequences: Array<number> = []
  const consumer = yield* session.events.pipe(
    Stream.take(2),
    Stream.runForEach((event) => Effect.gen(function*() {
      sequences.push(event.sequence)
      if (sequences.length === 1) {
        yield* subscribed.open
        yield* resume.wait
      }
    })),
    Effect.forkScoped({ startImmediately: true })
  )
  fixture.emit({ type: "agent_start" })
  yield* subscribed.wait
  for (let index = 0; index < 1500; index++) fixture.emit({ type: "agent_start" })
  yield* resume.open
  yield* Fiber.join(consumer)
  it.expect(sequences).toEqual([0, 477])
})))

it.effect("coalesces checkpoint notifications while a store write is in flight", () => provide(Effect.gen(function*() {
  const firstWrite = FakeSdk.gate()
  const resume = FakeSdk.gate()
  const secondWrite = FakeSdk.gate()
  const fixture = yield* FakeSdk.make()
  const backing = yield* KeyValueStore.KeyValueStore
  let enabled = false
  let writes = 0
  const store = KeyValueStore.make({
    ...backing,
    set: (key, value) => Effect.gen(function*() {
      if (enabled) {
        writes++
        if (writes === 1) {
          yield* firstWrite.open
          yield* resume.wait
        } else {
          yield* secondWrite.open
        }
      }
      yield* backing.set(key, value)
    })
  })
  yield* fixture.session.pipe(Effect.provideService(KeyValueStore.KeyValueStore, store))
  enabled = true
  fixture.emit({ type: "thinking_level_changed", level: "off" })
  yield* firstWrite.wait
  for (let index = 0; index < 1000; index++) {
    fixture.emit({ type: "thinking_level_changed", level: "off" })
  }
  yield* resume.open
  yield* secondWrite.wait
  yield* Effect.yieldNow
  it.expect(writes).toBe(2)
})))

it.effect("propagates failed saves and still disposes when the release checkpoint fails", () => provide(Effect.gen(function*() {
  const fixture = yield* FakeSdk.make()
  const backing = yield* KeyValueStore.KeyValueStore
  let failing = false
  const store = KeyValueStore.make({
    ...backing,
    set: (key, value) => failing
      ? Effect.fail(new KeyValueStore.KeyValueStoreError({ method: "set", key, message: "offline" }))
      : backing.set(key, value)
  })
  const scope = yield* Scope.fork(yield* Effect.scope)
  const session = yield* fixture.session.pipe(
    Scope.provide(scope),
    Effect.provideService(KeyValueStore.KeyValueStore, store)
  )
  failing = true
  it.expect((yield* session.prompt("work").pipe(Effect.flip)).operation).toBe("save")
  const exit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit)
  it.expect(Exit.isFailure(exit)).toBe(true)
  it.expect(fixture.lifecycle).toContain("dispose")
  it.expect(fixture.listenerCount).toBe(0)
})))
