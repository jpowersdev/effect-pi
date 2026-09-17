# Agent instructions

## Effect

- Follow [`EFFECT.md`](EFFECT.md) for TypeScript and Effect implementation conventions.
- Executable example entrypoints use `kebab-case.ts`; reusable library modules retain `PascalCase.ts`.
- Let code breathe: separate definitions and logical steps with blank lines. Expand nested layer/config expressions with consistent indentation and one pipeline operation per line; favor readable visual structure over compactness.
- Define reusable layers at module scope and compose them at application boundaries. Prefer `layerConfig` for `Config`-driven construction; use `Layer.unwrap` only when construction genuinely needs yielded values or services. Don't assemble the whole dependency graph inside the application Effect.
- A local copy of the Effect v4 codebase is available at `.vendor/effect/`. Consult it when exact API behavior, types, implementation details, or examples are needed.
- The Nix development environment checks that copy for upstream updates at most once every 24 hours.
- Treat `.vendor/effect/` as read-only reference material. Do not modify it, depend on it by local path, or add it to Git.
- Verify that referenced APIs match the Effect version pinned by this project; the project's installed dependency is authoritative if versions differ.

## Project architecture

- This package is a reusable library, not an application executable. Keep public exports under `src/index.ts` and verify changes with `pnpm pack`.
- Public concepts are `ResourceLoader`, `ModelRuntime`, `Session`, `Sessions`, `LocalSessions`, and `ClusterSessions`; implementation details belong under `src/internal/`.
- `ModelRuntime` depends on `ResourceLoader`. Reuse their layers, but allocate mutable SDK runtimes, resource loaders, and settings per live session. Keep Promise adapters inside the library, not in examples.
- `Session.make` is the cluster-independent scoped constructor. `LocalSessions` shares sessions with `RcMap`; `ClusterSessions` is an optional ownership and transport adapter.
- The configured `KeyValueStore` is the authoritative durable store for Pi JSONL. Pi's `SessionManager` remains authoritative for the JSONL format, migrations, and conversation-tree behavior.
- Prompts for one live session must be serialized, while aborts and event subscriptions must remain concurrent with a running prompt.
- Do not mark model prompt RPCs as persisted without an explicit idempotency protocol; replaying an interrupted model invocation is not exactly-once.
- Live event streams are ephemeral. Persist conversation state, not event subscriptions.
