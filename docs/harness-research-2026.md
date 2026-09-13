# What other harnesses do that Lattice doesn't

A source-grounded gap analysis of Lattice against the production agent harnesses
(Claude Code, Codex CLI, OpenHands, SWE-agent, Aider, Cursor, Amp, Cline, Devin)
and against the 2025–2026 research literature on harness design.

Date: 2026-09-11. Branch: `fix/empty-provider-round`.
Method: every Lattice claim below was verified by reading this working tree, not
by reading `docs/STATUS.md`. Every external claim carries a citation; claims that
come from a blog rather than a paper or primary doc are marked `[secondary]`.

---

## 0. The short version

Lattice is a strong **context and transport** harness attached to a **weak
environment** harness. The parts that talk to the model are, in several places,
ahead of the open field. The parts that talk to the computer are roughly where
SWE-agent was in mid-2024, and the parts that tell you whether any of it works do
not exist.

Five gaps, in the order they cost you the most:

1. **No evaluation harness.** Lattice has 64k lines of runtime and zero task-level
   measurements. Every design decision in the repo is currently justified by
   anecdote. This is the meta-gap: it is why the other four are hard to prioritize.
2. **No verification loop.** The execution contract *tells* the model to verify.
   Nothing in the harness *makes* it. SWE-agent has gated edits behind a linter
   since 2024; Lattice's `fs_edit` will happily write syntactically broken code.
3. **No isolation.** Lattice executes shell on the host with path containment
   only. 83% of the 70-system corpus has at least process separation; 31% has
   containers. Lattice is in the 17% with none.
4. **No code intelligence.** `grep_search` is the entire retrieval story. Aider has
   had a PageRank repo map since 2023; Cursor reports +12.5% agent accuracy from
   semantic search and +23.5% for the hybrid over grep alone.
5. **No checkpoints, no git.** The word `git` does not appear in `src/main` as an
   integration. Claude Code snapshots file state before every edit and can restore
   code, conversation, or both. Lattice can show you a diff and nothing else.

Where Lattice is genuinely ahead: deferred MCP schema loading, the
prune-then-retrieve tool-result design, four-slot cache anchoring, three-tier
stall recovery, and inter-session messaging. Section 4 makes that case with the
same rigor. Two of those five are things the literature asks for and nobody
shipped.

---

## 1. What Lattice actually is (verified inventory)

**Tool surface — 30 tools**, from `src/main/tools/`:

| Group | Tools |
| --- | --- |
| Filesystem | `fs_read` `fs_write` `fs_edit` `fs_list` `fs_mkdir` `fs_move` `fs_delete` |
| Execution | `shell` `start_job` `job_status` `stop_job` |
| Search | `grep_search` `web_search` `web_fetch` |
| State | `todo_write` `memory_save` `memory_search` `set_thread_title` |
| Evidence | `read_tool_result` `search_tool_results` |
| Delegation | `run_agent` `agent_result` `peek_agents` `batch` |
| Sessions | `list_sessions` `send_message` `check_inbox` `peek_session` |
| Media / UX | `show_image` `show_image_data` `fetch_image` `ask_user` |
| Discovery | `find_mcp` (+ `mcp__<server>__<tool>` on demand) |

**Context engine** (`runtime/contextBudget.ts`, `runtime/runManager.ts`,
`runtime/tokenizer.ts`): real BPE counting via `gpt-tokenizer`; stale tool-result
pruning to byte-stable placeholders; threshold-triggered auto-compaction with a
hard block threshold; four Anthropic cache breakpoints including a byte-stable
history anchor pinned at `StreamRequest.cacheAnchorIndex`.

**Policy** (`tools/types.ts`, `runtime/approvals.ts`): modes `plan | act | review`,
presets `manual | workspace | full | custom`, per-tool risk tiers, an interactive
approval broker with once/run/thread scope.

**Persistence** (`store/db.ts`, `store/eventStore.ts`): SQLite WAL, append-only
run events with sequence numbers, a `file_changes` table holding before/after
snapshots up to 256 KB.

**Orchestration**: `run_agent` subagents with isolated context and summary-only
return, background agents tracked at thread scope, per-subagent round budgets with
a wind-down warning, cross-session messaging with two delivery lanes.

**Reliability**: three-tier stall recovery (leaked tool-call sentinels, action-intent
sentence match, parked-orchestrator detection), endpoint retry, empty-round retry.

