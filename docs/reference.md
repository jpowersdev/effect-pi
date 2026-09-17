# API and behavior reference

This guide describes the details behind the [README](../README.md). For runnable programs, see the [examples](../examples/README.md).

## Installation and compatibility

The package is named `@jpowersdev/effect-pi`. To install a local build, run this from a checkout:

```sh
pnpm install --frozen-lockfile
pnpm pack --pack-destination /tmp/effect-pi-pack
```

Then, from the consuming project:

```sh
pnpm add /tmp/effect-pi-pack/jpowersdev-effect-pi-0.1.0.tgz effect@4.0.0-rc.115
```

For a published release, use the package name in place of the tarball path.

The supported configuration is Node.js 26+, ESM, Effect `4.0.0-rc.115`, and Pi `0.84.4`. Effect is an exact peer dependency while these APIs are release candidates. Keep all `@effect/*` packages on the matching release.

The Pi SDK is an exact runtime dependency. Normal usage and the examples don't import it directly. Add `@earendil-works/pi-coding-agent@0.84.4` only for advanced SDK interoperability. The optional Node/SQLite example dependencies are:

```sh
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/sql-sqlite-node@4.0.0-rc.115
```

TypeScript consumers currently need `skipLibCheck: true` because the pinned upstream Pi/provider declarations have NodeNext compatibility issues. The library and examples are otherwise checked with strict TypeScript. Browser and CommonJS usage are not supported.

## Public API

Six concepts are exported from the package root:

| Export | Purpose |
| --- | --- |
| `ResourceLoader` | `layer` / `layerConfig` for Pi discovery; `layerEmpty` / `layerEmptyConfig` for isolation |
| `ModelRuntime` | `layer` / `layerConfig`, depending on `ResourceLoader` |
| `Session` | Id/event/result schemas, `Session.Error`, the session interface, and scoped `Session.make` |
| `Sessions` | Service providing `open(id)` within a scope |
| `LocalSessions` | `layer` / `layerConfig`, backed by `RcMap` |
| `ClusterSessions` | `runnerLayer` / `runnerLayerConfig`, and `clientLayer` |

A session provides:

- `prompt(text)` — accept a nonempty prompt, wait its turn, run Pi, save a checkpoint, and return a result.
- `abort` — interrupt the active prompt and wait for settlement and a checkpoint. Queued prompts are not cancelled by this call.
- `snapshot` — current status, message count, and last assistant text.
- `events` — ephemeral status, text-delta, and tool lifecycle events.
- `jsonl` — serialize current state. This is **not** a store flush operation.

`configure(id)` synchronously returns per-session SDK options such as tool policy and thinking level. The library owns `cwd`, `sessionManager`, `modelRuntime`, `model`, `resourceLoader`, and `settingsManager`. SDK interoperability options remain version-coupled.

### Resources and models

Declare reusable configuration recipes and layers at module scope. Compose them at the application boundary, rather than building the graph inside the application Effect:

```ts
import * as Config from "effect/Config"
import * as Layer from "effect/Layer"

import { LocalSessions, ModelRuntime, ResourceLoader } from "@jpowersdev/effect-pi"

const ModelConfig = Config.all({
  provider: Config.NonEmptyString("EFFECT_PI_PROVIDER"),
  modelId: Config.NonEmptyString("EFFECT_PI_MODEL"),
  apiKey: Config.Redacted("EFFECT_PI_API_KEY")
}).pipe(
  Config.map(({ provider, modelId, apiKey }) => ({
    model: { provider, id: modelId },
    apiKeys: { [provider]: apiKey },
    authPath: ".data/auth.json",
    modelsPath: null,
    refreshOnCreate: false
  }))
)

const ResourcesLive = ResourceLoader.layerEmpty({
  systemPrompt: "You are a helpful assistant.",
  settings: { retry: { enabled: false } }
})

const ModelLive = ModelRuntime.layerConfig(ModelConfig).pipe(
  Layer.provide(ResourcesLive)
)

const SessionsLive = LocalSessions.layerConfig({
  cwd: Config.NonEmptyString("EFFECT_PI_CWD").pipe(Config.withDefault(".")),
  configure: Config.succeed(() => ({ tools: ["read", "grep", "find", "ls"] }))
}).pipe(
  Layer.provide(ModelLive)
)

// Provide Node services and a KeyValueStore at the application boundary.
```

The config constructors accept `Config.Wrap<Options>`: either a complete `Config<Options>` or a nested record of individual `Config` values. Use `Config.succeed` for constant fields and callbacks, or use the plain `layer` constructors when all options are already known. Config is parsed **when the layer builds**, using the active `ConfigProvider`, so the same layer definition can be composed with different providers. Missing or invalid config fails the layer with `Config.ConfigError`, before sessions are opened.

For genuinely effectful construction that needs other services, `Layer.unwrap` remains available. Keep such work at the relevant layer boundary; the application Effect should consume services, not assemble them.

