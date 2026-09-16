import * as it from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import * as LocalSessions from "../src/internal/LocalSessions.js"
import * as Session from "../src/internal/Session.js"
import * as Pi from "../src/internal/Pi.js"
import { Sessions } from "../src/Sessions.js"
import * as FakeSession from "./FakeSession.js"
import * as FakeSdk from "./FakeSdk.js"

const sessionId = Schema.decodeUnknownSync(Session.Id)

it.effect("shares one scoped session per id and isolates different ids", () => {
  const builds = new Map<Session.Id, number>()
  const layer = LocalSessions.layerWith({
    cwd: process.cwd(),
    idleTimeToLive: "1 minute"
  }, FakeSession.make(builds))
  const alphaId = sessionId("alpha")
  const betaId = sessionId("beta")

  return Effect.gen(function*() {
    const sessions = yield* Sessions

    yield* Effect.scoped(Effect.gen(function*() {
      const alpha = yield* sessions.open(alphaId)
      yield* alpha.prompt("one")
    }))

    yield* Effect.scoped(Effect.gen(function*() {
      const alpha = yield* sessions.open(alphaId)
      const beta = yield* sessions.open(betaId)
      it.expect((yield* alpha.snapshot).messageCount).toBe(1)
      it.expect((yield* beta.snapshot).messageCount).toBe(0)
    }))

    it.expect(builds.get(alphaId)).toBe(1)
    it.expect(builds.get(betaId)).toBe(1)
  }).pipe(
    Effect.provide(layer),
    Effect.scoped
  )
})

it.effect("evicts idle SDK resources and restores their conversation on reacquisition", () =>
  Effect.gen(function*() {
    const fixture = yield* FakeSdk.make()
    const layer = LocalSessions.layerWith({ cwd: fixture.cwd, idleTimeToLive: "1 minute" },
      (options) => Pi.makeWith(options, fixture.create))
    yield* Effect.gen(function*() {
      const sessions = yield* Sessions
      yield* Effect.scoped(Effect.gen(function*() {
        const session = yield* sessions.open(fixture.id)
        yield* session.prompt("remember this")
      }))
      yield* TestClock.adjust("1 minute")
      it.expect(fixture.lifecycle).toContain("dispose")
      yield* Effect.scoped(Effect.gen(function*() {
        const restored = yield* sessions.open(fixture.id)
        it.expect((yield* restored.snapshot).lastAssistantText).toBe("remember this")
      }))
    }).pipe(Effect.provide(layer))
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeServices.layer, KeyValueStore.layerMemory))
  ))