**Absent, confirmed by grep over `src/`**: git integration; `sandbox-exec`,
Landlock, seccomp, or container execution; tree-sitter, AST parsing, or embeddings;
checkpoint/rewind; lifecycle hooks; a lint or test gate on edits; any eval suite.
`CLAUDE.md` and `AGENTS.md` are read, but only by `memory/bridge.ts`, which chunks
them into the memory store — they are not a first-class layered instruction file.

---

## 2. The architecture the field converged on

Three 2026 papers independently describe the same thing.

**Hu (arXiv:2604.18071)** read the source of 70 public agent systems, frozen
2026-03-23, and coded five recurring design dimensions: subagent architecture,
context management, tool systems, safety mechanisms, orchestration. The
distributions are the most useful benchmark available for "is my harness normal":

| Dimension | Modal choice | Share |
| --- | --- | --- |
| Tool system | Explicit registry | 34.3% (MCP-first 14.3%) |
| Context | Hybrid | 27.1% (file-persistent 22.9%, hierarchical 17.1%) |
| Subagents | None | 30.0% (orchestrator-worker 18.6%, tool-delegation 17.1%) |
| Isolation | Process separation | 45% (container 31%, **none 17%**, WASM 7%) |
| Audit | No audit | 40% (basic logs 35%, structured 20%, **tamper-evident 5%**) |
| Planning | ReAct-style | 50% (plan-and-execute 35%, hierarchical 15%) |

Its headline finding is a warning aimed squarely at Lattice: *"capability growth ≠
safety maturity"* — coordination mechanisms advance faster than the governance
infrastructure around them. Lattice has orchestrator-worker subagents, background
delegation, and cross-session messaging, and 17%-tier isolation.

**The Claude Code design-space paper (arXiv:2604.14228)** quantifies how much of a
production agent is harness: **~1.6% of the codebase is AI decision logic; 98.4% is
operational infrastructure.** It counts 54 built-in tools (19 unconditional, 35
feature-gated), 27 hook event types, 7 permission modes, a 5-layer context-reduction
pipeline, and 7 independent safety layers any one of which can block execution. Two
of its findings are directly load-bearing for Lattice's approval design: users
approve roughly **93% of permission prompts without careful review**, and
auto-approve rates climb from ~20% at fewer than 50 sessions to over 40% by 750
sessions. Approval fatigue is measured, not hypothetical.

**Terminal-Bench 2.x** makes the economic case. Artificial Analysis runs the whole
leaderboard through a single harness, Terminus 2, in an e2b sandbox, specifically so
harness differences do not confound model comparison. The Codex knowledge base
reports the same GPT-5.5 scoring 83.4% under Codex CLI and 76.40% under Terminus 2
— a 7-point swing with the model held constant `[secondary]`. Tmax
(arXiv:2606.23321) shows the effect from the other side: an RL-trained 9B model
gains at least 9 points across every harness it was tested in, but its largest gains
stay in the harness it was trained against. The harness is not a thin wrapper. It is
a substantial fraction of measured capability.

---

## 3. Gap analysis

### 3.1 Evaluation — the gap that makes the others unfixable

**The field.** SWE-bench Verified is 500 human-validated issues across 12 Python
repos with a hidden PASS_TO_PASS / FAIL_TO_PASS oracle, run in pinned Docker.
Terminal-Bench 2.0 is 89 tasks across 16 categories in isolated containers, 5
attempts each. Aider's polyglot suite is 225 Exercism tasks across 6 languages.
Claw-SWE-Bench (arXiv:2606.12344) goes further and standardizes the *adapter*: a
fixed prompt, runtime budget, workspace contract, patch-extraction procedure and
evaluator, so heterogeneous harnesses are comparable at all — 350 instances, 8
languages, 43 repos.

**Lattice.** `package.json` has `test` (vitest unit), `test:e2e:cli`, and
`e2e-app.mjs`. There is no task suite, no pass/fail oracle, no cost-per-solve
number, no regression gate. `docs/STATUS.md` says end-to-end real-provider tool-call
testing "is still needed."

**Why it is the meta-gap.** Every intervention below has a literature-reported
effect size in the 2–12 point range. You cannot land a 3-point change you cannot
measure, and several of the changes below are known to be *negative* for some
model/harness combinations — the Complexity Trap results show Gemini 2.5 Flash
thinking losing 9.9 points to observation masking and 22.3 points to LLM summary on
the same benchmark where Qwen3-Coder gained. Lattice ships observation masking
today, globally, with no measurement.

