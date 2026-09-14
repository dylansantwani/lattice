**Lattice memory system review — September 8, 2026**

Reviewed the memory subsystem in the current working tree (`src/main/memory/bridge.ts`, `src/main/runtime/selfLearn.ts`, the memory paths of `src/main/runtime/runManager.ts` and `src/main/tools/builtin.ts`, `src/main/store/eventStore.ts`, `src/main/store/db.ts`, and the Memory tab in `src/renderer/src/components/Inspector.tsx`). Findings below are backed by the live store at `~/Library/Application Support/Lattice/data/lattice.db`, read read-only.

**Live store snapshot (the evidence base)**

| Measure | Value |
| --- | --- |
| Memory rows | 236 (212 approved, 24 proposed, 0 rejected) |
| Authorship | 179 model-distilled, 57 imported, 0 hand-written |
| Content volume | 189,418 chars; largest item 8,014 chars; 36 items over 1,000 chars |
| Pinned items | 0 |
| Rows with `last_used_at` | 0 |
| Rows with `expires_at` | 0 |
| `memory_fts` index entries | 0 (any `MATCH` returns nothing) |
| Near-duplicate pairs (Jaccard ≥ 0.5 on content tokens) | 35 |
| Top-level completed runs in the event log | 120 |
| Peak growth | 108 memories created on 2026-09-04 |

Two numbers frame everything else: the store injects **nothing** into the prompt today (0 pinned), and it has grown to 236 items in four days with **no** reinforcement signal, no expiry, and no reliable dedupe.

**Recommended sequence**

| Order | Work | Main benefit | Scope |
| --- | --- | --- | --- |
| 1 | Fix write-side dedupe: supersede instead of insert, similarity instead of containment | Stops the store rotting; removes the 35 duplicate pairs at the source | Bounded work in `selfLearn.ts` + `eventStore.ts` |
| 2 | Make retrieval real: populate/query FTS5 with BM25, filter by scope, cap result bytes | Correct, bounded, relevant recall; kills the blob-dominance failure | Bounded work in `db.ts` + `builtin.ts` |
| 3 | Cut distillation cost: incremental transcript, utility model, gate on signal, count the tokens | ~400k invisible input tokens per 120 runs recovered and made visible | Moderate work in `selfLearn.ts` |
| 4 | Track usage and decay: write `last_used_at`, set `expires_at`, sweep | Ranking that improves with use; bounded growth | Small store work |
| 5 | Fix the bridge write path: hash-and-skip, debounce, move off the main thread | Removes synchronous disk churn on every memory write | Bounded work in `bridge.ts` + `ipc.ts` |
| 6 | Curation UI: pin, edit, merge, filter, bulk review | The pinned lane becomes usable; the review queue gets used | Moderate renderer work |
| 7 | Give subagents memory | Delegated work stops ignoring the user's preferences | Small runtime change |

---

**1. The FTS5 index is dead weight. Confirmed against the live database.**

[`db.ts:115`](/Users/dylan/lattice/src/main/store/db.ts:115) creates `memory_fts` as an external-content FTS5 table over `memory`, but there are no `INSERT`/`UPDATE`/`DELETE` triggers and no query anywhere in the codebase references it. Against the live store, `SELECT count(*) FROM memory_fts WHERE memory_fts MATCH 'the'` returns 0 across 236 rows; `memory_fts_data` holds 2 rows (an empty index). The table has never been populated and has never been read.

Meanwhile [`rankMemorySearch`](/Users/dylan/lattice/src/main/tools/builtin.ts:128) does the search in JavaScript: load all rows, lowercase each content string, and count how many distinct query tokens appear as substrings. No stemming, no phrase handling, no length normalization, and one full-table load per call.

Add the three sync triggers, and back `memory_search` with `memory_fts MATCH` ranked by `bm25()`. That gets porter stemming, prefix queries, and length-normalized scoring for free, and it turns the search into an index lookup instead of a full scan plus 189 KB of string lowercasing. Keep the JS ranker as the fallback for the FTS-unavailable path and for the test seam that already covers it.

