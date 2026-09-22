import * as Schema from "effect/Schema"
import * as Entity from "effect/unstable/cluster/Entity"
import * as Rpc from "effect/unstable/rpc/Rpc"

import * as Session from "./Session.js"

export const Snapshot = Rpc.make("Snapshot", {
  success: Session.Snapshot,
  error: Session.Error
})

export const Prompt = Rpc.make("Prompt", {
  payload: { text: Schema.NonEmptyString },
  success: Session.PromptResult,
  error: Session.Error
})

export const Abort = Rpc.make("Abort", {
  error: Session.Error
})

export const Jsonl = Rpc.make("Jsonl", {
  success: Schema.String,
  error: Session.Error
})

export const Events = Rpc.make("Events", {
  success: Session.WireEvent,
  error: Session.Error,
  stream: true
})

export const entity = Entity.make("PiSession", [
  Snapshot,
  Prompt,
  Abort,
  Jsonl,
  Events
])
