# Runnable examples

These are ESM Node programs compiled by `pnpm build` and typechecked by `pnpm check`. They use the package's **public exports**, not internal adapters.

- [Direct.ts](Direct.ts): one scoped, in-process `Session.make`.
- [Local.ts](Local.ts): a reference-counted `Sessions` pool in one process.
- [ClusterRunner.ts](ClusterRunner.ts) and [ClusterClient.ts](ClusterClient.ts): separate processes communicating over a real socket.
- [Shared.ts](Shared.ts): explicit model/resource configuration, SQLite storage, and scoped event consumption.

“In-process” does not mean synchronous JavaScript: all operations return Effects. No extra application server is needed for direct/local usage.

## Setup

From a checkout, install Node 26 and the pinned pnpm version, then:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Choose a model present in Pi `0.84.4`'s built-in catalog and a corresponding API key. For example:

```sh
export EFFECT_PI_PROVIDER=anthropic
export EFFECT_PI_MODEL=claude-sonnet-4-5
# Set EFFECT_PI_API_KEY through your shell/secret manager; do not commit it.
```

The key is supplied as a runtime override, not written to the Pi credential file. These examples use an explicit model, an in-memory settings manager, and a resource loader with no filesystem discovery. They do not load your usual Pi extensions, skills, prompts, or AGENTS.md files. They still enable Pi's **read-only filesystem tools**, which are not confined to `cwd`.

Optional environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `EFFECT_PI_DATA_DIR` | `.data/effect-pi` | Directory for SQLite and example-specific auth path; use the same absolute path for cluster processes |
| `EFFECT_PI_CWD` | process working directory | Runner's tool working directory; not a sandbox |
| `EFFECT_PI_SESSION_ID` | `direct-demo`, `local-demo`, or `cluster-demo` | Session to create/restore |
| `EFFECT_PI_RUNNER_PORT` | `34431` | Loopback socket port for a runner |

The data directory is created with mode `0700` on Unix; an existing directory's permissions are not changed. SQLite/log output is **not encrypted**. Conversation text and tool output may contain private information.

The examples make paid model calls unless invoked with `--snapshot`. Snapshot mode constructs/restores a session but never calls `prompt`, so you can smoke-test it with `EFFECT_PI_API_KEY=unused-snapshot-only`. A cluster client needs only the data-directory/session-id configuration, not model credentials.

## Direct and local

```sh
node dist-examples/Direct.js "Say hello in one sentence"
node dist-examples/Local.js "Say hello in one sentence"
```

Or build and run through `pnpm example:direct` / `pnpm example:local`.

Use `--snapshot` instead of a prompt for a no-model-call smoke test:

```sh
node dist-examples/Local.js --snapshot
```

Run again with the same session id and database to restore state. The local example exits after one prompt; a long-lived application would keep its layer alive and open a fresh scope for each use. Do not run independent direct/local owners against the same session key concurrently.

## Cluster: two processes

Set the same absolute `EFFECT_PI_DATA_DIR` in each terminal. All commands can run from the same checkout.

**Terminal 1 — runner**, with provider/model/API key configured:

```sh
export EFFECT_PI_DATA_DIR=/absolute/path/to/private/effect-pi-demo
node dist-examples/ClusterRunner.js
```

**Terminal 2 — client**, without model credentials:

```sh
export EFFECT_PI_DATA_DIR=/absolute/path/to/private/effect-pi-demo
node dist-examples/ClusterClient.js --snapshot
node dist-examples/ClusterClient.js "Say hello in one sentence"
```

An optional second runner can use `EFFECT_PI_RUNNER_PORT=34432`. Both runners must register the same entity implementation and share the database and compatible configuration. Session ids route to their current owner; `cwd` and model/tool configuration are those of that runner. Stop a runner with Ctrl+C to exercise graceful release, then use the client again with another runner available.

The database contains separate tables for cluster coordination/message storage and authoritative Pi JSONL. **Prompt RPCs are not persisted**, even though message storage is configured. The client discovers runners through the shared SQL runner storage; no hard-coded client destination is needed.

This is a **same-machine demonstration**, not a production distributed deployment:

- SQLite uses a local filesystem. Do not use a network share to extend this across hosts; replace `Shared.SqlLive` with a shared SQL service such as Postgres.
- Protect the database and runner transport. The demo binds `127.0.0.1` and does not implement authentication or TLS.
- Independent writers/stale owners require stronger fencing than a plain key/value store.
- Real network partitions and hard runner loss are not exactly-once execution. Inspect state before deciding whether to resubmit uncertain work.

## Events and cancellation

`Shared.run` starts a scoped event-consumer fiber before prompting, prints events and the final result, and applies a two-minute prompt timeout. Events are best-effort: a cluster subscription has no establishment acknowledgement, and slow subscribers can lose events. Use the final result or a snapshot to reconcile.

To abort from another fiber while keeping the session alive:

```ts
const prompting = yield* session.prompt("Do some work").pipe(Effect.forkScoped)
// In a UI this would be driven by a cancel action, not a fixed delay.
yield* Effect.sleep("1 second")
yield* session.abort
const exit = yield* Fiber.await(prompting)
// Inspect exit if needed; do not join expecting a successful prompt result.
yield* Console.log(exit)
```

Interrupting the prompt fiber also cancels it. Cancelling a queued prompt does not cancel the active one. Closing the owning scope cancels and settles active work before the final checkpoint.

Timeouts and Ctrl+C still wait for cooperative SDK/tool cleanup and store commits. Use an isolated process if you require forced termination; killing it can lose uncheckpointed state, and does not undo model charges or tool side effects.

## Using examples from npm

The tarball includes both source and compiled examples. Their optional dependencies are intentionally **not** library runtime dependencies:

```sh
pnpm add @jpowersdev/effect-pi effect@4.0.0-rc.115 \
  @effect/platform-node@4.0.0-rc.115 @effect/sql-sqlite-node@4.0.0-rc.115
node node_modules/@jpowersdev/effect-pi/dist-examples/Direct.js --snapshot
```

Set the same environment variables described above. If you copy the TypeScript sources into another project, also directly install `@earendil-works/pi-coding-agent@0.84.4`, use ESM/NodeNext, and enable `skipLibCheck` for the pinned upstream declarations. The compiled examples are demonstrations, not additional supported package API exports.
