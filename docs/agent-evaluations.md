# Agent evaluation fixtures

This is a small offline rubric for changes to Lattice's agent runtime. It is intentionally provider-neutral; it checks runtime invariants with fake streams and temporary stores rather than claiming model quality from unit tests.

Each scenario should record:

- verified outcome and the evidence used;
- unsupported completion claims and human corrections;
- time to first useful action and completion latency;
- input, output, reasoning, cache, and child-agent tokens plus cost;
- duplicate tool calls, failed retries, lost handoffs, and constraint retention after compaction.

Baseline scenarios:

1. Two same-file edits in one model batch retain both changes, while independent reads still overlap.
2. A subagent granted only `fs_read` cannot execute `fs_write`, even if the provider emits that call.
3. A large tool result can be pruned and recovered by `read_tool_result` without rerunning the external tool.
4. Compaction preserves tool-only evidence, user constraints, open checklist items, artifact paths, and call IDs.
5. A transient provider failure retries once without duplicate visible text or tool execution.
6. A background agent or shell completion survives a failed wake/delivery attempt and is delivered exactly once.
7. Cancellation releases scheduler leases, stops child work, and leaves the transcript replayable.

For each case, the acceptance result should be deterministic and machine-readable. Opt-in live-model runs can measure whether models choose these paths, but they should remain separate from the offline gate.