Supply runtime-only keys with `apiKeys: { [provider]: apiKey }`, where `apiKey` is an Effect `Redacted<string>` (for example, from `Config.Redacted`). The library installs these keys without persisting them; Pi may still create an empty auth file. Other model options follow Pi's `CreateModelRuntimeOptions`, except that the library supplies the cancellation signal. Omitting `model` lets Pi restore/select it from session history and settings.

`ResourceLoader.layerEmpty` does no filesystem discovery and uses in-memory settings. `ResourceLoader.layer` opts into trusted Pi discovery, defaulting to Pi's agent directory; `agentDir` overrides the resource directory, and `settings` replaces discovered settings with an in-memory configuration. Configure model/auth paths separately on `ModelRuntime` when using a custom directory.

These services capture reusable configuration, **not shared mutable SDK instances**. The `ResourceLoader` service's `load(cwd)` and the `ModelRuntime` service's `sessionOptions(cwd)` are scoped Effects; sessions call them automatically. Each live session receives a fresh resource loader, settings manager, and model runtime. Extension-provided models are registered before model selection. Reusing a layer does not share extension bindings or runtime credentials between live sessions.

Direct service calls fail with `ResourceLoader.Error` or `ModelRuntime.Error`, each carrying `operation` and `message`. Session construction maps these to `Session.Error` with operation `make`. Raw SDK error payloads are not retained because they can contain credentials. Loaded/binding values expose SDK handles only as an advanced interoperability boundary; don't share them between live sessions or use them after their scope closes.

### Direct sessions

`Session.make({ id, cwd, configure? })` needs `ModelRuntime`, `FileSystem`, `Path`, `KeyValueStore`, and a `Scope`. It does not require `Sessions` or Cluster. Each call creates its own resource; do not independently construct the same stored id twice.

See [single-session.ts](../examples/single-session.ts).

### Local sessions

`LocalSessions.layer` shares one live resource per id **within that layer instance**. Reuse the layer rather than making one per request. `open` holds a reference until its scope closes; unreferenced resources stay resident for `idleTimeToLive` (default: 15 minutes). Closing the layer releases them immediately.

This is the preferred choice for a single owning Node process. Other processes can use that application's existing HTTP/RPC interface.

See [local-session-pool.ts](../examples/local-session-pool.ts).

### Cluster sessions

Clients provide `ClusterSessions.clientLayer`; runners register `ClusterSessions.runnerLayer`. Both need Effect Cluster sharding. Runners additionally need `ModelRuntime`, the Node services, and the authoritative store. Cluster clients do not need model credentials or resource-loading layers. A client `open` is lightweight; construction/load errors can arrive on the first operation rather than at `open`.

Runner defaults:

| Option | Default |
| --- | --- |
| `resourceIdleTimeToLive` | 15 minutes |
| `entityMaxIdleTime` | 20 minutes |
| `mailboxCapacity` | 128 |

Long-lived event subscriptions keep resources in use. Runner and client processes must use compatible package versions and cluster configuration. The mailbox limit is not a global cap on active prompt requests; handlers run concurrently so aborts and events can proceed during prompts.

The self-contained [cluster example](../examples/cluster-session.ts) starts a runner and a client in one process. They use separate sharding runtimes and communicate over a loopback socket. Discovery and cluster message storage are shared in memory; SQLite stores the conversation documents. `Layer.fresh` keeps the differently configured cluster runtimes from sharing memoized services. Their lifetimes are scoped together, so both shut down when the example finishes.

SQLite supports this local demo. Across machines, use a shared database for coordination and session documents; do not put SQLite on a network filesystem.

## Local setup using existing Pi configuration

The [runnable examples](../examples/README.md) configure Pi explicitly without loading your usual extensions, settings, or context files. If you instead want to reuse your existing **trusted** Pi setup, you can provide a smaller configuration:

```ts
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"

import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"

import { LocalSessions, ModelRuntime, ResourceLoader, Session, Sessions } from "@jpowersdev/effect-pi"

const SqlLive = SqliteClient.layer({ filename: ".data/effect-pi.sqlite" })

const StoreLive = KeyValueStore.layerSql({ table: "pi_sessions" }).pipe(
  Layer.provide(SqlLive)
)

const ModelLive = ModelRuntime.layer().pipe(
  Layer.provide(ResourceLoader.layer())
)

const SessionsLive = LocalSessions.layer({
  cwd: process.cwd(),
  configure: () => ({ tools: ["read", "grep", "find", "ls"] })
}).pipe(
  Layer.provide([ModelLive, NodeServices.layer, StoreLive])
)

const program = Effect.gen(function* () {
  const sessions = yield* Sessions

  const id = Session.Id.make("experiment-1")

  const session = yield* sessions.open(id)

  const result = yield* session.prompt("Describe the top-level files in this repository")

  yield* Console.log(result.text)
}).pipe(
  Effect.scoped,
  Effect.provide(SessionsLive)
)

NodeRuntime.runMain(program)
```

Create a private `.data/` directory first (`mkdir -p .data && chmod 700 .data` on Unix). The SQLite database contains unencrypted conversation data.

