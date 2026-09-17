import * as Pi from "@earendil-works/pi-coding-agent"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"

import * as ResourceLoader from "./ResourceLoader.js"

export interface Options extends Omit<Pi.CreateModelRuntimeOptions, "signal"> {
  /** Omit to let Pi restore/select the model using the session and settings. */
  readonly model?: { readonly provider: string; readonly id: string }
  /** Runtime-only overrides. Keys are never persisted to auth.json. */
  readonly apiKeys?: Readonly<Record<string, Redacted.Redacted<string>>>
}

export class Error extends Schema.TaggedError<Error>()("ModelRuntimeError", {
  operation: Schema.Literals(["create", "providers", "credentials", "model"]),
  message: Schema.String
}) {}

/** SDK interoperability values; never share one binding between live sessions. */
export interface Binding extends ResourceLoader.Loaded {
  readonly modelRuntime: Pi.ModelRuntime
  readonly model?: NonNullable<Pi.CreateAgentSessionOptions["model"]>
}

export interface Operations {
  readonly sessionOptions: (cwd: string) => Effect.Effect<Binding, Error | ResourceLoader.Error, Scope.Scope>
}

export class ModelRuntime extends Context.Service<ModelRuntime, Operations>()(
  "@jpowersdev/effect-pi/ModelRuntime"
) {}

/** Capture the loading policy; SDK objects are owned by each live session's scope. */
export const make = Effect.fn("ModelRuntime.make")(function* (options: Options = {}) {
  const resources = yield* ResourceLoader.ResourceLoader
  const { model: selection, apiKeys, ...runtimeOptions } = options

  const sessionOptions: Operations["sessionOptions"] = Effect.fn("ModelRuntime.sessionOptions")(function* (cwd) {
    const loaded = yield* resources.load(cwd)
    const modelRuntime = yield* Effect.tryPromise({
      try: (signal) => Pi.ModelRuntime.create({ ...runtimeOptions, signal }),
      // SDK credential errors can contain raw keys. Do not retain or stringify them.
      catch: () => new Error({ operation: "create", message: "Unable to create Pi model runtime" })
    })

    // Extensions can define the selected model. Register their providers before
    // lookup; leave Pi's pending queues intact for its own subsequent binding.
    yield* Effect.try({
      try: () => {
        const runtime = loaded.resourceLoader.getExtensions().runtime
        for (const { name, config } of runtime.pendingProviderRegistrations) {
          modelRuntime.registerProvider(name, config)
        }
        for (const { provider } of runtime.pendingNativeProviderRegistrations) {
          modelRuntime.registerNativeProvider(provider)
        }
      },
      catch: () => new Error({ operation: "providers", message: "Unable to register resource providers" })
    })
    for (const [provider, key] of Object.entries(apiKeys ?? {})) {
      yield* Effect.tryPromise({
        try: (signal) => modelRuntime.setRuntimeApiKey(provider, Redacted.value(key), { signal }),
        catch: () => new Error({ operation: "credentials", message: "Unable to configure runtime credentials" })
      })
    }
    if (selection === undefined) return { ...loaded, modelRuntime }
    const model = yield* Effect.try({
      try: () => modelRuntime.getModel(selection.provider, selection.id),
      catch: () => new Error({ operation: "model", message: "Unable to resolve the configured model" })
    })
    if (model === undefined) {
      return yield* new Error({
        operation: "model",
        message: `Unknown model ${selection.provider}/${selection.id}`
      })
    }
    return { ...loaded, modelRuntime, model }
  })
  return ModelRuntime.of({ sessionOptions })
})

export const layer = (options: Options = {}): Layer.Layer<ModelRuntime, never, ResourceLoader.ResourceLoader> =>
  Layer.effect(ModelRuntime, make(options))
