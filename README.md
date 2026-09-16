# @jpowersdev/effect-pi

Scoped [Effect](https://effect.website) services for [Pi](https://github.com/earendil-works/pi) coding-agent sessions. Use a session directly, share sessions in one process, or route requests through Effect Cluster without changing the calling code.

**Experimental.** Built for personal experiments, with no API stability or production-support commitment yet. Node.js 26+, ESM, Effect `4.0.0-rc.115`, Pi `0.84.4`.

**Not a sandbox.** Pi can execute tools and extensions with your process's permissions. `cwd` is a working directory, not a filesystem boundary. Read the [trust and security notes](#trust-and-security) before accepting untrusted prompts or opening unfamiliar workspaces.

## Why this exists

Pi already owns the agent loop and conversation format. This package adds Effect lifetimes, prompt serialization, typed operational errors, live streams, and an authoritative `KeyValueStore` document. Ownership is a separate choice: direct, reference-counted local sessions, or an optional cluster adapter.

It does not replace Pi, implement another conversation format, or make model calls exactly-once.

## Install

```sh
pnpm add @jpowersdev/effect-pi effect@4.0.0-rc.115
```

Effect is an **exact peer dependency** while these APIs are release candidates. Keep all `@effect/*` packages on the matching release. The Pi SDK is an exact runtime dependency; add `@earendil-works/pi-coding-agent@0.84.4` directly if you import it to configure sessions.

For the optional Node/SQLite examples:

```sh
pnpm add @effect/platform-node@4.0.0-rc.115 @effect/sql-sqlite-node@4.0.0-rc.115
```

TypeScript consumers currently need `skipLibCheck: true` because the pinned upstream Pi/provider declarations have NodeNext compatibility issues. The library and examples are otherwise checked with strict TypeScript. Only Node 26 is currently verified; browser and CommonJS usage are not supported.

## Quick start: local ownership

This short example deliberately reuses **your existing trusted Pi model/auth configuration and resource discovery**. For explicit configuration without ambient discovery, use the [runnable examples](examples/README.md).

Create a private `.data/` directory first (`mkdir -p .data && chmod 700 .data` on Unix). The SQLite database contains unencrypted conversation data.

```ts
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import { LocalSessions, Session, Sessions } from "@jpowersdev/effect-pi"

const SqlLive = SqliteClient.layer({ filename: ".data/effect-pi.sqlite" })
const StoreLive = KeyValueStore.layerSql({ table: "pi_sessions" }).pipe(
  Layer.provide(SqlLive)
)
const SessionsLive = LocalSessions.layer({
  cwd: process.cwd(),
  configure: () => ({ tools: ["read", "grep", "find", "ls"] })
}).pipe(Layer.provide([NodeServices.layer, StoreLive]))

const program = Effect.gen(function*() {
  const sessions = yield* Sessions
  const id = yield* Schema.decodeUnknownEffect(Session.Id)("experiment-1")
  const session = yield* sessions.open(id)
  const result = yield* session.prompt("Describe the top-level files in this repository")
  yield* Console.log(result.text)
}).pipe(Effect.scoped, Effect.provide(SessionsLive))

NodeRuntime.runMain(program)
```

Running it again with the same id and store restores the conversation. The read-only tool allowlist does **not** disable extension discovery or prevent reads outside `cwd`.

## Public API

Only four concepts are exported from the package root:

| Export | Purpose |
| --- | --- |
| `Session` | Id/event/result schemas, `Session.Error`, the session interface, and scoped `Session.make` |
| `Sessions` | Service providing `open(id)` within a scope |
| `LocalSessions` | `layer(config)` backed by `RcMap` |
| `ClusterSessions` | `runnerLayer(config)` and `clientLayer` |

A session provides:

- `prompt(text)` — serialize a nonempty prompt, wait for Pi, checkpoint, and return a result.
- `abort` — interrupt the active prompt and wait for settlement and a checkpoint. Queued prompts are not cancelled by this call.
- `snapshot` — current status, message count, and last assistant text.
- `events` — ephemeral status, text-delta, and tool lifecycle events.
- `jsonl` — serialize current state; this is **not** a store flush operation.

`configure(id)` synchronously returns Pi SDK options, except `cwd` and `sessionManager`, which the library owns. Prepare asynchronous dependencies such as `ModelRuntime` before constructing the layer. SDK options are version-coupled, not an independent stable abstraction.

### Direct sessions

`Session.make({ id, cwd, configure? })` needs `FileSystem`, `Path`, `KeyValueStore`, and a `Scope`. It does not require `Sessions` or Cluster. Each call creates its own resource; do not independently construct the same stored id twice.

See [examples/Direct.ts](examples/Direct.ts).

### Local sessions

`LocalSessions.layer` shares one live resource per id **within that layer instance**. Reuse the layer rather than making one per request. `open` holds a reference until its scope closes; unreferenced resources stay resident for `idleTimeToLive` (default: 15 minutes). Closing the layer releases them immediately.

This is the preferred choice for a single owning Node process. Other processes can use that application's existing HTTP/RPC interface.

See [examples/Local.ts](examples/Local.ts).

### Cluster sessions

Clients provide `ClusterSessions.clientLayer`; runners register `ClusterSessions.runnerLayer`. Both need Effect Cluster sharding. Runners additionally need the Node services and the authoritative store. A client `open` is lightweight; construction/load errors can arrive on the first operation rather than at `open`.

Runner defaults: resource idle TTL 15 minutes, entity idle timeout 20 minutes, mailbox capacity 128. Long-lived event subscriptions keep resources in use. Runner and client processes must use compatible package versions and cluster configuration.

The [cluster example](examples/README.md#cluster-two-processes) includes actual socket transport, runner discovery, and SQL storage—not placeholder layers. SQLite supports the **same-machine demo**. Across machines, use a shared database for coordination and session documents; do not put SQLite on a network filesystem.

## Cancellation and lifetime

- Prompt effects are owned by both the caller and the live session. Interrupting either cancels the SDK invocation and waits for it to settle before releasing the prompt gate.
- Cancellation signals the agent, retries, compaction, summaries, and SDK bash execution. During asynchronous preflight it keeps requesting abort, so a subsequently started model run is also cancelled.
- Interrupting a queued prompt does not abort the currently running prompt.
- Resource release stops owned work, stops the checkpoint worker, saves final state, unsubscribes, disposes Pi, and removes temporary files.
- Pi's asynchronous factory has no cancellation API. Acquisition waits for it to return so a late resource cannot leak. An in-flight store commit is also protected from interruption.

**Cancellation is cooperative, not a hard deadline.** Broken/stalled tools, extensions, SDK acquisition, or stores can delay timeout completion and shutdown. Use bounded backend operations and process isolation when you need a forced termination boundary.

Cluster prompt handlers are interruptible and prompt RPCs are **not persisted**. Cancellation must reach the runner to stop remote work. A lost connection, timeout, or runner failure does not prove that no model/tool work occurred; do not automatically retry an uncertain prompt.

## Results, errors, and events

`PromptResult.text` and `stopReason` describe the last **new** assistant response. An extension command that produces no assistant response fails rather than returning an old answer. SDK terminal `error`/`aborted` responses become `Session.Error` failures with the SDK diagnostic when available.

Token and cost fields sum usage recorded in entries appended during the invocation: assistant responses, tool-reported nested usage, compaction, and branch summaries. Total tokens can include cached tokens. These are SDK estimates, not billing guarantees; unreported extension/provider work cannot be counted.

Operational failures use `_tag: "SessionError"` with `sessionId`, `operation`, and `message`. An explicit abort or caller interruption interrupts the prompt Effect. A failed release checkpoint surfaces as a **defect carrying `Session.Error`**, since scope finalizers do not have a typed error channel. Model-fallback and extension-load diagnostics are logged as warnings; background checkpoint failures are logged and retried at subsequent checkpoint boundaries.

Events have monotonically increasing sequence numbers **per live resource**, resetting on restoration. The live buffer holds 1,024 events and discards oldest events on overflow. Slow subscribers can see gaps. There is no replay or subscription persistence. Reconcile using `snapshot`/`jsonl` or the completed prompt result; an event is not a durability acknowledgement.

Start the stream before prompting. Across Cluster, starting a client fiber does not acknowledge that the remote subscription is established, so initial events can be missed. See [Shared.run](examples/Shared.ts) for best-effort event consumption in a scope.

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
- Model spending limits, request/concurrency limits, tool policies, storage permissions, encryption, backups, and retention. The cluster mailbox limit is not a global cap on active prompt requests.
- Securing cluster transport and database access. The example binds loopback and has no application authentication.

There is no multi-tenant security boundary here. Treat stored JSONL, configured SDK resources, and runner configuration as trusted inputs. Report security concerns privately to the maintainer rather than including credentials or private transcripts in an issue.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm pack
```

`check` includes the runnable examples. Tests use disposable directories and deterministic SDK doubles, plus real SessionManager/SDK construction and the public cluster client; no paid model requests are made. `pack` cleans, checks, tests, and builds before packaging. Source files are included so source/declaration maps resolve.

Nix/direnv is optional. The provided development shell currently targets Linux and refreshes a read-only Effect reference checkout under `.vendor/`; ordinary pnpm development does not require it.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE), the same license used by Effect.