**The fix.** A `evals/` directory and a `pnpm eval` script that runs the headless
runtime (`src/headless/index.ts` already exists and is the right entry point)
against 20–50 SWE-bench Verified instances in Docker, reporting solve rate, mean
cost, mean rounds, and mean wall time. Start with SWE-bench Verified Mini. Gate
`runManager.ts` changes on it. Everything after this is cheaper once this exists.

### 3.2 Verification — the harness must enforce what the prompt asks for

**The field.** SWE-agent's central claim (arXiv:2405.15793) is that the
*interface*, not the model, is the lever: concise navigation commands, a
line-windowed file viewer, and **an editor that runs a linter on every edit and
refuses the edit if the result is not syntactically valid**. That single guardrail is
why the paper reads as an interface-design paper rather than a prompting paper.
CodeMonkeys (arXiv:2501.14723) scales the same idea to selection: generate a
candidate edit *and* a test script per trajectory, sample many trajectories,
filter by test-based voting, then let a model pick among survivors — 57.4% on
SWE-bench Verified, with oracle selection landing within 1.9 points of o3.

**Lattice.** `AGENTIC_EXECUTION_PROTOCOL` step 5 says "Verify each deliverable with
an independent check." It is a prompt. `fs_edit` has no post-write validation of any
kind; there is no lint, no typecheck, no test invocation, no syntax gate. The
protocol even instructs the model to batch all edits and verify once at the end,
which maximizes the blast radius of an unvalidated write.

**The fix, in order of cost.**
- *Cheap:* a syntax gate in `fs_edit` / `fs_write`. For `.ts/.tsx/.js/.jsx/.json`
  you can parse in-process; for other languages shell out to whatever the workspace
  already has. Reject the edit, return the parse error as the tool result. This is
  one function in `tools/builtin.ts` and it is the highest-leverage 100 lines in
  this analysis.
- *Medium:* a workspace-detected verify command (`pnpm typecheck`, `pytest -q`)
  exposed as a first-class `verify` tool and appended to the completion audit, so
  "done" has a machine-checkable definition.
- *Expensive, later:* candidate sampling with test-based selection, which only
  makes sense once 3.1 exists to prove it pays.

### 3.3 Isolation — Lattice is in the bottom 17%

**The field.** Codex CLI enforces filesystem and network restrictions at the kernel
level: Seatbelt on macOS, Landlock + seccomp on Linux, restricted tokens on Windows,
with three sandbox modes (`read-only`, `workspace-write`, `danger-full-access`) and
all execution routed through a ToolRouter that picks the sandbox before spawning
`[secondary]`. OpenHands runs the agent's actions in a containerized runtime by
construction. Codex Cloud defaults network access off; Copilot's agent limits egress
to a trusted destination list `[secondary]`.

**Lattice.** `shell` spawns a real login shell on the host. Containment is
`isPathInsideRoots` plus approval prompts. `docs/STATUS.md` concedes the filesystem
checks "are not a native `openat`-style atomic capability boundary." There is no
network egress control at all, which matters more than the filesystem story: a
`web_fetch` of a poisoned page, or an `npm install` postinstall, has the full
network and the full home directory.

**Compounding factor.** The Claude Code paper's 93%-approval and rising-auto-approve
numbers mean an approval prompt is not a security boundary at scale — it is a
speed bump that users learn to tap through. Lattice's broker is well-built, and it
is the *only* boundary. That is the mismatch the 70-system study names.

**The fix.** macOS ships `sandbox-exec`. It is deprecated-but-present and is exactly
what Codex uses. A profile that grants read to the approved roots, write to the
workspace, and denies network by default, applied in `platform/shell.ts` at the
spawn site, would move Lattice from the 17% tier to parity with Codex CLI on the
platform Lattice actually targets. Egress control for `web_fetch` is a separate,
smaller change: an allowlist evaluated in `tools/webTools.ts`.

### 3.4 Prompt injection — no defense, and a large attack surface

**The field.** Beurer-Kellner et al. (arXiv:2506.08837), fourteen authors across
Google, Microsoft, IBM, ETH Zurich and EPFL, enumerate six patterns that make
agents structurally resistant rather than persuasively resistant: action-selector,
plan-then-execute, map-reduce, dual-LLM, code-then-execute, and
context-minimization. The trade-off is explicit — action-selector and
context-minimization buy the most security at the most cost in flexibility;
dual-LLM and code-then-execute are strongest and hardest to build.

