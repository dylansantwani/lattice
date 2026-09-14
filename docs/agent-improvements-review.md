**Lattice agent effectiveness review — September 7, 2026**

Reviewed the current working tree at commit `d206e2c`, including the existing uncommitted changes. The first implementation pass now covers tool contracts, shell isolation, subagent capability enforcement, context checkpoints, durable tool-result lookup, MCP cancellation, and conflicting-tool scheduling. References below describe the original findings; the implementation status at the end describes what landed in this pass.

The highest-value work is making tool execution dependable, preserving evidence across long runs, and evaluating completed tasks. Lattice already implements much of the usual efficiency advice: parallel tool batches, batch file reads, deferred MCP discovery, stable cache serialization, cached token counting, context pruning, compaction, background jobs, subagent messaging, and retry/steering recovery. Preserve those features while closing the gaps below. Expected benefits are engineering judgments; no speed or cost improvement percentages have been measured.

**Recommended sequence**

| Order | Work | Main benefit | Scope |
| --- | --- | --- | --- |
| 1 | Fix tool validation, literal edits, result status, and conflicting writes | Correct actions and reliable feedback | Several bounded fixes |
| 2 | Give subagents enforced capabilities, separate shells, and context fitting | Useful, dependable parallel work | Moderate runtime work |
| 3 | Preserve tool evidence during compaction and expose stored result retrieval | Fewer repeated calls and better long-task accuracy | Moderate store/runtime work |
| 4 | Make completion delivery durable; bound and group delegated work | Fewer lost handoffs and redundant parent requests | Moderate orchestration work |
| 5 | Add task evaluations and evidence-backed completion checks | Measurable quality and fewer false finishes | Incremental controller/evaluation work |
| Quick wins alongside these | Remove the mandatory naming-only round; fix repository instructions and aggregate checks | Faster first action and less contributor confusion | Small changes |

**1. Make parallel tools safe for shared resources. Confirmed, reproduced.**

Both the [main loop](/Users/dylan/lattice/src/main/runtime/runManager.ts:2013) and [subagent loop](/Users/dylan/lattice/src/main/runtime/runManager.ts:2811) execute every call in a batch through `Promise.all`. [fs_edit](/Users/dylan/lattice/src/main/tools/builtin.ts:847) reads a file, computes a replacement, truncates it, then writes. There is no lock around that sequence.

A disposable-file test reproduced two disjoint replacements to one file both fulfilling while the final file lacked one replacement. This wastes the model's subsequent debugging effort and can invalidate a claimed result.

Add scheduling metadata for read/write resources and execution identity. Preserve parallel reads; serialize conflicting writes and read-after-write dependencies in call order. Locks should cover the same canonical path across parent and sibling agents. Arbitrary shell commands and stateful browser operations need explicit treatment because their effects cannot be inferred from a filesystem path argument. Add file-version checks for stale edits and atomic file replacement for crash resilience; atomic replacement alone does not solve lost updates.

Acceptance: two same-file edits retain both changes; a following read observes the write; independent reads still overlap; cancellation releases locks; tests exercise both agent loops.

**2. Enforce tool contracts and communicate actual outcomes. Confirmed by source and targeted reproductions.**

The [dispatcher](/Users/dylan/lattice/src/main/runtime/runManager.ts:3197) validates that arguments are a JSON object, then separately checks filesystem path arguments. It does not validate the complete declared input schema. [fs_write](/Users/dylan/lattice/src/main/tools/builtin.ts:811) coerces `content` with `String()`: a missing required content argument writes the literal text `undefined`. The disposable-file probe confirmed that behavior.

The single-replacement branch of [fs_edit](/Users/dylan/lattice/src/main/tools/builtin.ts:861) passes model text directly as JavaScript's replacement string. `$&` therefore expands to the matched text rather than being written literally. The probe returned one successful replacement while the file remained unchanged. Use a replacement callback to insert literal text; reject an empty search string explicitly.

The [MCP adapter](/Users/dylan/lattice/src/main/mcp/manager.ts:170) returns `isError` results without normalizing them, and the [dispatcher](/Users/dylan/lattice/src/main/runtime/runManager.ts:3546) records every resolved promise as `ok: true`. An MCP failure can consequently appear inside an outer successful result. Shell nonzero exit codes and search errors also require callers to interpret tool-specific payloads; [grep_search](/Users/dylan/lattice/src/main/tools/builtin.ts:1365) returns errors and missing ripgrep in its `matches` field.

