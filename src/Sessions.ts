import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"

import type * as Session from "./internal/Session.js"

export interface Operations {
  /** Acquire the session for an id within the current scope. */
  readonly open: (
    id: Session.Id
  ) => Effect.Effect<Session.Session, Session.Error, Scope.Scope>
}

/** Location-independent access to keyed Pi sessions. */
export class Sessions extends Context.Service<Sessions, Operations>()(
  "@jpowersdev/effect-pi/Sessions"
) {}
