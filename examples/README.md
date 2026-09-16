# Examples

Each example is a complete program. Pick one file and copy it into your project—there are no imports from other examples or shared helpers. The repeated setup is intentional.

| Example | What it shows |
| --- | --- |
| [single-session.ts](single-session.ts) | Create one session, send a prompt, and save its history in SQLite. |
| [local-session-pool.ts](local-session-pool.ts) | Open a session through a pool, release it, then reopen it in another request scope. |
| [cluster-session.ts](cluster-session.ts) | Start a runner and a client in the same process, send requests over a local socket, then shut both down. |

## Setup

Use Node 26 and the pnpm version in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Choose a model in Pi's built-in catalog and supply its API key. For example:

```sh
export EFFECT_PI_PROVIDER=anthropic
export EFFECT_PI_MODEL=claude-sonnet-4-5
# Set EFFECT_PI_API_KEY through your shell or secret manager. Don't commit it.
```

Each program configures Pi explicitly. It uses the supplied key as a runtime override rather than saving it, and doesn't load your usual Pi extensions, skills, prompts, or context files. The enabled tools are `read`, `grep`, `find`, and `ls`.

## Run an example

```sh
pnpm example:session "Say hello in one sentence"
pnpm example:pool "Say hello in one sentence"
pnpm example:cluster "Say hello in one sentence"
```

Or run the compiled files directly:

```sh
node dist-examples/single-session.js "Say hello in one sentence"
node dist-examples/local-session-pool.js "Say hello in one sentence"
node dist-examples/cluster-session.js "Say hello in one sentence"
```

All three save conversations in SQLite. Run an example again with the same session id and data directory to continue its conversation. The pool example also reopens the session before exiting and prints its snapshot, showing how separate requests can use the same pool.

### Try it without a model request

Pass `--snapshot` instead of a prompt. This creates or restores a real session but doesn't invoke a model or any tools, so a dummy key is sufficient:

```sh
EFFECT_PI_API_KEY=unused-snapshot-only pnpm example:cluster --snapshot
```

Keep the provider and model variables set. Normal prompt mode makes paid model calls and prints live events followed by the result.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EFFECT_PI_DATA_DIR` | `.data/effect-pi` | Directory containing `sessions.sqlite` and the example-specific auth path. |
| `EFFECT_PI_CWD` | Current working directory | Working directory for Pi's tools. |
| `EFFECT_PI_SESSION_ID` | `single-session`, `pooled-session`, or `cluster-session` | Conversation to create or restore. |
| `EFFECT_PI_RUNNER_PORT` | `34431` | Loopback port used by the cluster example. |

Use different session ids when running independent examples concurrently. They must not write to the same conversation at the same time.

## How the cluster example runs

You only need **one command and one terminal**. `cluster-session.ts` starts the runner, creates a separate client runtime, and uses the public `Sessions` API to make a request. The client discovers the runner through a shared in-memory store and connects over a real loopback socket; this isn't a fake transport or a direct call to the runner's session.

Both runtimes live in the same Effect scope. When the program finishes or is interrupted, it closes the client and runner and releases their resources. There is no background server to stop manually.

This is a local demonstration. Running across machines requires a shared database such as Postgres and secured transport, not SQLite on a network share. The example uses in-memory storage for cluster coordination and SQLite for saved conversations. Prompt requests are not persisted for replay. See the [reference guide](../docs/reference.md#cluster-sessions) for deployment details.

## Safety and cancellation

- Read-only tools are **not a sandbox**: they can read outside `EFFECT_PI_CWD`. Use trusted workspaces.
- The data directory is created with mode `0700` on Unix, but existing permissions are not changed. Conversations and logs are not encrypted and may contain private data.
- Live events are best-effort. A remote subscription can miss initial events; use the completed result or a snapshot to reconcile.
- Prompts have a two-minute timeout. Cancellation and Ctrl+C still wait for Pi, its tools, and storage writes to settle. They do not undo file changes or model charges.

## Copying an example into another project

Install `@jpowersdev/effect-pi` using a [local tarball or published release](../docs/reference.md#installation-and-compatibility), then add the packages imported by the example:

```sh
pnpm add effect@4.0.0-rc.115 @earendil-works/pi-coding-agent@0.84.4 \
  @effect/platform-node@4.0.0-rc.115 @effect/sql-sqlite-node@4.0.0-rc.115
```

Use an ESM project (`"type": "module"`). Node 26 can run the copied TypeScript file directly:

```sh
node single-session.ts --snapshot
```

Set the environment variables as described above. If you compile with TypeScript, use NodeNext and `skipLibCheck` for the pinned upstream declarations.

The npm tarball includes the source and compiled examples too. With their optional dependencies installed, you can run one without copying it:

```sh
node node_modules/@jpowersdev/effect-pi/dist-examples/single-session.js --snapshot
```