Compile argument validators when tools are registered. Reject invalid input before approval or execution with concise field-level errors. Introduce a common outcome envelope that distinguishes invocation failure, command exit status, cancellation, partial data, and successful results. Do not equate every nonzero shell exit with an infrastructure failure: tools such as search have meaningful no-match statuses. Preserve original diagnostics and return an actionable recovery hint when one is known.

The MCP adapter also ignores `ToolContext.signal`. Pass cancellation and bounded request options through the installed SDK, which already exposes them. A canceled request should settle promptly; an ambiguous external side effect should remain explicitly unknown until checked.

Acceptance: invalid writes leave files unchanged; replacement metacharacters are literal; an MCP `isError: true` result is not reported as success; aborted MCP calls settle; partial/no-match/failure states remain distinguishable.

**3. Give subagents a complete execution boundary. Confirmed source gaps.**

Subagents get a fresh task-only prompt, which usefully limits context, but several runtime boundaries need strengthening:

- The [allowlist](/Users/dylan/lattice/src/main/runtime/runManager.ts:2986) narrows schemas advertised to the model. The [execution path](/Users/dylan/lattice/src/main/runtime/runManager.ts:2813) calls a dispatcher that resolves tools from the parent thread's permissions, without receiving the subagent allowlist. Enforce the granted capability set at dispatch as well as schema construction, including direct calls to known deferred tools.
- [Shell execution](/Users/dylan/lattice/src/main/tools/builtin.ts:1099) uses the parent thread ID as the persistent PTY key. Parent and siblings therefore share a command queue, cwd, and environment. Key shells by agent identity and initialize them to the assigned workspace. Preserve state within one agent, and clean up its shell when it finishes.
- The [main loop fits context before requests](/Users/dylan/lattice/src/main/runtime/runManager.ts:1735), while [subagent requests](/Users/dylan/lattice/src/main/runtime/runManager.ts:2649) resend a growing wire without that fit guard. Generalize the helper to accept the actual model, tools, and wire rather than borrowing parent-thread budget assumptions.
- The [subagent system prompt](/Users/dylan/lattice/src/main/runtime/runManager.ts:2567) consists of the base subagent prompt, role label, and model identity. The parent's standing custom instructions and goal are added through a [different builder](/Users/dylan/lattice/src/main/runtime/runManager.ts:4223). Provide a compact delegation brief containing relevant user constraints, workspace paths, owned files, acceptance checks, and evidence references. Avoid copying an entire parent transcript by default.

Acceptance: a read-only delegate cannot execute a write even if its model emits the tool name; sibling shell state is isolated; a small-context worker survives repeated large reads; standing task constraints survive delegation.

**4. Compact evidence, not just narration. Confirmed and reproduced with a fake provider.**

[compactThread](/Users/dylan/lattice/src/main/runtime/runManager.ts:4649) builds its summary input entirely from message text. It omits tool exchanges, even though its instruction requests commands, artifacts, and outcomes. A text-bearing assistant message can therefore be compacted along with its tool evidence even when that evidence was never shown to the summarizer. Future wires [skip compacted messages](/Users/dylan/lattice/src/main/runtime/runManager.ts:4247).

There is a separate nuance: tool-only assistant messages are excluded by the `m.text.trim()` filter and are consequently left uncompacted. They remain replayable, but their context cannot be reclaimed by this compaction pass. The original records are not deleted from SQLite.

Build compaction input from a bounded event/tool digest plus conversation text. Preserve exact user constraints, unresolved work, changed artifacts, authoritative tool outcomes, and evidence/result IDs in a validated checkpoint. Keep the live checklist alongside it. Validate the checkpoint before switching the active history, and verify that it actually saves context.

Acceptance: facts found only in tool results, failed checks, pending work, and explicit user constraints survive compaction; tool-only turns are handled deliberately; malformed or unhelpful summaries leave the previous active context usable.

**5. Let agents retrieve stored results instead of rerunning tools. Confirmed design limitation.**

[Pruned result placeholders](/Users/dylan/lattice/src/main/runtime/runManager.ts:4025) tell the model to rerun the tool to recover its output. Yet [in-flight pruning](/Users/dylan/lattice/src/main/runtime/runManager.ts:4093) already preserves original results for persistence. There is no dedicated result-ID retrieval path for the model.

Expose `read_tool_result` and bounded search/excerpts over stored results, with stable IDs, origin, age, and pagination. Large new results can return a short useful excerpt plus that reference. This saves model tokens and repeated searches while retaining evidence. For freshness-sensitive reads, allow an explicit refresh. For actions with side effects, recalling the receipt is preferable to repeating the action merely to see what happened.