This example uses Pi's existing model/auth configuration and resource discovery. Its read-only tool allowlist does **not** disable extension discovery or prevent reads outside `cwd`. Running it again with the same id and store restores the conversation.

## Cancellation and lifetime

- Prompt effects are owned by both the caller and the live session. Interrupting either cancels the SDK invocation and waits for it to settle before releasing the prompt gate.
- Cancellation signals the agent, retries, compaction, summaries, and SDK bash execution. During asynchronous preflight it keeps requesting abort, so a subsequently started model run is also cancelled.
- Interrupting a queued prompt does not abort the currently running prompt.
- Resource release stops owned work, stops the checkpoint worker, saves final state, unsubscribes, disposes Pi, and removes temporary files.
- Pi's resource reload and session factory have no cancellation API. Acquisition waits for them to return so late resources can be released. Resource scopes invalidate extension runtimes even when later model/session setup fails. Model creation and credential setup receive Effect's cancellation signal. An in-flight store commit is also protected from interruption.

**Cancellation is cooperative, not a hard deadline.** Broken/stalled tools, extensions, SDK acquisition, or stores can delay timeout completion and shutdown. Use bounded backend operations and process isolation when you need a forced termination boundary.

Cluster prompt handlers are interruptible and prompt RPCs are **not persisted**. Cancellation must reach the runner to stop remote work. A lost connection, timeout, or runner failure does not prove that no model/tool work occurred; do not automatically retry an uncertain prompt.

## Results, errors, and events

`PromptResult.text` and `stopReason` describe the last **new** assistant response. An extension command that produces no assistant response fails rather than returning an old answer. SDK terminal `error`/`aborted` responses become `Session.Error` failures with the SDK diagnostic when available.

Token and cost fields sum usage recorded in entries appended during the invocation: assistant responses, tool-reported nested usage, compaction, and branch summaries. Total tokens can include cached tokens. These are SDK estimates, not billing guarantees; unreported extension/provider work cannot be counted.

Operational failures use `_tag: "SessionError"` with `sessionId`, `operation`, and `message`. An explicit abort or caller interruption interrupts the prompt Effect. A failed release checkpoint surfaces as a **defect carrying `Session.Error`**, since scope finalizers do not have a typed error channel. Model-fallback and extension-load diagnostics are logged as warnings; background checkpoint failures are logged and retried at subsequent checkpoint boundaries.

Events have monotonically increasing sequence numbers **per live resource**, resetting on restoration. The live buffer holds 1,024 events and discards oldest events on overflow. Slow subscribers can see gaps. There is no replay or subscription persistence. Reconcile using `snapshot`/`jsonl` or the completed prompt result; an event is not a durability acknowledgement.

Start the stream before prompting. Across Cluster, starting a client fiber does not acknowledge that the remote subscription is established, so initial events can be missed. See [cluster-session.ts](../examples/cluster-session.ts) for best-effort event consumption in a scope.

## Persistence contract

The configured `KeyValueStore` holds `<keyPrefix><sessionId>`; the default prefix is `effect-pi/sessions/`. Each value is one complete Pi JSONL document.

The document is materialized in a scoped temporary directory and opened with Pi's `SessionManager`. Pi owns entry formats, migrations, and conversation-tree behavior. Malformed JSON syntax and mismatched session ids fail loading without overwriting the store; this is not a complete validator for hostile documents.

- Successful construction, prompt completion, and abort include a successful checkpoint.
- SDK state-change notifications request background checkpoints; redundant pending requests are coalesced.
- Failed/interrupted calls may still have changed state or performed external work.
- After abrupt process loss, recovery is limited to the last **successfully committed** document.

The backend must provide **atomic replacement**, suitable durability, and enough capacity for a whole conversation document. `KeyValueStore.layerMemory` is useful only for ephemeral sessions/tests. The pinned Effect `layerFileSystem` overwrites files directly and is **not crash-atomic**; the examples use `layerSql` instead.

There must be one writer per key. Separate local pools, direct constructors, or unrelated clusters must not share ownership accidentally. This library does not add compare-and-swap revisions or fencing; deployments that need protection from independent writers or stale owners need stronger coordination at the storage boundary. Back up the store and define retention/deletion policies in the host application.

## Trust and security

Without explicit configuration, Pi can inherit credentials, model settings, extensions, skills, and context from the environment, home directory, and workspace. Its default tool set includes shell execution and file mutation. Extensions are executable code; `noTools` does not turn them into a sandbox.

Host applications are responsible for:

- Authenticating callers and authorizing access to session ids and JSONL.
- Isolating untrusted code/prompts from credentials, files, and network access.
- Protecting transcripts and logs, which may contain source code, tool output, or secrets.
- Model spending limits, request/concurrency limits, tool policies, storage permissions, encryption, backups, and retention.
- Securing cluster transport and database access. The example binds loopback and has no application authentication.

There is no multi-tenant security boundary here. Treat stored JSONL, configured SDK resources, and runner configuration as trusted inputs. Report security concerns privately to the maintainer rather than including credentials or private transcripts in an issue.
