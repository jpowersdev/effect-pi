# Contributing and releasing

This is a small experimental library. Bug reports and focused changes are welcome; discuss API expansion before investing in it. There is no promised support schedule.

Use Node 26 and the pnpm version in `package.json`. Nix/direnv is optional. The Linux development shell downloads/refreshes a read-only Effect checkout in `.vendor/`; installed dependencies remain authoritative.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm pack --pack-destination /tmp/effect-pi-pack
```

`check` covers source, tests, and examples. `pack` starts with a clean build and runs checks/tests. Test fixtures must not load a contributor's Pi credentials, extensions, or working files. Normal tests never make model requests.

## Design boundaries

- Keep public exports under `src/index.ts`: `ResourceLoader`, `ModelRuntime`, `Session`, `Sessions`, `LocalSessions`, `ClusterSessions`.
- `ModelRuntime` captures `ResourceLoader`. Reuse configuration layers while allocating mutable SDK bindings per live session; keep Promise adapters inside the library.
- Pi owns JSONL formats/migrations/tree semantics. The configured `KeyValueStore` owns the durable document.
- One live session serializes prompts; cancellation, snapshots, and event subscriptions must remain concurrent.
- Prompt cancellation must settle the underlying SDK operation before the gate or resource is released.
- Do not persist model prompt RPCs without a real idempotency protocol.
- Live events are bounded and ephemeral, not another durable conversation log.
- Keep examples self-contained, even when that repeats setup. The cluster example owns both the runner and client in one process.
- Define reusable layers at module scope. Use `layerConfig` for config-driven options and reserve `Layer.unwrap` for construction that needs yielded values/services. Keep application Effects focused on consuming services.

See `AGENTS.md` and `EFFECT.md` for implementation guidance. Where the SDK offers no cancellation API, document the protected acquisition/cleanup boundary rather than pretending interruption can force it to stop.

## Release checklist

1. Review changes and update `CHANGELOG.md` and the package version.
2. Keep Effect and all `@effect/*` versions aligned and update the lockfile together; review Pi changes together with the SDK-boundary tests.
3. Run a frozen install, checks, tests, and `pnpm pack`.
4. Inspect the tarball: public exports, license, source maps, example assets, and no private/runtime data.
5. Install the tarball in a fresh consumer; typecheck an import and run the compiled `--snapshot` examples with their optional dependencies. See `examples/README.md`.
6. If Git history is available, scan it for secrets before making the repository public. Never include real credentials or transcripts in fixtures/issues.
7. Review API/known-limitations documentation, then publish the reviewed tarball from the intended npm account. Use npm 2FA or trusted publishing; add provenance when the release environment supports it.

CI checks build/test/package creation and exercises the self-contained session, pool, and single-process socket-cluster examples without model requests. Production network partitions, forced process loss, and paid provider behavior still require separate integration validation.
