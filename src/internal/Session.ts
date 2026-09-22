import type * as Pi from "@earendil-works/pi-coding-agent"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as Take from "effect/Take"

/** A Pi session id accepted by Pi's SessionManager. */
export const Id = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/)
).pipe(Schema.brand("@jpowersdev/effect-pi/SessionId"))
export type Id = typeof Id.Type

export const Status = Schema.Literals(["idle", "streaming"])
export type Status = typeof Status.Type

export class Snapshot extends Schema.Class<Snapshot>("@jpowersdev/effect-pi/SessionSnapshot")({
  id: Id,
  status: Status,
  messageCount: Schema.Natural,
  lastAssistantText: Schema.String
}) {}

/** Last new assistant response, with usage summed over entries appended by this invocation. */
export class PromptResult extends Schema.Class<PromptResult>("@jpowersdev/effect-pi/PromptResult")({
  snapshot: Snapshot,
  text: Schema.String,
  stopReason: Schema.String,
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  totalTokens: Schema.Natural,
  costUsd: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
}) {}

export const StatusEvent = Schema.TaggedStruct("Status", {
  sequence: Schema.Natural,
  status: Status
})
export type StatusEvent = typeof StatusEvent.Type

export const MessageStart = Schema.TaggedStruct("MessageStart", {
  sequence: Schema.Natural,
  messageSequence: Schema.Natural
})
export type MessageStart = typeof MessageStart.Type

export const MessageDelta = Schema.TaggedStruct("MessageDelta", {
  sequence: Schema.Natural,
  messageSequence: Schema.Natural,
  delta: Schema.String
})
export type MessageDelta = typeof MessageDelta.Type

export const MessageEnd = Schema.TaggedStruct("MessageEnd", {
  sequence: Schema.Natural,
  messageSequence: Schema.Natural,
  content: Schema.String,
  stopReason: Schema.String
})
export type MessageEnd = typeof MessageEnd.Type

export const MessagePart = Schema.Union([MessageStart, MessageDelta, MessageEnd])
export type MessagePart = typeof MessagePart.Type

export const ToolStartedEvent = Schema.TaggedStruct("ToolStarted", {
  sequence: Schema.Natural,
  toolName: Schema.String
})
export type ToolStartedEvent = typeof ToolStartedEvent.Type

export const ToolFinishedEvent = Schema.TaggedStruct("ToolFinished", {
  sequence: Schema.Natural,
  toolName: Schema.String,
  isError: Schema.Boolean
})
export type ToolFinishedEvent = typeof ToolFinishedEvent.Type

/** Flat, serializable event protocol used across Cluster transport. */
export const WireEvent = Schema.Union([
  StatusEvent,
  MessageStart,
  MessageDelta,
  MessageEnd,
  ToolStartedEvent,
  ToolFinishedEvent
])
export type WireEvent = typeof WireEvent.Type

/** One finite assistant response within a possibly multi-turn tool-using prompt. */
export interface AssistantMessage {
  readonly _tag: "AssistantMessage"
  readonly sequence: number
  readonly stream: Stream.Stream<MessagePart, Error>
  /** Await the authoritative text carried by MessageEnd. */
  readonly content: Effect.Effect<string, Error>
}

/** High-level live event stream exposed by a Session. */
export type Event = StatusEvent | AssistantMessage | ToolStartedEvent | ToolFinishedEvent

export const Operation = Schema.Literals([
  "abort",
  "events",
  "jsonl",
  "load",
  "make",
  "prompt",
  "save",
  "snapshot"
])
export type Operation = typeof Operation.Type

export class Error extends Schema.TaggedError<Error>()("SessionError", {
  sessionId: Id,
  operation: Operation,
  message: Schema.String
}) {}

interface ActiveMessage {
  readonly messageSequence: number
  readonly parts: Queue.Queue<Take.Take<MessagePart, Error>>
  readonly content: Deferred.Deferred<string, Error>
}