**Lattice.** `web_fetch`, `web_search`, MCP tool results, file contents, and now
*inter-session messages from other threads* all enter the model's context as
ordinary text. There is no trust labeling, no quarantine, no pattern. The
inter-session messaging feature is the sharpest version of this: a thread that
fetched a hostile page can `send_message` to another thread, and the receiving
thread's steer path folds that text into work in progress.

**The fix.** The cheapest meaningful step is provenance: tag every context block
with its trust level in the wire format, and adopt map-reduce for the one case
that obviously fits — `web_fetch` of untrusted pages should be summarized by a
tool-less subagent whose output returns as data, never as instructions. Lattice
already has the subagent machinery; this is a routing change, not new
infrastructure.

### 3.5 Code intelligence — grep is the whole story

**The field.** Aider parses every source file with tree-sitter, extracts `def` and
`ref` tags via per-language `.scm` queries, builds a graph with files as nodes and
symbol references as edges, and runs **personalized PageRank with the restart vector
biased toward the symbols currently in the chat**. The ranked definitions are
rendered through `grep_ast.TreeContext` so each definition appears with structural
context and irrelevant lines elided, and a binary search fits as many ranked tags as
the token budget allows (default `map_tokens` 1024, multiplied 8x when no files are
in the chat). Cursor maintains an embedding index synced by Merkle tree so
re-indexing only touches changed branches, and reports semantic search at +12.5%
agent accuracy over grep alone, with the hybrid at +23.5%.

**Lattice.** `grep_search`. That is it. Every question about "where is X handled"
costs the model a round of guessing at regexes, and the answer arrives as raw
matched lines with no structural context.

**The fix.** The Aider design is the right one for a local-first harness because it
needs no embedding service and no index server: tree-sitter is a native dep, the
graph is cheap, and the output is a token-budgeted text map. A `repo_map` tool
(or better, an always-on map block placed *before* the cache anchor so it stays
cached) is a self-contained addition under `src/main/runtime/`. Semantic search is
the second step and requires a decision about where embeddings live.

### 3.6 Checkpoints, rewind, and git — the undo story is missing

**The field.** Claude Code snapshots file state before every edit, persists the
snapshots across sessions, and lets you restore code, conversation, or both. Its
known limitation is instructive: bash-driven changes (`rm`, `mv`, `cp`) escape the
edit-tool checkpoint model `[secondary]`. The broader ecosystem answers the same
need with git worktrees — one isolated working directory per parallel agent, tests
run locally, a diff reviewed and merged in dependency order.

**Lattice.** `captureFileDiff` writes before/after snapshots into `file_changes`,
which powers a read-only session-diff view. The data to implement rewind is largely
already being collected; the restore path, the conversation-rewind path, and any
git awareness are all absent. Lattice also has no worktree story, which matters
because it *does* have background subagents — multiple agents editing one working
tree with no isolation and no undo.

**The fix.** Two independent pieces. (a) Restore-from-`file_changes`, which is
mostly UI plus a writer, and closes the single most-requested safety affordance.
(b) Per-subagent git worktrees for `run_agent(background: true)`, which converts
Lattice's existing parallelism from a hazard into the pattern the field uses.

### 3.7 Context management — Lattice is strong, with one hole

This is the dimension where Lattice is competitive, so the analysis is about
calibration rather than absence.

**What the literature says.** Observation tokens are ~84% of an average SWE-agent
turn (arXiv:2508.21433). Simple observation masking halves cost relative to a raw
agent while matching or beating LLM summarization on solve rate — Qwen3-Coder 480B:
54.8% at $0.61/instance masked vs 53.4% at $1.29 raw vs 53.8% at $0.64 summarized.
The summarization calls themselves account for up to 7.2% of instance cost and
cannot be cached, because each summary processes a unique sequence. A hybrid beats
both by a further 7–11%. Separately, Slipstream (arXiv:2605.08580) identifies the
structural flaw in compaction: **the compactor cannot know what the agent will need
next**, post-compaction steps are conditioned on the summary, and errors propagate
as coherent-but-wrong behavior. Running compaction asynchronously against the
original context yields an independent validation signal; with a judge checking
that the summary preserves forward intent and key constraints, they report **+8.8
percentage points accuracy and −39.7% end-to-end latency**.

