import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Entity from "effect/unstable/cluster/Entity"
import * as EntityResource from "effect/unstable/cluster/EntityResource"
import type * as Sharding from "effect/unstable/cluster/Sharding"

import { Sessions } from "../Sessions.js"
import * as Pi from "./Pi.js"
import * as Protocol from "./Protocol.js"
import * as Session from "./Session.js"

export interface Options extends Session.Config {
  /** Idle live-resource lifetime; defaults to 15 minutes. */
  readonly resourceIdleTimeToLive?: Duration.Input
  readonly entityMaxIdleTime?: Duration.Input
  /** Queued entity messages; does not limit all concurrently executing handlers. Defaults to 128. */
  readonly mailboxCapacity?: number | "unbounded"
}

type MakeSession<R> = (
  options: Session.MakeOptions
) => Effect.Effect<Session.Session, Session.Error, Scope.Scope | R>

const failureMessage = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String(cause.message)
  }
  return String(cause)
}

const transportError = (
  id: Session.Id,
  operation: Session.Operation,
  cause: unknown
) => cause instanceof Session.Error
  ? cause
  : new Session.Error({
    sessionId: id,
    operation,
    message: failureMessage(cause)
  })

/** Internal constructor seam used to test entity behavior without model calls. */
export const runnerLayerWith = <R>(
  options: Options,
  makeSession: MakeSession<R>
): Layer.Layer<never, never, Sharding.Sharding | R> => {
  const handlers = Effect.gen(function*() {
    const address = yield* Entity.CurrentAddress
    const id = yield* Schema.decodeUnknownEffect(Session.Id)(address.entityId).pipe(
      Effect.orDie
    )
    const resource = yield* EntityResource.make({
      acquire: makeSession({
        id,
        cwd: options.cwd,
        ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
        ...(options.configure === undefined ? {} : { configure: options.configure })
      }),
      idleTimeToLive: options.resourceIdleTimeToLive ?? "15 minutes"
    }).pipe(Effect.orDie)

    return Protocol.entity.of({
      Snapshot: () => resource.get.pipe(Effect.flatMap((session) => session.snapshot)),
      Prompt: (request) => resource.get.pipe(
        Effect.flatMap((session) => session.prompt(request.payload.text))
      ),
      Abort: () => resource.get.pipe(Effect.flatMap((session) => session.abort)),
      Jsonl: () => resource.get.pipe(Effect.flatMap((session) => session.jsonl)),
      Events: () => Stream.unwrap(resource.get.pipe(
        Effect.map((session) => session.events)
      ))
    })
  })

  return Protocol.entity.toLayer(handlers, {
    concurrency: "unbounded",
    mailboxCapacity: options.mailboxCapacity ?? 128,
    maxIdleTime: options.entityMaxIdleTime ?? "20 minutes"
  })
}

/** Registers the server-side cluster entity handlers. */
export const runnerLayer = (options: Options) => runnerLayerWith(options, Pi.make)

/** Implements Sessions using location-transparent Effect Cluster clients. */
export const clientLayer: Layer.Layer<Sessions, never, Sharding.Sharding> = Layer.effect(
  Sessions,
  Protocol.entity.client.pipe(
    Effect.map((makeClient) => Sessions.of({
      open: (id) => Effect.succeed((() => {
        const client = makeClient(id)
        return {
          id,
          snapshot: client.Snapshot().pipe(
            Effect.mapError((cause) => transportError(id, "snapshot", cause))
          ),
          prompt: (text) => Schema.decodeUnknownEffect(Schema.NonEmptyString)(text).pipe(
            Effect.flatMap((text) => client.Prompt({ text })),
            Effect.mapError((cause) => transportError(id, "prompt", cause))
          ),
          abort: client.Abort().pipe(
            Effect.mapError((cause) => transportError(id, "abort", cause))
          ),
          events: client.Events().pipe(
            Stream.mapError((cause) => transportError(id, "events", cause))
          ),
          jsonl: client.Jsonl().pipe(
            Effect.mapError((cause) => transportError(id, "jsonl", cause))
          )
        } satisfies Session.Session
      })())
    }))
  )
)

export const entity = Protocol.entity
