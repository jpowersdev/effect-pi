import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"

import * as Session from "../src/internal/Session.js"

export const make = (
  builds?: Map<Session.Id, number>
) => (options: Session.MakeOptions): Effect.Effect<Session.Session> => Effect.gen(function*() {
  if (builds !== undefined) {
    builds.set(options.id, (builds.get(options.id) ?? 0) + 1)
  }
  const count = yield* Ref.make(0)
  const getSnapshot = Ref.get(count).pipe(
    Effect.map((messageCount) => new Session.Snapshot({
      id: options.id,
      status: "idle",
      messageCount,
      lastAssistantText: messageCount === 0 ? "" : `reply-${messageCount}`
    }))
  )

  return {
    id: options.id,
    snapshot: getSnapshot,
    prompt: () => Ref.updateAndGet(count, (value) => value + 1).pipe(
      Effect.map((messageCount) => new Session.PromptResult({
        snapshot: new Session.Snapshot({
          id: options.id,
          status: "idle",
          messageCount,
          lastAssistantText: `reply-${messageCount}`
        }),
        text: `reply-${messageCount}`,
        stopReason: "stop",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0
      }))
    ),
    abort: Effect.void,
    events: Stream.empty,
    jsonl: Ref.get(count).pipe(Effect.map(String))
  }
})