**Lattice.** Ships observation masking (`pruneToolResults`) *and* threshold
compaction *and* — the part nobody else ships — `read_tool_result` /
`search_tool_results`, which make pruned evidence durably retrievable by `call_id`,
including results folded into compaction history. That is precisely the
"don't delete, relocate" pattern the 2026 context-engineering consensus recommends,
and Lattice implements it more completely than OpenHands' condenser does.

**The hole.** Compaction is synchronous, on the critical path, and unvalidated. It
is exactly the design Slipstream measures as lossy. Auto-compaction also fires at
a fixed occupancy threshold with no signal about whether the summary was adequate.

**The fix.** Async compaction with a judge, per Slipstream, is a well-specified
change to `maybeAutoCompact` in `runManager.ts`: run the compactor in parallel with
continued execution on the original context, then validate the candidate summary
against the steps the agent actually took. Lower-effort intermediate step: keep the
compaction and record a `compaction.validated` event with the judge's verdict, so
3.1 can measure whether compaction is helping at all.

### 3.8 Extensibility — four mechanisms vs one

**The field.** Claude Code exposes four composable extension layers at different
context costs: MCP servers (protocol, third-party breadth), plugins (code, deep
integration), skills (folder-based instruction packs loaded on demand, each a
`SKILL.md` plus optional scripts), and hooks (27 event types, 5 safety-related,
deterministic scripts that run at lifecycle points — `PreToolUse` being the primary
security checkpoint). The distinction that matters: hooks are *deterministic code*,
not instructions the model may ignore.

**Lattice.** MCP, and nothing else. There are no hooks, so every policy is either
hard-coded in `tools/types.ts` or expressed as prompt text the model can decline to
follow. There is no skills mechanism, so instructions cannot be progressively
disclosed — everything either lives in the always-on system prompt or in memory.

**Note on what Lattice already does right here.** Deferred MCP discovery via
`find_mcp` is the same idea as skills applied to tools, and applied better than most:
only ~2.5k tokens of builtin schema ship by default, servers are announced by
identity and instructions, and selecting one loads its full schema append-only for
that thread. The Claude Code paper lists "deferred tool schemas" as one of three
places context-as-binding-constraint shows up in its architecture. Lattice built
that. It just didn't build the instruction-side twin.

**The fix.** A `PreToolUse`-equivalent hook is a small interface in
`runtime/approvals.ts` — a user-configured command that receives the tool name and
arguments and returns allow/deny/modify. It buys deterministic policy, which is what
the approval-fatigue numbers say you need.

### 3.9 Orchestration — Lattice has the machinery and none of the guardrails

**The field.** MAST (arXiv:2503.13657) annotated 1600+ traces across 7 multi-agent
frameworks with six experts at Cohen's κ = 0.88, and found 14 failure modes in 3
categories: **~41.8% specification and system design** (task misinterpretation,
ambiguous roles, poor decomposition, missing termination conditions), ~37%
inter-agent misalignment, ~21% task verification. The distribution says the failures
are not in the models; they are in how the orchestration is specified and terminated.

**Lattice.** `run_agent` with isolated context and summary-only return is the right
primitive and matches Claude Code's design. Round budgets with a wind-down warning
are a genuinely good termination mechanism that most frameworks lack. But subagent
*templates* do not exist, parent-ceiling enforcement is not implemented, and there
is no provenance UI — which maps directly onto MAST's largest bucket. `docs/ROADMAP.md`
lists all three as missing.

**The fix.** Subagent templates with declared role, tool subset, and acceptance
criteria address the 41.8% bucket at its root. Parent-ceiling enforcement is a
safety bound on recursion. Both are already scoped in the roadmap; the MAST numbers
are the argument for moving them up.

### 3.10 Audit and observability — a latent strength left unbuilt

**The field.** OpenTelemetry's GenAI semantic conventions, at v1.41, define agent,
workflow, tool and model spans with required latency and token-usage metrics
(`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.response.finish_reasons`),
so a run becomes one hierarchical trace you can replay. Meanwhile only 20% of the
70-system corpus has structured audit and 5% has tamper-evident audit.

**Lattice.** The append-only `run_events` table with sequence numbers and typed
bodies is, structurally, a better audit substrate than most of that corpus has. It
is used for UI replay and nothing else. No OTel export, no integrity chain, no
security-event view.

