import type * as Pi from "@earendil-works/pi-coding-agent"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"

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

const StatusEvent = Schema.TaggedStruct("Status", {
  sequence: Schema.Natural,
  status: Status
})
const TextDeltaEvent = Schema.TaggedStruct("TextDelta", {
  sequence: Schema.Natural,
  delta: Schema.String
})
const ToolStartedEvent = Schema.TaggedStruct("ToolStarted", {
  sequence: Schema.Natural,
  toolName: Schema.String
})
const ToolFinishedEvent = Schema.TaggedStruct("ToolFinished", {
  sequence: Schema.Natural,
  toolName: Schema.String,
  isError: Schema.Boolean
})

/** Stable, serializable subset of Pi's live session events. */
export const Event = Schema.Union([
  StatusEvent,
  TextDeltaEvent,
  ToolStartedEvent,
  ToolFinishedEvent
])
export type Event = typeof Event.Type

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

/** One scoped Pi session, whether local or represented by a cluster client. */
export interface Session {
  readonly id: Id
  readonly snapshot: Effect.Effect<Snapshot, Error>
  /** Nonempty text. Interruption waits for SDK settlement and a checkpoint. */
  readonly prompt: (text: string) => Effect.Effect<PromptResult, Error>
  /** Interrupt the active prompt; queued prompts remain eligible to run. */
  readonly abort: Effect.Effect<void, Error>
  /** Ephemeral, bounded stream. Sequence gaps indicate lost events; restoration resets sequence numbers. */
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