Acceptance: a fresh install and an existing store both return FTS hits after migration; a multi-word query returns the same or better items than the JS ranker; `memory_fts` row count tracks `memory`.

**2. Long imported blobs dominate every search and silently swallow new learnings. Confirmed by source and store contents.**

[`bridge.ts:17`](/Users/dylan/lattice/src/main/memory/bridge.ts:17) clips imported items at 8,000 chars, and [`collectClaudeCode`](/Users/dylan/lattice/src/main/memory/bridge.ts:105) imports the entire global `~/.claude/CLAUDE.md` as one memory item. The live store holds 36 items over 1,000 chars, with a maximum of 8,014.

Two failures follow:

- **Search.** `rankMemorySearch` scores by how many query tokens appear anywhere in the content, with no length penalty. An 8,000-char blob contains nearly every common token, so it scores maximum on almost any query and crowds out the precise one-sentence memory that actually answers it. `memory_search` then returns up to 20 items with **full, untruncated content** ([`builtin.ts:1923`](/Users/dylan/lattice/src/main/tools/builtin.ts:1923)) — a worst case of ~160 KB (roughly 40k tokens) injected into the context from a single tool call, which is larger than most models' useful working set and defeats the whole point of on-demand recall.
- **Learning.** [`dedupeLearnings`](/Users/dylan/lattice/src/main/runtime/selfLearn.ts:150) treats a draft as already-known when the normalized text of one string contains the other, with only an 8-character floor on the contained side. Any short new learning whose normalized form happens to appear anywhere inside a multi-thousand-character imported blob is silently discarded as a duplicate.

Fix in three parts: chunk imported files into paragraph-sized items with a stable per-chunk id rather than one clipped blob; cap `memory_search` output by total bytes (and per item, with a snippet plus `id` the model can expand via a follow-up read) rather than by item count; and exclude oversized items from the containment side of the dedupe check.

Acceptance: a query matching a short memory ranks it above a blob containing the same words; a 20-hit search returns a bounded payload; a new short learning is not dropped because its words appear inside an imported instructions file.

**3. Dedupe by containment does not catch rewording, and nothing ever supersedes. Confirmed in the live store.**

The store contains 35 near-duplicate pairs at Jaccard ≥ 0.5. The clearest case is one trivial fact stored five separate times:

```
User's local username/home is dylan at /Users/dylan
User's macOS username is dylan (home directory /Users/dylan).
User's username on macOS is dylan (home directory /Users/dylan)
User's macOS username is 'dylan' (home at /Users/dylan)
User's macOS home directory is /Users/dylan
```

None contains another, so [`similar()`](/Users/dylan/lattice/src/main/runtime/selfLearn.ts:152) never fires. The same pattern repeats across the printer, repo, and browser-automation facts, aggravated by the distiller alternating between "User…" and "Dylan…" as the subject — a phrasing difference that alone defeats containment matching.

Underneath that, `upsertMemory` has no path to *revise* a fact: a draft with no `id` always becomes a new row ([`eventStore.ts:1045`](/Users/dylan/lattice/src/main/store/eventStore.ts:1045)), and `distillMemories` never passes one ([`selfLearn.ts:269`](/Users/dylan/lattice/src/main/runtime/selfLearn.ts:269)). So a corrected or refined preference does not replace the old one — it sits beside it, both `approved`, both searchable, contradicting each other with no recency signal to break the tie (see finding 5).

Three changes:

- Replace containment with token-set similarity (Jaccard over content tokens, roughly ≥ 0.6, with the existing containment rule kept as a fast path). This is cheap, testable, and would have collapsed all five username rows into one.
- When a draft is near-duplicate of an existing item and carries strictly more information, `upsertMemory` with the **existing id** so the row is revised in place (the `version` column already exists and increments for exactly this).
- Normalize the subject in the distillation prompt ("write every memory about the user in third person as 'The user …'"), so wording variance stops manufacturing duplicates.

