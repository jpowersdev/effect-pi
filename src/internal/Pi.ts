import * as Pi from "@earendil-works/pi-coding-agent"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import * as Persistence from "./Persistence.js"
import * as Session from "./Session.js"

type SdkSession = Pick<Pi.AgentSession,
  "messages" | "isStreaming" | "subscribe" | "prompt" | "dispose" |
  "abortRetry" | "abortCompaction" | "abortBranchSummary" | "abortBash"
> & { readonly agent: Pick<Pi.AgentSession["agent"], "abort"> }

/** Internal SDK boundary for deterministic lifecycle tests. */
export type CreateSession = (options: Pi.CreateAgentSessionOptions & {
  readonly cwd: string
  readonly sessionManager: Pi.SessionManager
}) => Promise<{
  readonly session: SdkSession
  readonly modelFallbackMessage?: string
  readonly extensionsResult?: Pick<Pi.CreateAgentSessionResult["extensionsResult"], "errors">
}>

const failureMessage = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String(cause.message)
  }
  return String(cause)
}

const sessionError = (
  id: Session.Id,
  operation: Session.Operation,
  cause: unknown
) => new Session.Error({ sessionId: id, operation, message: failureMessage(cause) })

const serialize = (
  id: Session.Id,
  manager: Pi.SessionManager,
  operation: Session.Operation = "save"
): Effect.Effect<string, Session.Error> => Effect.gen(function*() {
  const header = yield* Effect.try({
    try: () => manager.getHeader(),
    catch: (cause) => sessionError(id, operation, cause)
  })
  if (header === null) return yield* sessionError(id, operation, "Pi session has no header")
  return yield* Effect.try({
    try: () => [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    catch: (cause) => sessionError(id, operation, cause)
  })
})

const assistantText = (message: SdkSession["messages"][number]): string => {
  if (message.role !== "assistant") return ""
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

const snapshot = (id: Session.Id, session: SdkSession): Session.Snapshot => {
  const lastAssistant = session.messages
    .filter((message) => message.role === "assistant")
    .at(-1)
  return new Session.Snapshot({
    id,
    status: session.isStreaming ? "streaming" : "idle",
    messageCount: session.messages.length,
    lastAssistantText: lastAssistant === undefined ? "" : assistantText(lastAssistant)
  })
}

/** Internal constructor seam; all lifecycle and persistence behavior is shared with make. */
export const makeWith = Effect.fn("Session.make")(function* (
  options: Session.MakeOptions,
  createSession: CreateSession
) {
  const id = options.id
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const store = yield* Persistence.make(id, options.keyPrefix)
  const persisted = yield* store.load
  const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "effect-pi-" }).pipe(
    Effect.mapError((cause) => sessionError(id, "make", cause))
  )

  let manager: Pi.SessionManager
  if (persisted === undefined) {
    manager = yield* Effect.try({
      try: () => Pi.SessionManager.create(options.cwd, temporaryDirectory, { id }),
      catch: (cause) => sessionError(id, "make", cause)
    })
  } else {
    // Reject torn JSON instead of allowing Pi's tolerant reader to silently skip
    // it and overwrite the authoritative document with a shorter conversation.
    // Entry shapes, versions, migrations, and tree semantics still belong to Pi.
    yield* Effect.forEach(persisted.split("\n"), (line, index) => line.trim() === ""
      ? Effect.void
      : Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(line).pipe(
        Effect.mapError(() => sessionError(id, "load", `Invalid JSON at line ${index + 1}`))
      ), { discard: true })
    const sessionFile = path.join(temporaryDirectory, `${id}.jsonl`)
    yield* fs.writeFileString(sessionFile, persisted).pipe(
      Effect.mapError((cause) => sessionError(id, "load", cause))
    )
    manager = yield* Effect.try({
      try: () => Pi.SessionManager.open(sessionFile, temporaryDirectory, options.cwd),
      catch: (cause) => sessionError(id, "load", cause)
    })
  }

  if (manager.getSessionId() !== id) {
    return yield* sessionError(id, "load", `stored session id ${manager.getSessionId()} does not match ${id}`)
  }

  const piOptions = yield* Effect.try({
    try: () => options.configure?.(id) ?? {},
    catch: (cause) => sessionError(id, "make", cause)
  })
  // Pi's factory has no cancellation API. Wait for acquisition before honoring
  // interruption, so even a late result is disposed before its temp directory.
  const result = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createSession({ ...piOptions, cwd: options.cwd, sessionManager: manager }),
      catch: (cause) => sessionError(id, "make", cause)
    }),
    (result) => Effect.try({
      try: () => result.session.dispose(),
      catch: (cause) => sessionError(id, "make", cause)
    }).pipe(Effect.orDie)
  )
  const pi = result.session
  if (result.modelFallbackMessage !== undefined) {
    yield* Effect.logWarning("Pi model selection", { sessionId: id, message: result.modelFallbackMessage })
  }
  for (const diagnostic of result.extensionsResult?.errors ?? []) {
    yield* Effect.logWarning("Pi extension failed to load", { sessionId: id, ...diagnostic })
  }

  const events = yield* Effect.acquireRelease(PubSub.sliding<Session.Event>(1024), PubSub.shutdown)
  // A checkpoint serializes current state, not the state at notification time.
  const checkpoints = yield* Effect.acquireRelease(Queue.dropping<void>(1), Queue.shutdown)
  const operations = yield* Effect.acquireRelease(Scope.make("parallel"), (scope) => Scope.close(scope, Exit.void))
  const promptGate = yield* Semaphore.make(1)
  const saveGate = yield* Semaphore.make(1)
  let sequence = 0
  let closed = false
  let active: Fiber.Fiber<unknown, unknown> | undefined

  const ensureOpen = (operation: Session.Operation) => Effect.suspend(() => closed
    ? sessionError(id, operation, "Session scope is closed")
    : Effect.void)
  // Don't interrupt an in-flight replacement of the authoritative document.
  // Atomicity and crash durability still depend on the supplied store.
  const save = saveGate.withPermits(1)(
    serialize(id, manager).pipe(Effect.flatMap(store.save), Effect.uninterruptible)
  )
  // Sliding publish is synchronous; publishUnsafe would silently use dropping
  // behavior on overflow. This is the one synchronous SDK-to-Effect boundary.
  const publish = (event: Session.Event): void => { Effect.runSync(PubSub.publish(events, event)) }
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => pi.subscribe((event) => {
        switch (event.type) {
          case "entry_appended":
          case "session_info_changed":
          case "thinking_level_changed":
          case "turn_end":
          case "compaction_end":
          case "agent_settled":
            Queue.offerUnsafe(checkpoints, undefined)
            if (event.type === "agent_settled") {
              publish({ _tag: "Status", sequence: sequence++, status: "idle" })
            }
            return
          case "agent_start":
            publish({ _tag: "Status", sequence: sequence++, status: "streaming" })
            return
          case "message_update":
            if (event.assistantMessageEvent.type === "text_delta") {
              publish({ _tag: "TextDelta", sequence: sequence++, delta: event.assistantMessageEvent.delta })
            }
            return
          case "tool_execution_start":
            publish({ _tag: "ToolStarted", sequence: sequence++, toolName: event.toolName })
            return
          case "tool_execution_end":
            publish({ _tag: "ToolFinished", sequence: sequence++, toolName: event.toolName, isError: event.isError })
            return
          default:
            return
        }
      }),
      catch: (cause) => sessionError(id, "make", cause)
    }),
    (unsubscribe) => Effect.try({
      try: unsubscribe,
      catch: (cause) => sessionError(id, "events", cause)
    }).pipe(Effect.orDie)
  )
  const checkpointWorker = yield* Queue.take(checkpoints).pipe(
    Effect.andThen(save.pipe(
      Effect.tapError((cause) => Effect.logError("Unable to checkpoint Pi session", {
        sessionId: id, cause: cause.message
      })),
      Effect.ignore
    )),
    Effect.forever,
    Effect.forkScoped
  )

  // Pi.abort() waits for idle and only signals the agent/retry path. Using the
  // public synchronous signals also stops compaction/summaries/bash and lets us
  // re-signal a later continuation without accumulating pending abort promises.
  const abortSdk = Effect.forEach([
    () => pi.abortRetry(),
    () => pi.abortCompaction(),
    () => pi.abortBranchSummary(),
    () => pi.abortBash(),
    () => pi.agent.abort()
  ], (abort) => Effect.try({
    try: abort,
    catch: (cause) => sessionError(id, "abort", cause)
  }).pipe(Effect.ignore), { discard: true })
  const cancel = (wait: Effect.Effect<void, Session.Error>) => Effect.raceFirst(
    wait.pipe(Effect.ignore, Effect.interruptible),
    // Abort signals during async preflight may be a no-op. Keep requesting cancellation
    // until the invocation settles, including any later model run or retry.
    abortSdk.pipe(
      Effect.andThen(Effect.sleep("25 millis")),
      Effect.forever,
      Effect.interruptible
    )
  )

  const runPrompt = (text: string) => promptGate.withPermits(1)(
    Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
      yield* ensureOpen("prompt")
      active = yield* Effect.fiber
      const firstEntry = manager.getEntries().length
      const invocation = Promise.resolve().then(() => pi.prompt(text))
      const wait = Effect.tryPromise({
        try: () => invocation,
        catch: (cause) => sessionError(id, "prompt", cause)
      })
      const exit = yield* Effect.exit(restore(wait).pipe(Effect.onInterrupt(() => cancel(wait))))
      yield* save
      yield* exit

      // Read newly appended entries, not the active context: compaction can shrink
      // that context, and handled extension commands need not produce a response.
      const entries = manager.getEntries().slice(firstEntry)
      const messages = entries.flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [])
      const message = messages.at(-1)
      if (message === undefined) {
        return yield* sessionError(id, "prompt", "Pi returned no new assistant response")
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return yield* sessionError(id, "prompt", message.errorMessage ?? `Pi response ${message.stopReason}`)
      }
      const usage = entries.flatMap((entry) => {
        if (entry.type === "message") {
          const message = entry.message
          return (message.role === "assistant" || message.role === "toolResult") && message.usage !== undefined
            ? [message.usage] : []
        }
        return (entry.type === "compaction" || entry.type === "branch_summary") && entry.usage !== undefined
          ? [entry.usage] : []
      })
      return new Session.PromptResult({
        snapshot: snapshot(id, pi),
        text: assistantText(message),
        stopReason: message.stopReason,
        inputTokens: usage.reduce((sum, item) => sum + item.input, 0),
        outputTokens: usage.reduce((sum, item) => sum + item.output, 0),
        totalTokens: usage.reduce((sum, item) => sum + item.totalTokens, 0),
        costUsd: usage.reduce((sum, item) => sum + item.cost.total, 0)
      })
    }).pipe(Effect.ensuring(Effect.sync(() => { active = undefined }))))
  )

  const owned = <A>(operation: Session.Operation, work: Effect.Effect<A, Session.Error>) =>
    Effect.uninterruptibleMask((restore) => Effect.gen(function*() {
      yield* ensureOpen(operation)
      // Own work in the session scope as well as in its caller. Closing either
      // scope must settle Pi before another owner can restore the document.
      const fiber = yield* Effect.forkIn(work, operations)
      return yield* restore(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
    }))

  const prompt: Session.Session["prompt"] = Effect.fn("Session.prompt")((text) =>
    owned("prompt", Schema.decodeUnknownEffect(Schema.NonEmptyString)(text).pipe(
      Effect.mapError((cause) => sessionError(id, "prompt", cause)),
      Effect.andThen(runPrompt(text))
    )))

  const abort = owned("abort", Effect.uninterruptible(Effect.gen(function*() {
    const running = active
    if (running !== undefined) yield* Fiber.interrupt(running)
    yield* save
  })))

  yield* Effect.addFinalizer(() => Effect.gen(function*() {
    closed = true
    yield* Scope.close(operations, Exit.void)
    yield* Fiber.interrupt(checkpointWorker)
    // Finalizer errors cannot inhabit the typed error channel. Surface a defect
    // rather than reporting successful release after losing the last checkpoint.
    yield* save.pipe(Effect.orDie)
  }))
  yield* save

  return {
    id,
    snapshot: ensureOpen("snapshot").pipe(Effect.andThen(Effect.sync(() => snapshot(id, pi)))),
    prompt,
    abort,
    events: Stream.unwrap(ensureOpen("events").pipe(Effect.as(Stream.fromPubSub(events)))),
    jsonl: ensureOpen("jsonl").pipe(Effect.andThen(serialize(id, manager, "jsonl")))
  } satisfies Session.Session
})

/** Construct one scoped Pi SDK session backed by its KeyValueStore document. */
export const make: (
  options: Session.MakeOptions
) => Effect.Effect<
  Session.Session,
  Session.Error,
  FileSystem.FileSystem | KeyValueStore.KeyValueStore | Path.Path | Scope.Scope
> = (options) => makeWith(options, Pi.createAgentSession)