Acceptance: an agent can recover a pruned result without another external tool invocation; access remains within its authorized task/session scope; stale evidence is clearly dated; large results cannot overwhelm a small model's latest working set.

**6. Deliver background completions durably. Confirmed source gap; failure frequency unmeasured.**

[Agent completion delivery](/Users/dylan/lattice/src/main/runtime/runManager.ts:1093) marks a result delivered and removes its tracking entry before the asynchronous `send()` succeeds. Rejections are swallowed. [Background jobs](/Users/dylan/lattice/src/main/runtime/runManager.ts:1227) use the same pattern. Existing serialized delivery avoids overlapping inserts, but it does not make failed delivery retryable.

Persist an outbox entry keyed by completion ID; acknowledge it only after durable insertion into the recipient's inbox. Separate storing a result from waking the model. Retry wake failures with bounded backoff and deduplicate on completion ID. Recover pending deliveries on restart. The events may retain source evidence today, but the automatic handoff can still be lost.

Acceptance: simulated insertion/wake failure recovers without a missing result or duplicate message; restart preserves pending completions; user cancellation and thread deletion suppress unwanted wakeups.

**7. Budget and group delegated work. Design recommendation.**

[Background spawns](/Users/dylan/lattice/src/main/runtime/runManager.ts:3250) start immediately, and [default round limits](/Users/dylan/lattice/src/shared/types.ts:1084) are unlimited. Each staggered completion can also trigger another parent model request.

Add configurable provider/global concurrency limits, task token/time budgets, and a queue. Use progress signals—new evidence, changed artifacts, resolved checks—to distinguish productive long work from repeated identical failures. Preserve an explicit user override for long tasks.

Allow a delegation group to specify whether the parent needs the first result, every result, or a quorum. Coalesce nearby arrivals and reconcile a completed group once. Preserve immediate delivery where the first result is actionable; an unconditional wait-for-everything policy would add latency.

Acceptance: excess workers queue, budgets include children, repeated failures trigger a changed strategy or useful blocker, and a group of completed workers does not cause redundant synthesis runs.

**8. Turn completion discipline into an evaluated runtime feature. Design recommendation.**

The [execution contract](/Users/dylan/lattice/src/main/runtime/runManager.ts:4299) already tells agents to define outcomes, verify them, and audit completion. [Stall recovery](/Users/dylan/lattice/src/main/runtime/runManager.ts:2091) catches specific endings, but ordinary text can still [finalize a task turn](/Users/dylan/lattice/src/main/runtime/runManager.ts:2206) without a runtime check of deliverables.

For actionable multi-step tasks, maintain a structured task state with acceptance checks and evidence references. A proposed finish should reconcile unresolved checks and required worker groups. Use deterministic verification where possible—file content, build/test status, external receipt—and a bounded reviewer step where judgment is needed. Keep simple conversation cheap and allow a clear blocked outcome; the controller must not create an endless repair loop or execute unrequested checks.

Build a small fixed evaluation set from Lattice's actual workloads: repository bug fix, file edits, multi-part task, delegated search, large output, compaction, missing tool, MCP failure, cancellation, retry, and background result delivery. Fake-provider tests check runtime invariants. Opt-in model evaluations check whether models actually choose tools and solve tasks; scripted tests alone cannot measure that.

Measure verified task success, unsupported success claims, human corrections, total input/output tokens, cost per verified outcome, time to first useful action, completion latency, duplicate calls, constraint retention, and work lost after interruption. Include child-agent, title, compaction, and memory-distillation calls in cost accounting. The [current usage query](/Users/dylan/lattice/src/main/store/eventStore.ts:430) reads assistant-message telemetry, while child usage is emitted into [agent events](/Users/dylan/lattice/src/main/runtime/runManager.ts:2900).

**9. Remove an avoidable first model round. Small, immediate efficiency win.**

The [system prompt](/Users/dylan/lattice/src/main/runtime/runManager.ts:4324) requires the first tool call in a new task to be `set_thread_title`, alone, before useful work. A model following that instruction necessarily spends a round naming the task. Lattice already has [asynchronous automatic titling](/Users/dylan/lattice/src/main/runtime/runManager.ts:2215).

Remove the mandatory isolated naming round. Allow naming alongside independent work or rely on a cheap initial UI title and the existing background title path. Also replace the prompt's claim that marginal completeness costs are near zero with instructions consistent with task budgets. Validate prompt edits on the task evaluation set rather than assuming a shorter prompt is automatically better.