Acceptance: seeding the five username variants yields one stored row; a refinement of an existing memory bumps `version` rather than adding a row; a genuinely distinct fact sharing common words is not collapsed.

**4. Distillation costs a full model call per run, on the expensive model, uncounted. Confirmed by source.**

[`runManager.ts:2273`](/Users/dylan/lattice/src/main/runtime/runManager.ts:2273) calls `distillMemories` after every completed top-level run. Each call sends up to 12,000 chars of transcript plus a ~450-token instruction ([`selfLearn.ts:24`](/Users/dylan/lattice/src/main/runtime/selfLearn.ts:25), [`selfLearn.ts:47`](/Users/dylan/lattice/src/main/runtime/selfLearn.ts:47)) to the **thread's own model** with `cache: false`. Four problems compound:

- **It re-reads the whole tail every turn.** `buildTranscript` takes the full message list and trims from the front, so turn 12 re-sends most of what turns 8 through 11 already distilled. There is no watermark of "last distilled message id".
- **It runs on the main model.** Settings has `subagentModels` but no notion of a cheap utility model; titling has the same problem. On an Opus-class thread this is the most expensive possible way to answer a question whose correct answer, by the prompt's own admission, is usually `[]`.
- **The tokens are invisible.** The stream's usage chunks are discarded — only `chunk.type === 'text'` is read ([`selfLearn.ts:254`](/Users/dylan/lattice/src/main/runtime/selfLearn.ts:254)) — so none of this appears in run telemetry, the Context Orbit, or usage totals. Across the 120 top-level runs in this store that is on the order of 400k input tokens spent and never reported.
- **It runs unconditionally.** A one-word confirmation turn ("yes", "thanks") clears the 40-char floor and pays the full call.

Fix: track a per-thread distillation watermark and send only messages after it; add a `utilityModel` setting (falling back to the thread model) and route distillation, titling, and any future reflection passes through it; emit the pass's usage as a tagged `usage` event so the cost is visible; and gate on cheap signal — skip when the new-since-watermark span is under a few hundred chars or contains no first-person user statement.

Acceptance: a 20-turn thread issues distillation input proportional to new content, not to 20× the tail; the Run inspector shows distillation tokens; a "thanks" turn distills nothing without a model call.

**5. Memory usage is never recorded, so ranking cannot improve and nothing can decay. Confirmed in the live store.**

`last_used_at` is read in two rankers ([`runManager.ts:4060`](/Users/dylan/lattice/src/main/runtime/runManager.ts:4060), [`builtin.ts:134`](/Users/dylan/lattice/src/main/tools/builtin.ts:134)) but written by nothing — `upsertMemory` only carries the existing value forward ([`eventStore.ts:1062`](/Users/dylan/lattice/src/main/store/eventStore.ts:1062)). All 236 rows have it `NULL`. Both "most recently used" orderings silently degrade to `updated_at`, which for an untouched memory is its creation time.

Likewise, `expires_at` is filtered on read in two places but set by no writer: 0 rows have it. Nothing sweeps `rejected` or expired rows, and the only deletion path is a manual per-item `DELETE` ([`eventStore.ts:1088`](/Users/dylan/lattice/src/main/store/eventStore.ts:1088)). The store therefore grows monotonically — 108 rows on its peak day — and holds facts that were transient the moment they were written, e.g. `User's print history shows ~84% success rate across ~44 recent cloud print jobs`.