**The fix.** Hash-chaining `run_events` is a few dozen lines and moves Lattice into
the 5% tier on a dimension where it already did the hard part. An OTel exporter is
optional but makes the eval harness in 3.1 much easier to analyze.

### 3.11 Interop — Lattice is an island

**The field.** The Agent Client Protocol (JSON-RPC 2.0 over stdio, from Zed, August
2025) had been adopted by JetBrains, Google and GitHub with 25+ agents by 2026, and
turns the N×M editor-times-agent problem into N+M `[secondary]`. `AGENTS.md` is the
cross-tool instruction convention.

**Lattice.** No ACP server, no ACP client. `AGENTS.md`/`CLAUDE.md` are ingested as
memory chunks rather than honored as a layered instruction file. Lattice's roadmap
describes runtime bridges to Claude Code and Hermes; ACP is the standard that makes
that one implementation instead of two.

---

## 4. Where Lattice is ahead

Being fair about this matters, because three of these are things the literature
asks for and the named harnesses do not do.

**Prune-then-retrieve tool evidence.** Observation masking plus `read_tool_result` /
`search_tool_results` over durable storage, including compaction history. OpenHands
drops events and replaces them with a summary; the dropped content is gone. Lattice
masks and keeps a retrievable pointer. The 2026 consensus phrasing is
"don't delete, relocate" — Lattice relocates, most harnesses delete.

**Three-tier stall recovery.** Detecting a turn that announced an action and never
took it — by counting stripped tool-call sentinels, by matching action-intent
sentences, and by catching a parked orchestrator that promised to report back while
subagents run — is a direct answer to the failure class Wu (arXiv:2606.14589) calls
**fail-plausible**: the system transforms an error into fluent, plausible narrative
delivered to the user. That paper found ~70% of silent failures were caught by a
human looking at output, not by tests or health checks, with incident latencies from
13 hours to 60 days. Lattice detects a subclass of it automatically and in-loop. I
did not find another harness that does.

**Four-slot cache anchoring with a byte-stable history anchor.** Compaction and
summarization defeat prefix caching; the Complexity Trap paper notes summary calls
can't reuse cache and that some providers price cache hits up to 10x cheaper.
Lattice pins a stable anchor at the turn's tail so the full prefix is re-read even
when one round appends more blocks than the provider's automatic lookback covers.
That is a real engineering result and it is invisible in every comparison table.

**Deferred MCP schema loading.** Described in 3.8. Named as a desirable property in
the Claude Code paper; built here.

**Inter-session messaging with dual delivery lanes.** Steer-injection into a running
recipient at a safe boundary, inbox when idle. Nothing in the surveyed corpus does
peer-to-peer session addressing; the closest analogue is orchestrator-worker, which
is strictly hierarchical. It is also, per 3.4, the largest untrusted-input surface
in the app.

**Cost engine with user overrides.** Provider-reported → user override → list price,
with click-to-edit anywhere an estimate appears. Given that the research literature
increasingly reports cost-per-solve alongside solve rate, this is infrastructure the
eval harness in 3.1 can use on day one.

---

## 5. Build order

Ranked by (impact × confidence) ÷ effort. The first two are not negotiable if the
goal is a harness that measurably competes.

| # | Work | Effort | Evidence it pays |
| --- | --- | --- | --- |
| 1 | `evals/` + `pnpm eval` over SWE-bench Verified Mini via `src/headless` | 3–5 days | Everything below has a 2–12 pt effect size you currently cannot see |
| 2 | Syntax/lint gate in `fs_edit`/`fs_write`; `verify` tool from workspace scripts | 1–2 days | SWE-agent's central result (arXiv:2405.15793) |
| 3 | `sandbox-exec` profile at the spawn site in `platform/shell.ts`; egress allowlist in `webTools.ts` | 2–4 days | Moves off the 17% no-isolation tier; parity with Codex CLI on macOS |
| 4 | tree-sitter repo map with personalized PageRank, budgeted, cached before the anchor | 4–7 days | Aider's design; Cursor reports +12.5% / +23.5% hybrid |
| 5 | Restore-from-`file_changes` (code + conversation rewind) | 2–3 days | Claude Code parity; data is already collected |
| 6 | Async compaction + judge validation in `maybeAutoCompact` | 3–5 days | Slipstream: +8.8 pp, −39.7% latency (arXiv:2605.08580) |
| 7 | `PreToolUse` hook interface in `approvals.ts` | 1–2 days | Deterministic policy; 93% of prompts are approved unread |
| 8 | Subagent templates + parent-ceiling enforcement | 2–4 days | MAST: 41.8% of MAS failures are specification/design |
| 9 | Git worktree isolation for background subagents | 3–5 days | Converts existing parallelism from hazard to pattern |
| 10 | Trust-labeled context + tool-less summarizer subagent for `web_fetch` | 2–3 days | Map-reduce pattern (arXiv:2506.08837) |
| 11 | Hash-chained `run_events`; optional OTel export | 1–2 days | 5% of the corpus has tamper-evident audit; substrate exists |
| 12 | ACP server lane | 5–8 days | One implementation instead of per-harness bridges |

