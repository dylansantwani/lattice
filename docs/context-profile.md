# Context profile — lean requests for local models

Lattice's request prefix was tuned for hosted frontier models: every tool, a prose inventory of those
tools, and a long base prompt. On a local model that prefix costs prefill seconds on every cache miss,
and it crowds a smaller model's attention. The `contextProfile` setting (Settings → Conversation →
Context profile) trims it. `auto`, the default, uses the lean profile for models running on your own
machines and the full profile for hosted ones.

## Measured on the PC 5080 (2026-09-12)

Model: Qwen3.6-35B-A3B UD-Q4_K_XL, llama.cpp b10868, 131k context, one slot (the config the tuning
session installed that evening). Token counts come from the server's own chat template and tokenizer
(`/apply-template` + `/tokenize`). They reproduce the server-reported `prompt_tokens` exactly.

### Where a one-word reply's 14,078 prompt tokens went

| Segment | Tokens |
| --- | --- |
| Tool schemas (33 tools) | 9,208 |
| System prompt | 4,604 |
| · base prompt (execution contract, autonomy, titling, steering…) | ~1,900 |
| · prose tool inventory (a second copy of every tool's description) | ~1,800 |
| · workspace primer, subagent models, memory note | ~900 |
| User turn (auto-recalled memory + "Reply with exactly: pong") | ~266 |

### What each lean reduction saves (same request)

| Reduction | Prompt tokens | Saved |
| --- | --- | --- |
| none (full profile) | 14,078 | — |
| `tools`: drop subagent, cross-session, image (text-only model) and title tools | 11,057 | 3,021 (21.5%) |
| `schema`: descriptions → leading sentences, parameter docs ≤ 140 chars | 11,088 | 2,990 (21.2%) |
| `inventory`: one-line tool assurance instead of the prose list | 12,277 | 1,801 (12.8%) |
| `prompt`: condensed base prompt with the same rules | 12,159 | 1,919 (13.6%) |
| **all four (lean)** | **5,326** | **8,752 (62.2%)** |

### Cold prefill

A cold full prefix took 5.64 s before the first token; a cold lean prefix took 2.47 s.

### Cache behavior on this server

The suspected problem was that titling requests between turns would evict the single slot's cached
conversation. It is not a problem on this build: llama.cpp keeps recent prompts in a host-RAM prompt
cache.

| Step | Prompt | Prefilled | From cache | Prefill |
| --- | --- | --- | --- | --- |
| turn 1, cold | 14,089 | 14,089 | 0 | 5,644 ms |
| turn 2, nothing in between | 14,110 | 18 | 14,092 | 134 ms |
| a standalone title request | 68 | 68 | 0 | 302 ms |
| turn 2 after that title request | 14,110 | 4 | 14,106 | 62 ms |

So only changes inside the prefix cost prefill between turns, not interleaved housekeeping. In real
multi-turn benchmark threads, later turns re-prefilled 117–194 tokens.

### Agent tasks, full vs lean (3 repetitions × 8 tasks each)

The tasks ran real turns through Lattice's runtime against the 5080, in a fresh copy of a small Node
project per run, each checked automatically:

- a no-tool question
- an exact one-word reply
- finding the server port
- listing which files import a function
- fixing a failing test and running the suite
- fetching a web page
- writing a notes file covering every source file
- a 3-turn conversation that ends with a `package.json` edit

| | Full (before) | Lean (after) |
| --- | --- | --- |
| Tasks passed | 24 / 24 | 24 / 24 |
| First request, prompt tokens (mean) | 13,426 | 5,001 |
| Largest request in a task (mean) | 14,051 | 5,642 |
| Prompt tokens sent per task (mean) | 37,016 | 16,838 |
| Wall time per task (mean / median) | 22.9 s / 19.7 s | 13.4 s / 11.1 s |
| All 24 tasks, end to end | 9.2 min | 5.4 min |
| Titling output tokens, all runs | 20,572 | 1,611 |

(Averages are over the 24-run pass that shipped the first lean version; the follow-up below fixes its
one defect.)

The biggest time sink was not the prefix; it was titling. With the full profile the model spent more
output tokens reasoning about thread titles (20,572) than answering the tasks (6,615). A standalone title
prompt ("here is a digest, write a title") makes Qwen deliberate for ~1,000 tokens per call. The same
question asked as a continuation of the conversation — the lean `housekeeping` part — is answered in
~50. Ablation on the 3-turn task:

| | Titling output tokens (3 calls) | Wall time |
| --- | --- | --- |
| lean with housekeeping continuation | 136–266 | 27.5 s |
| lean, standalone title prompts | 2,870–3,193 | 56.7 s |

Schema compaction alone passed 8/8. The lean runs showed one defect: on the port question the model called
`read_tool_result` with invented ids (2–5 wasted calls per run, all three repetitions) before reading
the file. That tool's description did not say it only works on pruned-result ids; it now does, and a miss
returns a hint pointing at `fs_read` (see follow-up below).

### Follow-up fixes, verified on the same server

1. **Result tools.** `read_tool_result` now says it only takes ids from pruned-result placeholders, and a
   miss returns a hint pointing at `fs_read`. Over 10 lean runs, invented-id calls went 11 → 1 (it
   recovered in one step), and the port question went from 5.0 rounds to 2.3.
2. **Titling runs with reasoning off on lean threads.** Measured directly against the server with a
   standalone title prompt:

   | `reasoning_effort` | Output tokens | Generation |
   | --- | --- | --- |
   | `high` (the thread's effort, used before) | 797–1,190 | 8.3–12.6 s |
   | omitted (server default) | 1,184–1,961 | 12.3–20.1 s |
   | `none` | 5–6 | 0.09–0.11 s |

   The titles were as good ("Package Name Version And Dependencies"). With both fixes, 9 of 9 tasks
   passed with no wasted tool calls. The 3-turn conversation's titling fell to 11 output tokens for
   three passes, against 1,235 with the full profile, and its wall time fell to 26.3 s, against 46.7 s.

## Proposals (not implemented)

Ordered by expected value for local models:

1. **Reasoning off for titling everywhere.** The same waste very likely applies to hosted reasoning
   models (the `none` retry/quirk path already handles backends that refuse it). Measure one hosted
   route before flipping the default.
2. **Persist the auto-recall block on the user message.** It is spliced into the in-flight request only.
   On the next turn that message re-renders without it, so every provider's prefix cache misses from
   there. On this server that cost ~120–200 tokens per turn; on providers without a RAM prompt cache it
   re-bills the whole previous turn. The fix needs a column on `messages` and a render in
   `buildWireMessages`.
3. **Recall precision.** Relevance is scored as IDF over the candidate set, so a single memory sharing
   one common word ("probe") clears the floor. Live log: 14 of 17 turns injected ~900 chars, including a
   ProxyRouter note on "reply pong" and a belt-bag note on an arithmetic question. Score against corpus
   document frequency, or require two distinct matched terms unless the term is identifier-like.
4. **Load rarely used tools on demand for lean threads.** `todo_write`, the job tools and the memory
   tools could ride the same deferred-loading path MCP tools use (~1.5k tokens). Needs a quality run,
   because small models skip tools they have to discover.
5. **Prune stale subagent models.** `subagentModels` still lists
   `deepseek/deepseek-v4.1-flash-expires-on-0910`, which is advertised in every full-profile prompt.
6. **Stale local defaults.** `DEFAULT_SETTINGS.modelContextOverrides` pins
   `llamacpp/qwen3.6-35b-a3b` to 65,536. The route is now `llamacpp/qwen36-q4kxl` at 128k, so the
   override silently no longer applies.

## How it works

`src/main/runtime/contextProfile.ts` holds the pure pieces. `runManager.ts` applies them in two places,
so every consumer agrees:

- `availableTools(meta)` filters and compacts the tool set. Requests, the context budget and tool
  execution all read it, so a tool the model was not shown cannot be called by name either.
- `buildWireMessages` swaps the base prompt and the inventory.

A model counts as local when its route prefix or gateway owner is `mac`, `pc5080`, `ollama`,
`llamacpp`, `lmstudio`, `mlx` or `vllm`, or when Settings → Model source overrides files it under one
of those. The last rule works before the provider's model list is cached.

For benchmarks, `LATTICE_CONTEXT_PROFILE=full|lean` forces a profile and `LATTICE_LEAN_PARTS=tools,schema`
enables only some reductions.

## Reproducing

The harness lives outside the repo (session scratchpad `ctxbench/`). It:

- runs `lattice serve` from the working tree on an isolated data dir, with settings and memory rows
  copied read-only from the live app, `LATTICE_NO_MCP=1` and `LATTICE_NO_MEMORY_EXPORT=1`;
- sends each task through an attached `lattice -p` with stdin closed;
- reads per-round usage back from the scratch database;
- checks each result automatically: tests pass after a bug fix, files have the right content, answers
  contain the right facts.
