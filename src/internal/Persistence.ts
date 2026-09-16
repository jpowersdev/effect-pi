import * as Effect from "effect/Effect"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import * as Session from "./Session.js"

const message = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String(cause.message)
  }
  return String(cause)
}

export interface Store {
  readonly load: Effect.Effect<string | undefined, Session.Error>
  readonly save: (jsonl: string) => Effect.Effect<void, Session.Error>
}

export const make = Effect.fnUntraced(function* (
  id: Session.Id,
  keyPrefix = "effect-pi/sessions/"
) {
  const backing = yield* KeyValueStore.KeyValueStore
  const store = KeyValueStore.prefix(backing, keyPrefix)
  return {
    load: store.get(id).pipe(
      Effect.mapError((cause) => new Session.Error({
        sessionId: id,
        operation: "load",
        message: message(cause)
      }))
    ),
    save: (jsonl) => store.set(id, jsonl).pipe(
      Effect.mapError((cause) => new Session.Error({
        sessionId: id,
        operation: "save",
        message: message(cause)
      }))
    )
  } satisfies Store
})
