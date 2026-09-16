import * as it from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Entity from "effect/unstable/cluster/Entity"
import * as ShardingConfig from "effect/unstable/cluster/ShardingConfig"
import * as TestRunner from "effect/unstable/cluster/TestRunner"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import * as ClusterSessions from "../src/internal/ClusterSessions.js"
import * as Session from "../src/internal/Session.js"
import * as FakeSession from "./FakeSession.js"
import * as FakeSdk from "./FakeSdk.js"
import * as Pi from "../src/internal/Pi.js"
import { Sessions } from "../src/Sessions.js"

const shardingConfig = ShardingConfig.layer({
  shardsPerGroup: 30,
  entityMailboxCapacity: 128,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 5000,
  sendRetryInterval: 100
})
const sessionId = Schema.decodeUnknownSync(Session.Id)

it.effect("routes each session id to an independent cluster entity resource", () => {
  const builds = new Map<Session.Id, number>()
  const runner = ClusterSessions.runnerLayerWith(
    { cwd: process.cwd() },
    FakeSession.make(builds)
  )
  const alphaId = sessionId("alpha")
  const betaId = sessionId("beta")

  return Effect.scoped(Effect.gen(function*() {
    const makeClient = yield* Entity.makeTestClient(ClusterSessions.entity, runner)
    const alpha = yield* makeClient(alphaId)
    const beta = yield* makeClient(betaId)

    yield* alpha.Prompt({ text: "one" })
    yield* alpha.Prompt({ text: "two" })
    yield* beta.Prompt({ text: "separate" })

    it.expect((yield* alpha.Snapshot()).messageCount).toBe(2)
    it.expect((yield* beta.Snapshot()).messageCount).toBe(1)
    it.expect(yield* alpha.Jsonl()).toBe("2")
    it.expect(yield* beta.Jsonl()).toBe("1")
    it.expect(builds.get(alphaId)).toBe(1)
    it.expect(builds.get(betaId)).toBe(1)
  }).pipe(Effect.provide(shardingConfig)))
})

it.effect("the public cluster client cancels a running SDK prompt and remains usable", () =>
  Effect.gen(function*() {
    const finish = FakeSdk.gate()
    const fixture = yield* FakeSdk.make({
      prompt: async ({ text, manager }) => {
        if (text === "first") await finish.promise
        manager.appendMessage(FakeSdk.assistant(text))
      },
      abort: async () => { finish.resolve() }
    })
    const runner = ClusterSessions.runnerLayerWith({ cwd: fixture.cwd },
      (options) => Pi.makeWith(options, fixture.create))
    const live = Layer.merge(runner, ClusterSessions.clientLayer).pipe(Layer.provide(TestRunner.layer))
    yield* Effect.gen(function*() {
      const sessions = yield* Sessions
      const session = yield* sessions.open(fixture.id)
      const error = yield* session.prompt("").pipe(Effect.flip)
      it.expect(error.operation).toBe("prompt")
      const first = yield* session.prompt("first").pipe(Effect.forkScoped)
      yield* fixture.promptStarted.wait
      it.expect((yield* session.snapshot).status).toBe("streaming")
      yield* Fiber.interrupt(first)
      yield* fixture.abortRequested.wait
      it.expect((yield* session.prompt("second")).text).toBe("second")
      it.expect(yield* session.jsonl).toContain("first")
      it.expect(yield* session.jsonl).toContain("second")
    }).pipe(Effect.provide(live))
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeServices.layer, KeyValueStore.layerMemory))
  ))