/** Reconstruct high-level assistant-message resources from serializable event frames. */
export const eventsFromWire = (
  id: Id,
  wireEvents: Stream.Stream<WireEvent, Error>
): Stream.Stream<Event, Error> => Stream.unwrap(Effect.gen(function* () {
  const output = yield* Effect.acquireRelease(
    PubSub.sliding<Take.Take<Event, Error>>({ capacity: 1024, replay: 1024 }),
    PubSub.shutdown
  )
  let active: ActiveMessage | undefined

  const finishActive = (error: Error) => {
    const current = active
    active = undefined
    if (current === undefined) return Effect.void
    return Effect.all([
      Queue.offer(current.parts, Exit.fail(error)),
      Deferred.fail(current.content, error)
    ], { discard: true })
  }

  const consumeFrames: Effect.Effect<void, Error> = wireEvents.pipe(
    Stream.runForEach((event) => Effect.gen(function* () {
      switch (event._tag) {
        case "MessageStart": {
          yield* finishActive(new Error({
            sessionId: id,
            operation: "events",
            message: "A new assistant message started before the previous message ended"
          }))
          const parts = yield* Queue.unbounded<Take.Take<MessagePart, Error>>()
          const content = yield* Deferred.make<string, Error>()
          active = { messageSequence: event.messageSequence, parts, content }
          yield* PubSub.publish(output, [{
            _tag: "AssistantMessage",
            sequence: event.sequence,
            stream: Stream.fromQueue(parts).pipe(Stream.flattenTake),
            content: Deferred.await(content)
          }])
          yield* Queue.offer(parts, [event])
          return
        }
        case "MessageDelta":
          if (active?.messageSequence === event.messageSequence) {
            yield* Queue.offer(active.parts, [event])
          }
          return
        case "MessageEnd":
          if (active?.messageSequence === event.messageSequence) {
            const completed = active
            active = undefined
            yield* Queue.offer(completed.parts, [event])
            yield* Deferred.succeed(completed.content, event.content)
            yield* Queue.offer(completed.parts, Exit.void)
          }
          return
        default:
          if (event._tag === "Status" && event.status === "idle" && active !== undefined) {
            yield* finishActive(new Error({
              sessionId: id,
              operation: "events",
              message: "The assistant message ended with missing event frames"
            }))
          }
          yield* PubSub.publish(output, [event])
      }
    }))
  )
  const consume = consumeFrames.pipe(
    Effect.onExit((exit) => Effect.gen(function* () {
      if (active !== undefined) {
        if (Exit.isFailure(exit)) {
          yield* Queue.offer(active.parts, exit)
          yield* Deferred.failCause(active.content, exit.cause)
        } else {
          yield* finishActive(new Error({
            sessionId: id,
            operation: "events",
            message: "The event stream ended before the assistant message completed"
          }))
        }
      }
      yield* PubSub.publish(output, exit)
    }))
  )

  yield* Effect.forkScoped(consume, { startImmediately: true })

  return Stream.fromPubSubTake(output)
}))

/** Flatten high-level events into the serializable Cluster wire protocol. */
export const eventsToWire = (
  events: Stream.Stream<Event, Error>
): Stream.Stream<WireEvent, Error> => events.pipe(
  Stream.flatMap((event): Stream.Stream<WireEvent, Error> =>
    event._tag === "AssistantMessage" ? event.stream : Stream.fromIterable<WireEvent>([event]))
)

/** One scoped Pi session, whether local or represented by a cluster client. */
export interface Session {
  readonly id: Id
  readonly snapshot: Effect.Effect<Snapshot, Error>
  /** Nonempty text. Interruption waits for SDK settlement and a checkpoint. */
  readonly prompt: (text: string) => Effect.Effect<PromptResult, Error>
  /** Interrupt the active prompt; queued prompts remain eligible to run. */
  readonly abort: Effect.Effect<void, Error>
  /**
   * Ephemeral, bounded activity stream. Each AssistantMessage owns one finite,
   * single-consumer part stream and an independently awaitable final content effect.
   * Sequence numbers are shared by top-level events and nested message parts;
   * restoration resets them.
   */
  readonly events: Stream.Stream<Event, Error>
  /** Current serialization, not an acknowledgement that the backing store has been flushed. */
  readonly jsonl: Effect.Effect<string, Error>
}

export type PiOptions = Omit<
  Pi.CreateAgentSessionOptions,
  "cwd" | "sessionManager" | "modelRuntime" | "model" | "resourceLoader" | "settingsManager"
>

/** Configuration shared by direct, local-pool, and cluster session construction. */
export interface Config {
  /** Tool working directory, not a sandbox or filesystem access boundary. */
  readonly cwd: string
  /** Defaults to "effect-pi/sessions/". Keep stable across all owners of a document. */
  readonly keyPrefix?: string
  /** Per-session SDK options (such as tools). ModelRuntime owns model, auth, resources, and settings. */
  readonly configure?: (sessionId: Id) => PiOptions
}

export interface MakeOptions extends Config {
  readonly id: Id
}