Items 1–3 are roughly two weeks and change what Lattice *is*: a harness with a
measured solve rate, a definition of done the runtime enforces, and a blast radius.

---

## 6. Sources

**Papers**

- Hu, *Architectural Design Decisions in AI Agent Harnesses*, arXiv:2604.18071 — 70-system corpus, five dimensions, the distribution tables in §2.
- *Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems*, arXiv:2604.14228 — 1.6%/98.4% split, 54 tools, 27 hooks, 7 permission modes, 5-layer compaction, 93% approval rate.
- Yang et al., *SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering*, arXiv:2405.15793 (NeurIPS 2024) — ACI principles, linter-gated edits.
- Lindenbauer et al., *The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization*, arXiv:2508.21433 — 84% observation tokens, Table 1 solve/cost figures, 7.2% summary overhead.
- Chen et al., *Slipstream: Trajectory-Grounded Compaction Validation for Long-Horizon Agents*, arXiv:2605.08580 — async compaction + judge, +8.8 pp / −39.7%.
- Cemri et al., *Why Do Multi-Agent LLM Systems Fail?*, arXiv:2503.13657 — MAST, 1600+ traces, 14 failure modes.
- Ehrlich et al., *CodeMonkeys: Scaling Test-Time Compute for Software Engineering*, arXiv:2501.14723 — 57.4% SWE-bench Verified, test-based selection.
- Beurer-Kellner et al., *Design Patterns for Securing LLM Agents against Prompt Injections*, arXiv:2506.08837 — six patterns.
- Wu, *When Errors Become Narratives: A Longitudinal Taxonomy of Silent Failures in a Production LLM Agent Runtime*, arXiv:2606.14589 — fail-plausible, 70% discovery-by-human, 0% ex-ante governance prevention.
- Ivison et al., *Tmax: A Simple Recipe for Terminal Agents*, arXiv:2606.23321 — harness-transfer results, Terminal-Bench 2.0.
- *The OpenHands Software Agent SDK*, arXiv:2511.03690 — condenser, sandboxed runtime, security analyzer.
- Zhang et al., *Agentic Context Engineering*, arXiv:2510.04618 — brevity bias, context collapse, +10.6% agents.
- *Terminal-Bench*, arXiv:2601.11868 — 89 tasks, frontier agents under 65%.
- *Claw-SWE-Bench*, arXiv:2606.12344 — harness adapter protocol, 350 instances.
- *From Question Answering to Task Completion: A Survey on Agent System and Harness Design*, arXiv:2606.20683.
- *Holistic Agent Leaderboard*, arXiv:2510.11977.

**Primary documentation**

- OpenHands Context Condenser docs — `LLMSummarizingCondenser`, up to 2x cost reduction, linear vs quadratic scaling.
- Aider, *Building a better repository map with tree sitter* — tag extraction, personalized PageRank, `map_tokens`.
- Cursor, *Improving agent with semantic search* — +12.5% semantic, +23.5% hybrid; Merkle-tree sync.
- OpenAI, *Agent approvals & security* — Seatbelt / Landlock / seccomp, three sandbox modes.
- Anthropic, *Run agents in parallel* — subagent isolation, worktree guidance.
- Zed, *Agent Client Protocol* — JSON-RPC 2.0 over stdio.
- OpenTelemetry, *GenAI observability* — v1.41 agent/workflow/tool/model spans.
- Artificial Analysis, Terminal-Bench v2.1 — all scores under a fixed Terminus 2 harness in an e2b sandbox.

**Secondary (blogs, marked `[secondary]` in text)** — Codex Knowledge Base
(codex.danielvaughan.com) for codex-rs internals and the 83.4% / 76.40% harness gap;
Qovery and Modal sandbox comparisons; assorted 2026 harness field guides.
