# Memory and continuity

How an agent in Lattice knows what happened before, and what that costs per turn. Companion to
`docs/memory-system-review.md` (the store, the rules, the bridge); this page is the 2026-09-14 pass
that made continuity across conversations real and stopped memory from breaking the prompt cache.

## Two lanes, two questions

| Lane | Answers | Where it lives | Cost per turn |
| --- | --- | --- | --- |
| **Long-term memory** (facts) | "What do I know?" — preferences, decisions, environment, gotchas, workflows | `memory` table, FTS5; `memory_search` / `memory_save` | ~140 tokens static + pinned rows + ≤1,200 chars recalled |
| **Thread digests** (episodes) | "What was I doing, and where?" — one ~80-word running summary per thread | `thread_digests` table; `recall_threads` | ≤700 chars, only on turns that need it |

Neither lane touches the system prompt. Both ride in the user turn, so the cached prefix is stable.

## Per-turn recall is persisted with the turn

Before this pass the recalled-memory block was computed on every request and prepended to the newest
user message in the wire only — the stored message kept its original text. On the next turn that
message was rebuilt *without* the block, so the provider's cached prefix diverged at the previous
user turn and everything after it (the reply, its tool exchanges) was re-read uncached. A 300-token
saving that could cost tens of thousands.

Now `persistUserMessage` computes the block once (`recallForNewMessage`) and stores it on the message
(`ChatMessage.recallText`, column `messages.recall_text`); `buildWireMessages` prepends it every time.
`''` means "computed, nothing recalled"; a legacy row (`undefined`) is recalled in the wire once, the
old way, until it scrolls out.

## Thread digests

`src/main/runtime/threadDigest.ts`. After a run, if the thread gained ≥400 characters of user/assistant
text since its last digest (and not within 90 s of the last one unless the span is large), the utility
model rewrites the digest from the previous digest plus the new turns: goal, done, decisions, open,
key references, ≤80 words. No provider, or a failure, falls back to a deterministic digest (first ask +
latest answer). Usage is metered as `purpose:'digest'`.

**Recent-work block.** `buildRecentWorkBlock` injects up to three digests of *other* threads in the
workspace into a user turn when: the thread is new (≤2 human turns), the text reaches back
(`CONTINUITY_CUE`: "yesterday", "continue", "what were we doing", "status", …), or a digest shares ≥2
distinctive words with the text. Otherwise silence — a thread deep in its own work is not told about
the others on every turn. Fleet agent threads are included only for an orchestrator.

**`recall_threads` tool.** Searches digests by keyword (or lists the most recent), returning session
ids for `peek_session`. Always kept for fleet workers and on lean (local-model) threads.

## Capture: rules first, then one model call

The per-run pass (`distillMemories`) is rule-based and free. When the rules find nothing in a span of
≥1,500 characters, `modelExtractionFallback` spends one utility-model call — the same prompt the
rolling-context distiller uses, with the "already known" block — throttled to once per thread per
10 minutes. Setting `selfLearningModelExtraction` (default on) turns it off. The transcript the rules
and the model see now includes the shell commands the turn actually ran (`commandsRun`), so the
workflow rule sees real sequences, not only commands quoted in prose.

Auto-compaction of a non-rolling thread now mines the folded span (`distillSpan`) exactly as a rolling
thread's roll does — before, that history was summarized and never learned from.

Fleet agent threads count a delegated task (a message whose origin is another session) as the human's
turn for the learn-signal gate, so delegated work is distilled too; workers always keep `memory_save`.

## The texting thread

The phone assistant's thread is rolling (set by the gateway: `--rolling-trigger` / `--rolling-keep`,
64k/24k by default), so its old turns fold into a running summary and are mined with the texting focus
(people, accounts, commitments). It now also has a digest like any thread, so a desktop chat that asks
"what did I text you about" gets it via the recent-work block or `recall_threads`, and vice versa. In
the sidebar it is no longer a chat row: it is the **Phone assistant** entry above the list.

## Tuning knobs

| Knob | Where | Default |
| --- | --- | --- |
| Recall block size | `MEMORY_RECALL_MAX_ITEMS/CHARS` in runManager.ts | 6 / 1,200 chars |
| Recent-work block | `RECENT_WORK_MAX_ITEMS/CHARS` in threadDigest.ts | 3 / 700 chars |
| Digest cadence | `DIGEST_MIN_NEW_CHARS`, `DIGEST_THROTTLE_MS`, `DIGEST_LARGE_SPAN_CHARS` | 400 / 90 s / 4,000 |
| Model extraction | `MODEL_EXTRACTION_MIN_CHARS`, `MODEL_EXTRACTION_THROTTLE_MS`, `selfLearningModelExtraction` | 1,500 / 10 min / on |
| Utility model | Settings → `utilityModel` | thread's own model |

## Tests

`src/main/runtime/threadDigest.test.ts`, `src/main/tools/historyTools.test.ts`,
`src/main/runtime/toolReplay.test.ts` (persisted recall on the wire), `src/main/runtime/selfLearn.test.ts`.