**10. Make this repository easier for coding agents to navigate and verify. Confirmed workflow gaps.**

There is no checked-in repository `AGENTS.md`. Add a short operating guide with the source map, authoritative status document, generated/native files, required commands, and which tests require live services. Correct the [README's unfinished-feature list](/Users/dylan/lattice/README.md:30), which still lists implemented subagents, compaction, and MCP management as missing.

The [root test configuration](/Users/dylan/lattice/vitest.config.ts:14) only includes `src/`. `pnpm -r test` reaches the packages but fails because computer-use-core has no matching tests. The MCP default test command also has no matching tests; its e2e suite is separately configured. Add real coverage or explicitly define package readiness, and make one aggregate verification command accurately cover the supported product. No committed CI workflow was present in the reviewed tree. Pin the supported package manager and document native-module setup so agents can reproduce checks.

The [4,762-line run manager](/Users/dylan/lattice/src/main/runtime/runManager.ts:1) contains duplicated parent/worker execution paths, making parity bugs such as missing worker context fitting easier to introduce. After characterization tests, extract shared request/round policy, tool dispatch, context fitting, and delivery components incrementally. Do not start with a wholesale rewrite.

**Lower-priority opportunities**

Memory recall currently [loads and ranks rows in JavaScript](/Users/dylan/lattice/src/main/tools/builtin.ts:1880), while an FTS table exists in the database. Profile before optimizing a small store; at scale, use scoped indexed retrieval and evidence/status-aware ranking. Model health currently tests a [small text reply](/Users/dylan/lattice/src/main/providers/health.ts:129), so future role-based routing should use tool-use and task evaluation results too, while respecting the user's approved model choices. Token counting already has a [bounded cache](/Users/dylan/lattice/src/main/runtime/tokenizer.ts:31); repeated full tokenization is not an established bottleneck.

**Verification performed**

- `pnpm typecheck`: passed.
- `pnpm exec vitest run --exclude src/main/net/server.test.ts`: 1,168 tests passed and 7 stayed skipped across 88 files.
- `pnpm test`: the 8 local bridge tests remain blocked in this sandbox because the temporary server cannot bind loopback and SQLite reports `unable to open database file`; the runtime tests themselves pass in the excluded sweep above.
- `pnpm test:packages`: the protocol package passed all 9 tests. The computer-use core still lacks its controller entrypoint/tests, and the MCP package has only its separately configured e2e suite, so those package defaults remain incomplete.
- Three disposable-file audit probes confirmed missing-content writes, literal replacement corruption, and concurrent lost updates. These assert current problematic behavior; they are audit evidence, not fixes or a permanent regression suite.
- Two additional fake-provider audit probes passed: tool-result evidence in a compacted text-bearing assistant message is absent from both the summarizer input and the next wire; tool-only messages remain uncompacted and replayable. This directly tested manual compaction, not the automatic send path. The existing four auto-compaction tests also passed in a focused rerun.
- The review did not run real-model evaluations or use the live application database. Root test success does not establish workspace-package readiness or real-model task success.

I would begin with tool contracts and scheduling, worker execution boundaries, and evidence-preserving context handling. Build the evaluation baseline alongside those fixes, then use it to tune prompts, model selection, and delegation policies.

## First implementation pass

- Added schema-aware argument validation before approvals or execution, literal-safe and atomic `fs_write`/`fs_edit`, optional edit hashes, clearer `grep_search` statuses, and MCP request cancellation/timeouts.
- Added a process-wide resource scheduler for conflicting filesystem, shell, and MCP calls. Independent reads can still overlap; conflicting writes and dependent reads are ordered.
- Enforced subagent tool allowlists at dispatch, keyed persistent shells by thread plus agent identity, cleaned worker shells on exit, and applied context fitting to worker requests.
- Added evidence-preserving compaction input with deterministic checkpoint references, durable `read_tool_result`/`search_tool_results` tools, and call IDs in stale-result placeholders.
- Made background agent and shell completion delivery claim results only after `send()` accepts them, with bounded retry backoff and pending-result preservation after transient persistence failures.
- Added repository `AGENTS.md`, an offline evaluation rubric, and pinned `pnpm@11.22.0` metadata. The computer-use packages still need their own controller implementation and tests; their current default package test commands remain incomplete.

Focused runtime validation passed after these changes: 198 tests across the store, built-in tools, and run manager, plus the scheduler, validation, outcome, MCP, checkpoint, replay, delivery, and compaction suites. Full root validation still requires the loopback bridge test command to run with networking enabled in the sandbox.
