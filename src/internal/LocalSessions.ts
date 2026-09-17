import * as Config from "effect/Config"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RcMap from "effect/RcMap"
import type * as Scope from "effect/Scope"

import { Sessions } from "../Sessions.js"
import * as Pi from "./Pi.js"
import type * as Session from "./Session.js"

export interface Options extends Session.Config {
  /** How long an unreferenced live Pi session remains resident. */
  readonly idleTimeToLive?: Duration.Input
}

type MakeSession<R> = (
  options: Session.MakeOptions
) => Effect.Effect<Session.Session, Session.Error, Scope.Scope | R>

/** Internal constructor seam used to verify pool behavior without model calls. */
export const layerWith = <R>(
  options: Options,
  makeSession: MakeSession<R>
): Layer.Layer<Sessions, never, R> => Layer.effect(Sessions, Effect.gen(function*() {
  const sessions = yield* RcMap.make({
    lookup: (id: Session.Id) => makeSession({
      id,
      cwd: options.cwd,
      ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
      ...(options.configure === undefined ? {} : { configure: options.configure })
    }),
    idleTimeToLive: options.idleTimeToLive ?? "15 minutes"
  })

  return Sessions.of({
    open: (id) => RcMap.get(sessions, id)
  })
}))

export const layer = (options: Options) => layerWith(options, Pi.make)

/** Resolve pool options using the active ConfigProvider at layer build time. */
export const layerConfig = (options: Config.Wrap<Options>) =>
  Layer.unwrap(Effect.map(Config.unwrap<Options>(options), layer))
