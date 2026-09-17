# Changelog

## 0.1.0 — unreleased

- Scoped direct, local-pool, and cluster-backed Pi sessions with authoritative KeyValueStore JSONL.
- First-class ResourceLoader and ModelRuntime layers, typed SDK setup failures, and per-session isolation of resources, settings, and model runtimes. Session construction now requires ModelRuntime; SDK configuration callbacks no longer own these bindings.
- Cancellation-safe SDK acquisition; session-owned prompt fibers settle before release or reuse.
- Interruptible cluster prompts, concurrent abort, and cancellation of queued prompts without aborting unrelated work.
- Checkpoints on construction, completed/failed prompts, abort, and release; release checkpoint failures are surfaced.
- Rejection of malformed JSON syntax and mismatched stored session identities.
- Fresh-response detection, terminal model-error reporting, and prompt-wide recorded usage totals.
- Bounded sliding event streams, coalesced checkpoint requests, and SDK diagnostic logging.
- Isolated regression tests and self-contained session, pool, and single-process socket-cluster examples using SQLite.
- Exact Effect peer dependency, source-map sources in the tarball, and MIT licensing.
