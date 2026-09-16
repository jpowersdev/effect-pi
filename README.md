# effect-pi

Use the [Pi coding agent](https://github.com/earendil-works/pi) in an [Effect](https://effect.website) application.

effect-pi wraps Pi's SDK so you can send prompts, follow responses as they arrive, and pick up saved conversations later. It handles session cleanup and makes sure prompts for the same session run one at a time.

Start with sessions running in your own process. If you later want to run them on separate workers, switch to Effect Cluster—the code that uses a session stays the same.

This is a small, experimental project for personal use. The API may change.

## What using it looks like

Once you've set up a `Sessions` layer, your application code looks like this:

```ts
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { Session, Sessions } from "@jpowersdev/effect-pi"

export const program = Effect.gen(function*() {
  const sessions = yield* Sessions
  const id = Session.Id.make("my-project")
  const session = yield* sessions.open(id)
  const reply = yield* session.prompt("Explain how this project is organized")
  yield* Console.log(reply.text)
}).pipe(Effect.scoped)
```

Use the same id and storage to continue the conversation later. You can also listen to `session.events`, check progress with `session.snapshot`, or stop the current prompt with `session.abort`.

The [complete local example](examples/local-session-pool.ts) shows how to provide the model, storage, and session layer around this code.

## Try it

You'll need **Node.js 26+**, pnpm, and a model provider's credentials to send prompts.

```sh
pnpm install --frozen-lockfile
pnpm build
```

Follow the [example setup](examples/README.md#setup) to choose a model and configure credentials, then run:

```sh
pnpm example:pool "Say hello in one sentence"
```

The examples use SQLite to save conversations and explicitly configure Pi rather than loading your usual extensions and settings.

There are three ways to use the library:

- **One session:** [`single-session.ts`](examples/single-session.ts) sends a prompt and saves the conversation.
- **A pool of sessions:** [`local-session-pool.ts`](examples/local-session-pool.ts) opens a session, releases it, and reopens it in another request. This is the best place to start.
- **Cluster-backed sessions:** [`cluster-session.ts`](examples/cluster-session.ts) starts a client and runner in one process, communicating over a local socket.

Each example is self-contained, including its configuration and storage setup.

For use in another project, see [installation and compatibility](docs/reference.md#installation-and-compatibility). The package is named `@jpowersdev/effect-pi` and currently uses Effect `4.0.0-rc.115` and Pi `0.84.4`.

## A few things to know

- **This isn't a sandbox.** Pi's tools and extensions run with your process's permissions. Even read-only tools can read outside the working directory, so use trusted workspaces and protect your credentials.
- **Saved conversations can contain private data.** Choose storage and access controls accordingly. The examples don't encrypt their database.
- **Stopping work doesn't undo it.** Cancellation waits for Pi and its tools to stop. A timeout or lost connection doesn't undo file changes or model charges, so don't blindly retry a prompt.

Pi still handles the agent loop and its conversation format. This library adds the Effect integration; it doesn't try to replace Pi or provide a hosted agent service.

The [reference guide](docs/reference.md) covers configuration, storage requirements, cancellation, and the limits of cluster execution.

## Development

```sh
pnpm check
pnpm test
pnpm pack
```

Tests don't make paid model requests. `pnpm pack` runs a clean build, checks, and tests before producing the package. Nix/direnv is available but optional.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release notes, and [CHANGELOG.md](CHANGELOG.md) for changes.

## License

[MIT](LICENSE), the same license used by Effect.