Fix: stamp `last_used_at` on every id returned by `memory_search` (a single batched `UPDATE … WHERE id IN (…)`; it does not touch `updated_at`, so the pinned block's byte-stability and the prompt cache are unaffected). Let the distiller propose a TTL for observation-shaped types (`note`, and any content the prompt classifies as a current-state observation) and default `warning`/`note` to a finite horizon. Add a startup sweep that flips expired rows to `expired` and hard-deletes `rejected` rows older than a threshold. With usage recorded, add a low-value sweep: model-authored, never-used, unpinned, older than N days.

Acceptance: a `memory_search` hit updates `last_used_at` and not `updated_at`; an expired row leaves the prompt and search automatically; the sweep is idempotent and never touches pinned or user-authored items.

**6. `memory_search` ignores scope entirely. Confirmed by source.**

[`builtin.ts:1918`](/Users/dylan/lattice/src/main/tools/builtin.ts:1918) filters only on `status` and expiry. `buildWireMessages` does the scope filtering correctly for the injected block ([`runManager.ts:4271`](/Users/dylan/lattice/src/main/runtime/runManager.ts:4271)) — user-scope everywhere, workspace-scope matched on `workspaceId`, thread-scope matched on `threadId` — but the tool that actually serves recall applies none of it. A thread-scoped memory from an unrelated conversation, or a workspace-scoped memory from a different project, is returned to any caller.

This is latent rather than active today (the store has one workspace, 128 workspace-scoped items, and 0 thread-scoped ones), but it becomes a real cross-project leak the moment a second workspace exists, and the tool already has `ctx.threadMeta` in hand. Reuse the exact predicate from `buildWireMessages` — factor it into one shared `isInScope(m, threadId, workspaceId)` so the two paths cannot drift.

Acceptance: a thread-scoped memory is invisible to a search from another thread; a workspace-scoped memory is invisible from another workspace; one predicate, tested once, used by both call sites.

**7. The prompt lane loads the entire store to render nothing. Confirmed by source and store state.**

[`runManager.ts:4271`](/Users/dylan/lattice/src/main/runtime/runManager.ts:4271) calls `listMemory()` — a `SELECT *` with no `WHERE`, no index, and a full object mapping of all 236 rows and 189 KB of content — and hands the result to `memoryPromptSection`, which uses **only** the pinned subset ([`runManager.ts:4039`](/Users/dylan/lattice/src/main/runtime/runManager.ts:4039)). With 0 pinned rows, every turn parses the whole store to emit a static instruction paragraph.

`memory` has no indexes at all ([`db.ts:97`](/Users/dylan/lattice/src/main/store/db.ts:97)): no index on `pinned`, `status`, `scope`, or `updated_at`, despite every read path filtering on some combination of them.

Add `listPinnedMemory(threadId, workspaceId)` backed by `WHERE pinned = 1 AND status = 'approved'` with an index on `(pinned, status)` plus one on `(scope, scope_id)`, and use it in `buildWireMessages`. Keep `listMemory()` for the Memory tab and the bridge.

Acceptance: a turn with no pinned memories issues one indexed query returning zero rows; the emitted system prompt is byte-identical to today's.

**8. `memory_save` is weaker than the self-learning path it parallels. Confirmed by source.**

[`builtin.ts:1484`](/Users/dylan/lattice/src/main/tools/builtin.ts:1484) writes straight through to `upsertMemory` with no dedupe against the existing store, no `looksSensitive` check, no confidence, and a hard-coded `proposed` status. The self-learning path does all four. So the model can save the same fact on ten consecutive turns and get ten rows, and a credential-shaped string reaches the store without the guard that `statusFor` applies to distilled items.

Route `memory_save` through the same helpers: dedupe/supersede against existing items (returning `{status:'duplicate', id}` so the model learns it already knew that), run `looksSensitive`, and return the resolved status. Hard-coding `proposed` is defensible as a review gate, but it should be the same gate the distiller uses, not a separate weaker path.

Acceptance: saving the same content twice returns the first id and creates no second row; a credential-shaped save is refused or flagged; the tool result tells the model what actually happened.

**9. Auto-approved model output is written into two other agents' stores without review. Confirmed by source and store state.**

`selfLearningAutoApprove` defaults to `true` ([`types.ts:1065`](/Users/dylan/lattice/src/shared/types.ts:1065)), and [`statusFor`](/Users/dylan/lattice/src/main/runtime/selfLearn.ts:194) approves anything the model self-reports at ≥ 0.75 confidence. Approved items are exported on the next sync into `~/.claude/projects/<slug>/memory/lattice-*.md` and Hermes' `MEMORY.md` ([`bridge.ts:387`](/Users/dylan/lattice/src/main/memory/bridge.ts:387)). Model-reported confidence is not calibrated, and the review queue confirms nobody is checking: 212 approved, 24 proposed, **0 rejected** — the Memory tab's approve/reject buttons have never been used in anger.

That is why task-shaped junk like `When Google Slides is opened, it starts with a default title slide placeholder that should be renamed` is now a durable, exported, cross-agent fact.

Two mitigations, neither of which requires turning auto-approve off: hold export back one step — auto-approve for Lattice's own prompt, but require an explicit approve (or an age threshold with no rejection) before an item is written into another agent's store; and make the review queue visible, e.g. a count badge on the Memory tab, so 24 unreviewed proposals are not invisible.

Acceptance: a freshly distilled item is usable in Lattice immediately but does not appear in `~/.claude` until it clears the gate; the unreviewed count is visible without opening the tab.

**10. The bridge write path runs synchronous filesystem work on the main process, on every memory write. Confirmed by source.**

[`runMemorySync`](/Users/dylan/lattice/src/main/memory/bridge.ts:387) is fully synchronous (`readFileSync`/`writeFileSync`/`readdirSync`/`unlinkSync`) and does a complete round trip: re-read every Claude Code and Hermes memory file, upsert/prune imports, then **delete every `lattice-*.md` and rewrite them all** plus both index files. It is called from `upsertMemory` and `deleteMemory` in IPC ([`ipc.ts:400`](/Users/dylan/lattice/src/main/ipc.ts:400), [`ipc.ts:407`](/Users/dylan/lattice/src/main/ipc.ts:407)) — so every approve, reject, or edit click blocks the Electron main process — and again from `distillMemories` after any run that stored something ([`selfLearn.ts:286`](/Users/dylan/lattice/src/main/runtime/selfLearn.ts:286)). Approving five proposals in a row is five full rewrites of ~200 files' worth of work. There is no dirty check: the export runs identically whether or not the exportable set changed.

Note that the *import* lane on the turn boundary is already throttled to a 20s TTL per workspace (documented in `STATUS.md`); the write-back lane got no equivalent treatment.

Fix: hash the exportable set (ids + content) and skip the export entirely when the hash is unchanged; write only files whose content differs instead of delete-all-then-rewrite (which also closes the window where a crash mid-sync leaves the external store empty); debounce IPC-triggered syncs by a second or two so a burst of approvals collapses into one; and move the whole thing to async fs off the main thread.

Acceptance: approving five items triggers one export; a no-op sync touches zero files; the UI does not block during a sync.

**11. Subagents have no memory context. Confirmed by source.**

The subagent system prompt is `SUBAGENT_PROMPT` plus the role line and the model identity ([`runManager.ts:2607`](/Users/dylan/lattice/src/main/runtime/runManager.ts:2607)) — no `# Memory` section, no recall note, no pinned items. `memory_search` is not in `NEVER_DELEGATABLE`, so a subagent *has* the tool but is never told it exists as a source of user context, and cannot see pinned memories at all.

The result is that delegated work — which is exactly the work that runs unsupervised and produces artifacts — ignores the user's standing preferences. Add the recall note and the pinned block to the subagent prompt (it is byte-stable, so it costs nothing in cache terms), scoped to the parent thread's workspace.

Acceptance: a subagent asked a preference-dependent question can reach the same memories the parent can.

**12. The Memory tab cannot do the curation the system depends on. Confirmed by source and store state.**

[`MemoryTab`](/Users/dylan/lattice/src/renderer/src/components/Inspector.tsx:447) renders every row in one unvirtualized list, ordered by `updated_at`, with three actions: approve, reject, delete. There is no search, no filter by status or scope or author, no edit, no merge, and — most consequentially — **no way to pin**. `pinned` is the only field that puts a memory into the prompt, and it is reachable only by calling `upsertMemory` over IPC by hand. That is why the live store has 0 pinned rows and the `# Memory` section is, in practice, an instruction paragraph with nothing behind it.

At 236 rows the list is already unwieldy; at the observed growth rate it is unusable within weeks. Add: a pin toggle, inline content editing, a filter bar (status / scope / author / origin), a search box over the same ranker the tool uses, bulk approve/reject/delete, a "merge into" action for the near-duplicate pairs finding 3 will surface, and virtualization.

Acceptance: a memory can be pinned from the UI and appears in the next turn's system prompt; the tab stays responsive at 1,000+ rows; duplicates can be merged in two clicks.

---

**Cheapest high-value subset**

If only a few things land, land these four: token-set dedupe with in-place supersede (finding 3), FTS5-backed search with scope filtering and a byte cap on results (findings 1, 2, 6), the incremental/utility-model/metered distillation pass (finding 4), and a pin toggle in the Memory tab (finding 12). Together they stop the store from rotting, make recall correct and bounded, remove the largest silent cost in the system, and make the injection lane usable at all.


---

**Implementation log — September 8, 2026**

Every finding above is implemented and covered by focused tests (`pnpm typecheck` and `pnpm test` green: 99 files, 1326 tests). What landed, by finding:

| # | Finding | Where | Test |
| --- | --- | --- | --- |
| 1 | FTS5 index populated (porter-stemmed), sync triggers, one-time rebuild on upgrade; `memory_search` ranks by BM25; JS ranker kept as fallback | `db.ts` `migrateMemoryFts`, `eventStore.ts` `searchMemoryFts`, `builtin.ts` `recallMemories` | `dbMemoryFts.test.ts` (old-schema upgrade), `eventStore.test.ts`, `builtin.test.ts` |
| 2 | Imports chunked into paragraph-sized hash-keyed items; search payload byte-capped (12 hits, 400-char snippets, 6000 chars) with `memory_search {id}` to expand; containment dedupe refuses documents | `bridge.ts` `chunkMarkdown`/`documentDrafts`, `builtin.ts` `packMemoryHits`, `similarity.ts` `containsAsRewording` | `bridge.test.ts`, `builtin.test.ts`, `similarity.test.ts` |
| 3 | Jaccard ≥ 0.6 dedupe with containment fast path; in-place supersede when a draft carries more information; distiller sees related known memories and may `replaces`; third-person subject in the prompt | `similarity.ts`, `selfLearn.ts` `planLearnings`/`storeLearning`/`relatedKnownMemories` | `similarity.test.ts` (the five username rows collapse), `selfLearn.test.ts` |
| 4 | Per-thread distillation watermark; `utilityModel` setting routes distillation + titling; usage emitted as tagged `usage` events and shown in the Run inspector; gated on ≥200 new chars with a human-typed turn | `selfLearn.ts` `messagesSinceMark`/`hasLearnSignal`, `utilityModel.ts`, `runManager.ts` `housekeepingRoute`, `usageStats.ts`, `Settings.tsx` | `selfLearn.test.ts` (store-backed e2e), `runManager.test.ts`, `usageStats.test.ts` |
| 5 | `last_used_at` + `use_count` stamped per recall hit (batched, no `updated_at` churn); `ttlDays` from the model with type defaults; launch/on-demand sweep (expire, retire, purge) that never touches pinned or user rows | `eventStore.ts` `touchMemoryUsed`/`sweepMemory`, `selfLearn.ts` `expiryFor` | `eventStore.test.ts`, `builtin.test.ts` |
| 6 | One shared scope predicate for the prompt lane and recall | `memory/scope.ts` | `scope.test.ts`, `builtin.test.ts`, `runManager.test.ts` |
| 7 | Prompt lane reads only pinned rows via an indexed query; indexes on `(pinned,status)`, `(scope,scope_id)`, `(status,updated_at)`; emitted section byte-identical | `eventStore.ts` `listPinnedMemory`, `runManager.ts` `pinnedMemoriesFor` | `runManager.test.ts`, `eventStore.test.ts` |
| 8 | `memory_save` through the same gate: duplicate → existing id, refinement → in-place, `replaces`, sensitivity check, confidence-gated status, honest result | `builtin.ts` | `builtin.test.ts` |
| 9 | Export gate: reviewed (`reviewed_at` stamped by any human upsert/bulk action), pinned, user-authored, or aged 3 days; proposed-count badge on the Memory tab | `bridge.ts` `isExportable`, `ipc.ts`, `Inspector.tsx` | `bridge.test.ts` |
| 10 | Import fingerprint skip; export hash skip; diff-only async writes; 1.5 s debounce; flush at quit | `bridge.ts` `importFingerprint`/`exportMemory`/`scheduleMemoryExport`, `index.ts` | `bridge.test.ts` |
| 11 | Subagents get the pinned block (and the recall note when they hold `memory_search`) | `runManager.ts` | `runManager.test.ts` |
| 12 | Memory tab: pin, edit, search, filters, bulk actions, duplicate merge (single + confident clusters), sweep, badges, `content-visibility` virtualization | `MemoryTab.tsx`, `global.css` | `memoryTab.test.ts` |

Quality-gain hardening (second pass, same day): recall returns Lattice-authored memories whole (700-char snippet ceiling, 8000-char budget, verbatim text) and prefix-matches longer tokens; a one-word correction of a known fact revises the row instead of being dropped as a duplicate (only strict subsets drop); an explicit "remember…"/"from now on…" cue is distillation signal at any length; the watermark advances only on a well-formed reply; retirement of never-used memories is soft-only (never purged); and a memory that recall has surfaced once exports to the other agents immediately (else after 24 hours).

Also fixed in passing: `mergeMemory` (new) folds usage/pin/review signals into the survivor; `deleteThread` clears the thread's watermark; a pending export is flushed on quit; the `# Memory` section is omitted entirely for a recall-less subagent with nothing pinned.

Verified against a copy of the live store: the upgrade rebuilds the index for all rows, the username query returns the one-line facts ahead of the imported instructions chunks, and the duplicate finder surfaces the review's clusters for one-click merge in the tab.

---

**Efficiency pass — September 11, 2026**

Measured against the live store three days after the implementation above (1,173 rows; 226 completed runs and 358 new captures on the day of measurement; 184 rows ever recalled; 0 ever reviewed).

| Measure | Before | After |
| --- | --- | --- |
| Lattice files in `~/.claude/projects/-Users-dylan/memory` | 525 (index 102 KB) | ≤ 80, evidence-ranked |
| Lattice entries in `~/.hermes/memories/MEMORY.md` | 525 (116 KB) | ≤ 80 |
| Export dedupe CPU per export (main thread) | 1,089 ms at 540 rows, before the skip check | ~0 when unchanged (input-hash memo); tokens memoized per string |
| Rule captures from the user's own turns | decisions/warnings/env facts captured from anything anyone said | standing instructions from the user only; findings from the assistant only; fragments dropped |
| Never-recalled model captures retire after | 90 days | 30 days (soft) |
| Recall injection log | synchronous `mkdirSync` + `appendFileSync` per turn | async, fire-and-forget |

Unchanged because they measured fine: per-run `planLearnings` against the full store (17 ms), the Memory tab's duplicate finder (123 ms at 1,090 rows), rule extraction itself (2 ms on an 11 KB transcript), the per-turn pinned read (indexed), and FTS recall.

Files: `src/main/memory/bridge.ts` (`isExportable`, `exportPriority`, `EXPORT_MAX_ITEMS`, `exportableMemories`, `tokensOf`), `src/main/runtime/selfLearnRules.ts` (`isFragment`, speaker gate), `src/main/store/eventStore.ts` (`MEMORY_SWEEP.lowValueAgeMs`), `src/main/runtime/runManager.ts` (`logInjection`). Tests: `bridge.test.ts`, `selfLearnRules.test.ts`.

