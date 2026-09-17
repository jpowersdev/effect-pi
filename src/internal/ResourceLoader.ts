import * as Pi from "@earendil-works/pi-coding-agent"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"

export type Settings = NonNullable<Parameters<typeof Pi.SettingsManager.inMemory>[0]>
type SdkOptions = ConstructorParameters<typeof Pi.DefaultResourceLoader>[0]

export interface Options extends Omit<SdkOptions, "cwd" | "settingsManager" | "agentDir"> {
  /** Defaults to Pi's agent directory. Discovery executes trusted extensions. */
  readonly agentDir?: string
  /** When supplied, use in-memory settings rather than discovering settings files. */
  readonly settings?: Settings
}

export interface EmptyOptions {
  readonly systemPrompt?: string
  readonly settings?: Settings
}

export class Error extends Schema.TaggedError<Error>()("ResourceLoaderError", {
  operation: Schema.Literals(["load", "release"]),
  message: Schema.String
}) {}

/** SDK interoperability values. Each load owns a fresh, session-local extension runtime. */
export interface Loaded {
  readonly resourceLoader: Pi.ResourceLoader
  readonly settingsManager: Pi.SettingsManager
}

export interface Operations {
  readonly load: (cwd: string) => Effect.Effect<Loaded, Error, Scope.Scope>
}

export class ResourceLoader extends Context.Service<ResourceLoader, Operations>()(
  "@jpowersdev/effect-pi/ResourceLoader"
) {}

const scoped = (create: (cwd: string) => Loaded): Operations => ({
  load: Effect.fn("ResourceLoader.load")(function* (cwd) {
    // Register invalidation before reload: even failed/late extension loading must
    // release its tracked event-bus subscriptions. Pi reload has no AbortSignal.
    const loaded = yield* Effect.acquireRelease(
      Effect.try({
        try: () => create(cwd),
        catch: () => new Error({ operation: "load", message: "Unable to construct Pi resources" })
      }),
      ({ resourceLoader }) => Effect.try({
        try: () => resourceLoader.getExtensions().runtime.invalidate(),
        catch: () => new Error({ operation: "release", message: "Unable to release Pi resources" })
      }).pipe(Effect.orDie)
    )
    yield* Effect.tryPromise({
      try: () => loaded.resourceLoader.reload(),
      catch: () => new Error({ operation: "load", message: "Unable to load Pi resources" })
    }).pipe(Effect.uninterruptible)
    return loaded
  })
})

/** Opt into Pi resource discovery. Prefer layerEmpty for isolated applications. */
export const layer = (options: Options = {}): Layer.Layer<ResourceLoader> => Layer.sync(ResourceLoader, () =>
  scoped((cwd) => {
    const { settings, ...loaderOptions } = options
    const agentDir = options.agentDir ?? Pi.getAgentDir()
    const settingsManager = settings === undefined
      ? Pi.SettingsManager.create(cwd, agentDir)
      : Pi.SettingsManager.inMemory(settings)
    return {
      settingsManager,
      resourceLoader: new Pi.DefaultResourceLoader({ ...loaderOptions, cwd, agentDir, settingsManager })
    }
  }))

/** No filesystem discovery, extensions, context files, or ambient settings. */
export const layerEmpty = (options: EmptyOptions = {}): Layer.Layer<ResourceLoader> => Layer.sync(ResourceLoader, () =>
  scoped(() => {
    const extensions = { extensions: [], errors: [], runtime: Pi.createExtensionRuntime() }
    return {
      settingsManager: Pi.SettingsManager.inMemory(options.settings),
      resourceLoader: {
        getExtensions: () => extensions,
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => options.systemPrompt,
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [],
        getAppendSystemPromptSources: () => [],
        extendResources: () => {},
        reload: async () => {}
      }
    }
  }))
