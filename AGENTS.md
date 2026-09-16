# Agent instructions

## Effect

- Follow [`EFFECT.md`](EFFECT.md) for TypeScript and Effect implementation conventions.
- A local copy of the Effect v4 codebase is available at `.vendor/effect/`. Consult it when exact API behavior, types, implementation details, or examples are needed.
- The Nix development environment checks that copy for upstream updates at most once every 24 hours.
- Treat `.vendor/effect/` as read-only reference material. Do not modify it, depend on it by local path, or add it to Git.
- Verify that referenced APIs match the Effect version pinned by this project; the project's installed dependency is authoritative if versions differ.

## Project architecture

- This package is a reusable library, not an application executable. Keep public exports under `src/index.ts` and verify changes with `pnpm pack`.
- Keep the public API limited to `Session`, `Sessions`, `LocalSessions`, and `ClusterSessions`; implementation details belong under `src/internal/`.
- `Session.make` is the cluster-independent scoped constructor. `LocalSessions` shares sessions with `RcMap`; `ClusterSessions` is an optional ownership and transport adapter.
- The configured `KeyValueStore` is the authoritative durable store for Pi JSONL. Pi's `SessionManager` remains authoritative for the JSONL format, migrations, and conversation-tree behavior.
- Prompts for one live session must be serialized, while aborts and event subscriptions must remain concurrent with a running prompt.
- Do not mark model prompt RPCs as persisted without an explicit idempotency protocol; replaying an interrupted model invocation is not exactly-once.
- Live event streams are ephemeral. Persist conversation state, not event subscriptions.
