# Lattice: desktop agent harness product plan

Working title only. This plan assumes a macOS-first desktop product for technical users, followed by Windows and Linux, built by a small product team. The attached Codex and Claude Code screenshots are visual references, not behavioral specifications.

## 1. Product thesis

Lattice is a local-first control room for long-running agentic work. Its single job is to let a user understand, direct, and safely control one or many model runs without losing the simplicity of a chat app.

The product should combine:

- Codex's calm workspace shell, project organization, pinned tasks, and substantial composer.
- Claude Code's dense but readable execution transcript, compact tool events, and persistent run controls.
- A provider-neutral runtime that does not flatten away model-specific capabilities.

The main product principle is **progressive disclosure**: ordinary work still feels like chat; reasoning events, tool calls, agents, browser state, context composition, caching, and diagnostics are one click away and become visible automatically when they matter.

## 2. One hard platform constraint

“Show all thinking tokens” cannot be a universal promise. The app should stream **each reasoning event the chosen provider exposes** and label its fidelity:

| UI label | Meaning |
|---|---|
| Raw provider reasoning | The provider returned a readable reasoning stream. |
| Reasoning summary | The provider returned a generated summary, not raw chain-of-thought. |
| Reasoning hidden | Reasoning was used or billed but no readable content was exposed. |
| Reasoning off | This request used a non-reasoning mode. |

OpenAI exposes opt-in reasoning summaries and reasoning usage rather than promising raw internal reasoning. Current Anthropic models likewise expose provider-controlled summaries or omitted thinking, and OpenRouter notes that reasoning visibility varies by model/provider. The transcript must never rename a summary “full thinking.”

Sources: [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning), [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking), [OpenRouter reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## 3. UI direction

### Visual system

This dark, instrument-like workspace feels closer to a quiet code editor mixed with a flight recorder than a neon “AI dashboard.”

- **Obsidian canvas** `#121416`: transcript background.
- **Graphite shell** `#1A1D20`: sidebars, composer, panels.
- **Raised slate** `#25292D`: selections, cards, menus.
- **Chalk text** `#E8E9EA`: primary copy.
- **Route violet** `#8E87D8`: models, branches, subagents.
- **Signal brass** `#D5A45D`: permissions, queued work, cache writes.

Use **Instrument Sans** for the interface and **IBM Plex Mono** for code, token metrics, routes, and event IDs. Corners use an 8 to 12 px radius with precise 1 px separators. Status color has a text or icon companion.

The references already dictate a dark shell, so distinction comes from information design rather than decorative gradients. The memorable element is the **Context Orbit**: a segmented circular gauge that shows what occupies the selected model's usable context and expands into a complete context/cache inspector.

### Desktop layout

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ Workspace / project / branch       Plan ▾   Permission ▾        Run status   ⌘K       │
├──────────────────┬─────────────────────────────────────────────┬───────────────────────┤
│ NEW              │                                             │ CONTEXT | AGENTS      │
│ Search           │  User message                               │ MEMORY  | TASKS       │
│                  │                                             │ TOOLS   | FILES       │
│ PINNED           │  ┌ activity spine ───────────────────────┐  │                       │
│  • Task          │  │ reasoning / tool / subagent events    │  │ BROWSER | RUN         │
│  • Task          │  └───────────────────────────────────────┘  │ or selected inspector  │
│                  │                                             │                       │
│ ACTIVE           │  Assistant answer                            │                       │
│  ◌ Running       │  28.4 tok/s · 2.1s TTFT · 92% cached · $0.04│                       │
│  ◷ Queued        │                                             │                       │
│                  │                                             │                       │
│ PROJECTS         │  [ steering / queued-message shelf ]         │                       │
├──────────────────┴─────────────────────────────────────────────┴───────────────────────┤
│  + files  @context     Ask Lattice…                                      ◔ 62%   ↑     │
│  Workspace auto        Model: OmniRoute / Fable 5    Effort: high   Tools: Dev profile │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

The left rail is 260–300 px, the inspector is 320–380 px, and both collapse. The center transcript stays visually dominant. The composer never becomes a control-panel wall; secondary controls live in popovers.

### The Context Orbit

The ring in the composer's lower-right corner is the product's signature and primary health indicator.

Its segments represent:

- system and agent instructions;
- tool/MCP schemas;
- conversation history;
- injected file or retrieval content;
- reasoning/output reserve;
- safety buffer.

The center shows effective occupancy, such as `62%`, not merely raw tokens divided by the advertised context window. Hover shows `86.3k / 128k usable`; click opens the Context inspector with exact/estimated status, provider limit, output reserve, cacheable prefix, compaction threshold, locked turns, and the expected effect of changing models.

When a provider does not expose an authoritative count, the number gains a `~` marker. At 80% the ring quietly warms; at 92% it offers compaction; at 97% it blocks a doomed request unless the user explicitly changes the policy.

### Transcript behavior

Each assistant turn has four layers:

1. **Live activity header:** model, effort, route, running state, stop button.
2. **Activity spine:** chronological reasoning summaries, tool calls, approvals, retries, compactions, and subagent events. The compact default expands the active event.
3. **Answer:** readable Markdown, code, artifacts, and diffs.
4. **Turn telemetry:** TPS, time to first token, wall time, output/reasoning tokens, cache read/write, estimated cost, and route. A subdued line keeps these values available.

During generation, provider-visible reasoning can be set to `Expanded`, `Auto`, or `Hidden`. `Auto` shows the active reasoning block while work is running, then collapses it to a one-line receipt. Tool inputs that may contain secrets are redacted in the transcript and available only through a permissioned diagnostics view.

### Rich Markdown and typography

The transcript needs a dedicated Markdown renderer that matches the attached reference's readable prose, strong emphasis, generous list rhythm, and distinct inline-code treatment.

Recommended message typography:

- body: Instrument Sans, 16 px, 1.56 line height, maximum readable width of 78 characters;
- headings: 600–650 weight with restrained size changes rather than oversized display text;
- strong text: 650 weight so emphasis is clear without becoming visually black;
- lists: 28 px marker gutter, 8 px between items, and 4 px between wrapped lines;
- code and metrics: IBM Plex Mono, 0.91 em for inline code and 13.5 px in blocks;
- inline code: `#E98287` text on `#24272A`, a `#35393D` hairline border, 4–6 px radius, and compact horizontal padding;
- execution receipts such as “ran a command” or “background command completed”: 14 px muted text outside the answer's Markdown hierarchy;
- prose, code, logs, diffs, citations, and metrics each get their own intentional type role.

Use these baseline tokens in the default comfortable density:

| Element | Font / weight | Size / line height | Treatment |
|---|---|---|---|
| Body | Instrument Sans 430 | 16 / 25 px | `#E8E9EA`, 78 ch maximum |
| H1 | Instrument Sans 650 | 28 / 34 px | 28 px top, 12 px bottom |
| H2 | Instrument Sans 650 | 22 / 29 px | 24 px top, 10 px bottom |
| H3 | Instrument Sans 620 | 18 / 25 px | 20 px top, 8 px bottom |
| H4 | Instrument Sans 620 | 16 / 23 px | sentence case |
| Inline code | IBM Plex Mono 500 | 0.91 em / 1.35 | `#E98287` on `#24272A` |
| Code block | IBM Plex Mono 450 | 13.5 / 21 px | header bar, line numbers optional |
| Tool receipt | Instrument Sans 430 | 14 / 20 px | `#A9AAA7`, one-line default |
| Turn metrics | IBM Plex Mono 450 | 12 / 17 px | tabular numerals, `#8F9295` |

Compact density uses 15 / 22 px body text and 6 px list gaps. Presentation density uses 18 / 29 px body text, a 72 ch measure, and 10 px list gaps. Bundle the SIL-licensed Instrument Sans and IBM Plex Mono files; fall back to `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` and `ui-monospace, "SFMono-Regular", Consolas, monospace`.

Component rules:

- links use Route violet with an underline on hover and keyboard focus;
- blockquotes use a 3 px `#4A4F55` rule, 16 px inset, and no italic default;
- tables use 14 / 21 px text, a 600-weight header, zebra fill under 3% luminance shift, and horizontal scrolling instead of squeezed columns;
- diffs combine color, `+`/`−` markers, and line backgrounds so color never carries meaning alone;
- citations use compact superscript anchors and an expandable source card;
- task-list controls remain interactive only in user-authored todos; assistant Markdown checkboxes render as content;
- math uses KaTeX-compatible rendering; Mermaid renders in a sandboxed worker with network access disabled and sanitized SVG output;
- remote images load through the file/network broker with workspace policy, size limits, MIME verification, and no ambient credentials.

Support CommonMark plus GitHub-style tables, task lists, strikethrough, autolinks, footnotes, fenced code, syntax highlighting, diff blocks, mathematical notation, and optional Mermaid diagrams. Raw HTML is disabled by default. Links, remote images, SVG, and diagram content are sanitized and follow workspace trust rules.

Build the renderer around a CommonMark syntax tree, GFM extensions, a strict HTML sanitization schema, and Shiki-compatible syntax themes. Mermaid runs outside the main renderer. Streaming Markdown must not flicker or restyle the entire answer on each token. Buffer incomplete fences, tables, footnotes, and diagrams; show them as plain text until the closing delimiter arrives. Parse by block, batch updates, and virtualize completed blocks in long threads. Code blocks include language, copy, wrap, open-in-file, and apply-as-patch actions.

Meet WCAG AA contrast in standard themes and AAA for core text in High contrast. Use a 2 px `#AAA5E9` focus ring with 2 px offset. At window widths below 1180 px, collapse the inspector into an overlay; below 860 px, turn the left rail into a drawer; below 720 px, use a single-column transcript. Keep a minimum supported window of 760 × 560 px.

### Model picker

The picker is a command palette rather than a long nested menu. Search works across provider, model name, alias, and capability. Each result shows:

```text
Fable 5       OmniRoute → Anthropic       1M ctx   128K out
Reasoning summary · vision · tools · cache · $$$
```

Selecting a model updates the effort choices and context orbit immediately. Unsupported controls disappear or explain why they are unavailable. The model picker supports:

- per-turn, per-chat, and default selection;
- native provider routes plus OmniRoute;
- aliases and pinned favorite models;
- latency/cost/capability filters;
- fallback chains;
- deprecation and route-health warnings;
- an “inherit” choice for subagents.

The app maintains a normalized capability record but preserves raw provider metadata. Context size, maximum output, reasoning modes, effort values, modalities, tools, cache behavior, and file limits are refreshed rather than hard-coded.

### Mode and permission controls

Mode and authority are independent controls.

**Mode**

- `Plan`: read-only investigation and a proposed plan; mutating tools are absent from the model's active tool set.
- `Act`: the model may execute within the selected permission profile.
- `Review`: inspect changes, test results, and risks without making new edits. This is a useful addition to the original brief.

Switching from Act to Plan is immediate. Switching from Plan to Act opens a small sheet that shows the exact authority being added, then records the transition in the event stream. A running model receives the change at the next safe boundary; the UI never silently changes authority mid-tool-call.

**Permission presets**

- `Manual`: ask before each side effect.
- `Workspace auto`: allow reads and writes inside approved roots; ask for deletes, external network actions, and privilege changes.
- `Full local`: allow local shell/files/network within the configured host profile; keep a global kill switch and an audit trail.
- `Custom`: a matrix over filesystem, shell, network, browser, MCP, secrets, and external actions.

Store each permission rule as structured data:

```text
subject: main | agent template | agent run | tool profile
resource: filesystem | shell | network | browser | mcp | secret | external_action
action: read | create | edit | delete | execute | connect | submit | disclose
scope: workspace path, host, domain, server/tool, or credential id
effect: allow | ask | deny
duration: once | run | thread | profile | permanent
conditions: optional command/path/domain matcher and risk tier
```

The broker uses this precedence:

1. organization or local hard deny;
2. mode ceiling, including Plan's mutation deny;
3. parent-agent authority ceiling;
4. matching `deny` rule;
5. matching `ask` rule;
6. the narrowest matching `allow` rule;
7. default `ask` for an attended run and `deny` for an unattended run.

Lower layers cannot widen a ceiling set above them. The broker canonicalizes paths before matching, matches domains by exact host or declared wildcard, parses shell commands into executable plus arguments, and rejects matchers it cannot interpret. Risk tiers are `R0` local read, `R1` workspace write or idempotent network read, `R2` deletion/shell/network mutation/secret use, and `R3` irreversible external action or privilege change. V1 stores local policy in the event database; a later team edition can add signed managed policy.

Approvals move through `requested`, `allowed once`, `allowed for run`, `allowed by profile`, `denied`, `expired`, or `canceled`. The approval sheet shows the tool, normalized arguments, affected resources, data leaving the machine, and the narrowest reusable rule it can save.

“Full access” is visible in brass instead of alarming red. External irreversible actions such as send, submit, purchase, publish, and remote deletion remain their own permission category so a filesystem setting cannot authorize them by accident.

### Steering, queueing, and interruption

While a run is active, the composer has an explicit split action:

- **Steer now**: deliver the message at the next safe model/tool boundary. If the provider cannot accept it in-place, stop cleanly, preserve partial output, and resume with the steering message.
- **Queue next**: start a new turn after the current run completes.

Messages appear on a shelf above the composer with `steering` or `queued` badges and can be edited, reordered, promoted, or canceled. Tool calls already in flight are never abandoned invisibly; cancellation produces a terminal event.

Recommended defaults: `Enter` sends when idle, `Enter` steers while running, and `⌘Enter` queues. All bindings are configurable.

### `/side` and `/btw`

`/side` and `/btw` open a right-side conversation fork from the current context snapshot. A side chat:

- has its own model, effort, context budget, and telemetry;
- does not pollute the parent transcript or context;
- is read-only by default;
- can quote or “promote” a result back into the main chat with provenance;
- remains attached to the exact parent event from which it forked.

The same machinery powers manual forks, “ask another model,” and comparison runs.

### Files, browser, and artifacts

The right inspector contains persistent tabs:

- **Files**: approved roots, tree view, search, changed files, inline preview, and diff review.
- **Browser**: isolated tabs, address bar, screenshots, console/network receipts, and agent cursor state.
- **Artifacts**: generated files, previews, versions, and reveal/export actions.
- **Run**: full event log, terminal output, raw provider envelopes, retries, and traces.

Clicking a file or browser tool event opens the exact resource and location in the inspector. The browser uses an isolated session per workspace and never has Node integration.

The attachment picker accepts any file or folder. Acceptance does not guarantee model interpretation. Known formats get previews, text extraction, OCR, transcription, archive inspection, or structured parsing. Unknown binaries remain available to local tools with clear labeling. The app hashes, deduplicates, indexes, and retrieves relevant parts of large files without silent truncation.

### Tool runtime

Tools are first-class typed objects rather than anonymous JSON schemas. Each tool manifest records:

- stable name, description, input/output schema, and version;
- source: built-in, plugin, MCP, provider-hosted, or external runtime;
- side-effect class and required permission scopes;
- timeout, cancellation, retry, concurrency, and idempotency behavior;
- secrets it may use and data it may send externally;
- cache fingerprint and deterministic ordering key;
- a purpose-built result renderer for diffs, files, tables, browser actions, terminals, or plain JSON.

The built-in baseline should cover read/write/apply-patch, file search/glob, shell and background processes, PTY interaction, Git/diff, web fetch/search, browser control, file conversion/inspection, artifacts, memory, todos, and subagent delegation. A deferred tool catalog lets the model discover large tool sets without loading all schemas into each request.

The Tools inspector supports search, enable/disable, schema inspection, a test console, recent calls, permission policy, and usage/context cost. The broker enforces each tool call's permission independent of prompt text. All results use a common success/error/canceled envelope while preserving the original provider payload for diagnostics.

### MCP control surface

Settings and the conversation-level Tools popover show each MCP server with:

- enabled/disabled state for this chat;
- transport: local STDIO, Streamable HTTP, or HTTP/SSE;
- connection health and latency;
- discovered tools, schemas, and last refresh;
- per-tool `allow`, `ask`, or `deny` policy;
- OAuth or secret-vault status;
- a test console and sanitized logs.

MCP configurations are grouped into versioned **tool profiles** such as `Code`, `Research`, or `PulseCore`. Profiles preserve deterministic tool ordering and stable schemas, which is important for prefix caching. Sensitive tools default to approval. The desktop runtime must implement local STDIO itself; remote-provider MCP connectors are not enough for a local desktop experience.

Sources: [MCP tools specification](https://modelcontextprotocol.io/specification/draft/server/tools), [OpenAI MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [Anthropic MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector).

### Subagents

Subagents can come from a saved template or be proposed dynamically by the coordinator.

A template defines:

- name and purpose;
- model selector and effort;
- system prompt/instructions;
- tool and permission profile;
- input context policy;
- maximum tokens, cost, wall time, and concurrency;
- required output contract.

A dynamic subagent must fit the parent's permission ceiling and budget. If it requests a new model, tool profile, or authority, the user sees one compact approval containing the delta.

The Agents inspector renders a tree with status, model, effort, context usage, TPS, cost, and current action. Selecting an agent opens its full transcript. Users can steer, pause, stop, or promote an agent's output. Child events also appear as compact cards in the parent activity spine.

### Memory system

Memory needs bounded stores, visible provenance, and prompt-injection resistance. An unbounded text blob in each request would waste context and hide what the model sees.

Use four complementary layers:

1. **Working memory:** ephemeral notes, current assumptions, and scratch state for one run. The app discards or checkpoints it when the run ends.
2. **Curated memory:** small, high-value facts injected into a stable prefix: user preferences, project conventions, durable decisions, environment facts, and recurring warnings.
3. **Knowledge archive:** sessions, tool receipts, artifacts, and larger notes indexed for on-demand search.
4. **Procedural memory:** reusable skills, agent templates, workflows, and tool-use patterns stored as versioned objects apart from personal facts.

Memory scopes are `run`, `thread`, `project`, `agent`, `user`, and `shared workspace`. Each memory item stores content, type, scope, source event, author, confidence, sensitivity, creation/update time, last use, optional expiry, version, and contradiction links.

The Memory inspector provides:

- “What the model sees now,” grouped by scope and token cost;
- proposed, approved, rejected, expired, and conflicting memories;
- provenance back to the exact message, file, or tool result;
- edit, pin, merge, correct, forget, export, and restore actions;
- a timeline of what was learned and when;
- per-scope auto-save policy: `off`, `propose`, or `automatic`;
- a one-click private mode that disables retrieval and writes for a run.

Writes use small atomic operations: add, replace, merge, and remove. Duplicate and near-duplicate detection runs before save. Conflicting facts become a review item instead of an overwrite. The app encrypts sensitive entries with a key protected by the OS keychain. It marks retrieved content as untrusted data, scans for injection/exfiltration patterns, and prevents that content from granting permissions or redefining system policy.

Storage uses SQLite for metadata, version history, full-text search, and provenance, plus an optional local embedding index for semantic retrieval. Retrieval is hybrid: exact/FTS search first, optional semantic candidates second, then a small relevance filter. The model can call explicit `memory.search`, `memory.get`, and `memory.propose` tools; it never receives an opaque dump of the entire archive.

To protect prefix caching, curated memory is frozen at the start of a run or turn. A memory write persists immediately but enters model context only at the next defined boundary. The UI shows “saved for next turn” and offers `Refresh memory`, which creates an intentional context/cache boundary.

This design intentionally combines Hermes' bounded curated memory and searchable session archive with Claude Code-style user/project/local agent scopes, while adding provenance, conflicts, security scanning, and an approval workflow. Sources: [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [Claude Code subagent memory](https://code.claude.com/docs/en/sub-agents).

### Todos and durable work

Todos are data, not prose that disappears during compaction. Provide two related surfaces:

- **Run checklist**: lightweight steps for the current thread/run, shown above the composer or in the Tasks inspector.
- **Work board**: durable tasks that survive restarts, span threads, have dependencies, and can be assigned to a person, main agent, or subagent template.

A todo supports title, details, status (`todo`, `in progress`, `blocked`, `review`, `done`, `canceled`), parent/subtasks, dependencies, assignee, priority, source event, due date, artifacts, result, and history. The model uses typed `todo.list`, `todo.create`, `todo.update`, `todo.block`, and `todo.complete` tools. Users can edit the same records; each change becomes an event.

The active task and next two items appear as a compact shelf; the full inspector supports list and Kanban views. A plan can be converted to todos, a todo can launch a run, subagents can claim bounded child tasks, and blocked items can request user input. Completion requires a result or explicit “no artifact” outcome so checkboxes do not become decorative progress theater.

Keep queued chat messages separate from todos: a queue controls conversation order; a todo represents durable work. For Hermes compatibility, provide an adapter between Lattice Work Boards and Hermes Kanban rather than writing directly to a live `kanban.db`. Hermes itself treats Kanban as a durable SQLite-backed work queue distinct from ephemeral delegation. Source: [Hermes Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban).

### Hermes and Claude Code compatibility

Compatibility has three levels and should be labeled precisely:

1. **Configuration import/export:** translate common files and preserve unknown fields for round-tripping.
2. **Extension compatibility:** reuse MCP servers, skills, instructions, agent definitions, hooks, and tool policies.
3. **Runtime bridge:** run or coordinate an external Hermes/Claude Code worker while normalizing its events into the Lattice transcript.

**Claude Code adapter**

- Load `CLAUDE.md`, `.claude/rules/**/*.md`, `.claude/skills/*/SKILL.md`, `.claude/commands/*.md`, `.claude/agents/*.md`, `.mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`, user settings, and plugin manifests from trusted workspaces.
- Map agent frontmatter for model, effort, tools, disallowed tools, permission mode, MCP servers, skills, memory scope, background mode, and worktree isolation into the Lattice template model.
- Map Claude Code permission modes (`default`/`manual`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`) to the nearest Lattice mode/profile and flag any narrower Claude Code condition the Lattice rule cannot preserve.
- Import command, HTTP, prompt, agent, and MCP-tool hooks as disabled drafts until the user reviews their triggers, executable paths, network destinations, and authority.
- Export back to Claude Code-compatible Markdown/YAML without inserting Lattice-only fields unless namespaced.
- Optionally expose a Claude Code runtime lane through its supported Agent SDK/CLI interface; do not depend on undocumented private session storage.

The initial Claude plugin subset covers manifest metadata, skills, agents, hooks, and MCP servers. LSP servers, monitors, and unknown components round-trip as opaque records with an “unavailable in Lattice” label until the app implements them.

Claude Code officially treats `CLAUDE.md`, skills, MCP, subagents, hooks, and plugins as separate extension surfaces, and its agent definitions already include model, effort, permissions, tools, MCP, memory, background, and isolation fields. Sources: [Claude Code extension overview](https://code.claude.com/docs/en/features-overview), [Claude Code subagents](https://code.claude.com/docs/en/sub-agents).

**Hermes adapter**

- Import/export `~/.hermes/memories/MEMORY.md`, `USER.md`, `AGENTS.md`/context files, `~/.hermes/skills`, model/provider profiles, and the `mcp_servers` block in `config.yaml`. Import secret references without copying plaintext values until the user chooses a destination vault entry.
- Offer read-only session discovery/search through Hermes' supported interfaces, with explicit import into Lattice when requested.
- Connect to `hermes mcp serve` for Hermes messaging tools. Use `hermes acp` for a full external runtime lane over stdio; normalize ACP chat, tool activity, file diffs, terminal commands, approval prompts, thinking/response chunks, usage, and cancellation events.
- When Lattice owns MCP connections for an ACP session, start Hermes with its documented host marker that skips the global MCP startup and pass the selected servers through the ACP session. This avoids duplicate tool registration.
- Translate Lattice tool profiles to Hermes toolsets/MCP filters and Lattice Work Boards to Hermes Kanban through a bridge/API.
- Never let Lattice and Hermes concurrently mutate the same Hermes home, memory files, `state.db`, or `kanban.db`; Hermes explicitly warns against multiple memory writers. Use snapshot import/export or a single-writer bridge.

Hermes documents direct Claude Code MCP migration, local/remote MCP, bounded memory plus SQLite session search, MCP server mode, and an ACP stdio runtime with tools, todos, memory, diffs, approvals, and streamed chunks. Sources: [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp), [Hermes ACP](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp), [Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [Hermes repository](https://github.com/NousResearch/hermes-agent).

The compatibility center should show a previewed diff before any export, flag lossy mappings, create backups, and provide `Import`, `Link read-only`, and `Export copy` modes. “Compatible” must never mean silently sharing a mutable private database.

Each adapter publishes a tested product-version range and stores the detected source version in its import report. Unknown versions open in preview-only mode. Runtime bridges require a successful capability handshake before launch. The Hermes ACP bridge runs `hermes acp --check`, negotiates the protocol during initialization, maps known event types, displays unknown non-permission events as generic raw receipts, and denies unknown permission events. Hermes session discovery uses the documented `hermes sessions` surface or negotiated ACP session methods; it does not query or mutate `state.db` directly.

## 4. Runtime architecture

### Recommended stack

Use **Electron + TypeScript + React** for v1.

This product needs a consistent embedded Chromium browser, PTYs and local processes, drag/drop, deep filesystem integration, and mature cross-platform packaging. Electron's footprint is acceptable for this class of tool and reduces integration risk. Use `WebContentsView`, not the discouraged `<webview>` element, for remote browser content. Remote pages must run without Node integration, with context isolation, sandboxing, explicit permission handlers, restricted navigation, and a strict CSP.

Sources: [Electron web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [Electron utility processes](https://www.electronjs.org/docs/latest/api/utility-process).

```text
React renderer (no Node)
       │ typed, validated IPC
Electron main ─────────────── WebContentsView browser partitions
       │
       ├── Agent runtime utility process
       │      ├── coordinator / run state machine
       │      ├── provider adapters
       │      ├── context + compaction engine
       │      ├── memory retrieval + todo scheduler
       │      ├── subagent scheduler
       │      └── event and telemetry normalizer
       │
       ├── Tool broker
       │      ├── filesystem scopes
       │      ├── shell / PTY workers
       │      ├── MCP manager
       │      ├── Hermes / Claude Code bridges
       │      └── browser action bridge
       │
       ├── SQLite event store + content-addressed blobs
       └── OS keychain secrets
```

The renderer never receives raw API keys. The main process should remain small; crash-prone model streams, MCP servers, parsers, tokenizers, and tools run in utility/child processes. The tool broker enforces authority independent of what the model requests.

### Provider adapter contract

Each provider, including OmniRoute, implements the same internal lifecycle without discarding provider-specific data:

```text
listModels() → normalized capabilities + raw metadata
startRun(request) → canonical event stream
steer(runId, message) / cancel(runId)
countTokens(context) → exact | estimated
compact(context, policy)
getUsage(response) → tokens, cache, cost, route
```

Canonical stream events include text deltas, reasoning deltas/summaries, tool proposals, tool calls, usage updates, provider retries, compaction records, errors, and completion. Raw envelopes are retained behind diagnostics for replay and bug reports.

**OmniRoute support** needs a dedicated adapter. Configuration should include base URL, authentication, model-registry endpoint, custom headers, route/fallback metadata, timeout policy, sticky-session identifier, and capability overrides. An OpenAI-compatible OmniRoute deployment can use that wire format as the baseline while preserving route/cache/TPS extensions.

### Event-sourced runs

Persist each run as an append-only event log. The visible transcript is a projection of that log. This structure supports crash recovery, replay, queueing, steering, subagent trees, partial answers, compaction receipts, and diagnostics.

Core records:

- `Workspace`, `Thread`, `Branch`, `Run`;
- `Message` and immutable `ContentBlock`;
- `RunEvent` with sequence, timestamps, source agent, and provider IDs;
- `AgentTemplate` and `AgentRun`;
- `MemoryItem`, `MemoryRevision`, and `MemoryProposal`;
- `Todo`, `TodoLink`, `TodoComment`, and `TodoAssignment`;
- `ToolProfile`, `PermissionProfile`, and `Approval`;
- `ContextSnapshot` and `CompactionCheckpoint`;
- `Artifact`, `Attachment`, and content hash;
- `UsageSample`, `RouteAttempt`, and `RunIssue`.

Editing an older user message creates a branch rather than mutating history. That preserves auditability and usually protects prefix-cache reuse.

Use SQLite in WAL mode for local metadata, events, todos, memory revisions, and FTS indexes, with explicit checkpoint management; keep large blobs, embedding segments, and browser captures in a content-addressed file store. WAL allows simultaneous readers and a writer on one host, which suits a desktop app, but long readers and checkpoints must be managed to prevent unchecked WAL growth. Source: [SQLite WAL](https://www.sqlite.org/wal.html).

## 5. Context and compaction engine

Treat context as a multi-part budget. For each run calculate:

```text
effective input capacity
− system and policy prefix
− tool/MCP schemas
− preserved conversation
− current attachments/retrieval
− reserved reasoning/output
− safety margin
= remaining usable context
```

The per-model context profile contains maximum input, maximum output, tokenizer/counting method, reasoning behavior, tool overhead, file limits, and supported compaction mode. Provider metadata is refreshed and can be overridden for custom OmniRoute models.

Compaction is explicit and inspectable:

- trigger automatically at a configurable effective-occupancy threshold;
- retain raw history outside the model context;
- insert a versioned summary/checkpoint into the new context;
- show before/after tokens and exactly what was removed or summarized;
- allow users to lock messages, decisions, files, or constraints against compaction;
- use provider-native compaction where appropriate and client compaction otherwise;
- permit rollback or branch-from-before-compaction.

The app should also prune stale tool results and reinject files by retrieval rather than repeatedly carrying entire artifacts.

## 6. Cache strategy

A high cache rate requires stable-prefix engineering and measurement; provider and conversation behavior prevents one universal guarantee.

### Stable-prefix design

- Render requests in a deterministic order: stable tool schemas, stable system/agent instructions, cached history, then volatile run data and the newest user message.
- Canonicalize JSON, tool order, descriptions, whitespace, and attachment manifests.
- Version and hash the system prompt, agent template, permission policy, and tool profile.
- Keep timestamps, trace IDs, route health, and other volatile data out of the cached prefix.
- Reuse provider conversation/session identifiers and OmniRoute sticky routing when supported.
- Reuse content hashes for attachments and subagent templates.
- Use lazy tool discovery/tool search so a large MCP catalog does not churn the root prefix.
- Treat a model, effort, thinking-mode, or tool-profile switch as a possible cache boundary and tell the user before it destroys a large reusable prefix.
- Support cache prewarming only for stable, high-value profiles and only where the provider makes it economical.

### Metrics

Show per-turn and rolling-session:

- cache-read tokens;
- cache-write tokens;
- eligible stable-prefix tokens;
- effective hit rate (`cache read / eligible prefix`);
- estimated savings and latency impact;
- miss reason when known: changed prefix, model/route switch, expired TTL, provider miss, or unsupported.

OpenAI exposes cached and cache-write token usage for supported models, Anthropic exposes cache creation/read usage, and OpenRouter passes through provider caching behavior with model-specific support. Sources: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

## 7. TPS and telemetry

Every assistant or subagent message footer should include:

```text
28.4 tok/s · 2.1s TTFT · 48.6s model · 9.2s tools · 1,384 out · 92% cached · $0.041
```

Live TPS is computed from first output token to the current output-token count. If the provider only sends authoritative usage at completion, display a `~` estimate using its tokenizer and replace it with the final value afterward. Keep TTFT, model-generation time, tool time, queue time, retry time, reasoning tokens, and end-to-end wall time separate so “slow” is diagnosable.

The Run inspector graphs throughput and labels provider retries/fallbacks. Telemetry defaults to local-only and can be exported as a sanitized run bundle.

## 8. Clean error model

Normalize errors without erasing original diagnostics:

- authentication/configuration;
- rate limit or quota;
- provider unavailable/timeout;
- route or fallback failure;
- context overflow/unsupported parameter;
- malformed stream;
- tool or MCP failure;
- denied permission;
- local process crash;
- browser/navigation failure;
- canceled or interrupted.

An inline error card says what failed, what survived, whether an automatic retry happened, and the next useful action. Typical actions are `Retry`, `Retry with fallback`, `Change model`, `Edit and resend`, and `Open diagnostics`. Automatic retries collapse into one event; they do not create duplicate assistant answers. Partial output is retained and labeled `Interrupted`. A trace ID and raw details remain available without forcing implementation jargon into the main transcript.

## 9. Settings information architecture

```text
General
Appearance
  Theme, density, prose/UI/code fonts, Markdown, motion
Providers & routes
  OpenAI, Anthropic, OpenRouter, OmniRoute, local/custom
Models & defaults
Permissions
MCP & tool profiles
Agent templates
Context, memory & compaction
Todos & work boards
Cache & performance
Files, browser & terminal
Compatibility
  Claude Code, Hermes, import/export bridges
Secrets
Keyboard & slash commands
Notifications
Privacy, retention & telemetry
Advanced diagnostics
```

Ship at least four complete themes: `Graphite` (default), `Midnight`, `Paper`, and `High contrast`. Themes are token sets, so user themes can be imported without arbitrary CSS execution.

## 10. Additional features worth including

- **Cost and task budgets** per run, thread, provider, and subagent tree, with hard-stop or ask-at-limit behavior.
- **Checkpoints, rewind, and fork** from any event, including before a tool call or compaction.
- **Run bundles** that export prompts, events, diffs, usage, and sanitized tool receipts for reproducibility.
- **Git-aware review** with branch/worktree selection, staged/unstaged diff, commit checkpoints, and rollback suggestions.
- **Memory health**: stale/conflicting-memory review, provenance audits, sensitivity checks, and a periodic “what should be forgotten?” inbox.
- **Route health**: recent TTFT/TPS/error rate by model/provider and automatic fallback rules.
- **Eval/replay lab**: replay a saved task across models or efforts and compare quality, cost, latency, cache use, and tool behavior.
- **Routines**: reusable run presets containing model, effort, tools, permissions, and an initial task. Full scheduling can wait until after MVP.
- **Notifications** for approval needed, run complete, failed, or budget threshold.
- **Local-model adapter** through an OpenAI-compatible endpoint, with capability overrides and no false claim of parity.
- **Command palette and keyboard-first navigation** for all important operations.

## 11. Delivery plan

The complete brief is larger than a credible MVP. Build it in vertical slices that each produce a usable app.

Release boundaries:

- **Internal dogfood:** Phase 1, with one provider route, durable sessions, basic permissions, todos, and curated memory.
- **User-facing macOS MVP/alpha:** Phases 0 through 2. This is the first release promised to outside testers.
- **Orchestration beta:** Phase 3, adding subagents, side forks, compatibility bridges, and broader providers.
- **General availability:** Phase 4 after crash recovery, distribution, migrations, and accessibility hardening.

### Phase 0: interaction prototype

- High-fidelity shell, rich Markdown transcript, composer, model picker, Context Orbit, memory/todo inspectors, agent tree, tool events, permission sheets, side chat, and error states using recorded fixtures.
- Keyboard and accessibility pass before backend integration.
- Validate the density with real 30–100-event transcripts, not empty-state mockups.

**Exit:** a user can click through one complete long-running run and understand every state.

### Phase 1: durable single-agent core

- Electron shell, event store, thread/project/sidebar management, pinning, attachments, secure incremental Markdown, cancel/retry, telemetry.
- OpenAI-compatible provider adapter plus first-class OmniRoute configuration.
- Dynamic model registry and context profiles.
- Plan/Act plus Manual/Workspace auto permissions.
- Persistent run checklists and a minimal curated-memory/FTS session-search loop with visible write approvals.

**Exit:** one agent can safely complete file-backed work, survive restart, and produce a reproducible event log.

### Phase 2: tools and inspection

- MCP local/remote transports and tool profiles.
- File explorer, diff/artifact preview, PTY, and isolated browser.
- Approval flow, granular permission matrix, secret vault, typed errors.
- Context Orbit inspector, attachment indexing, cache diagnostics.
- Full memory scopes, provenance/conflict review, hybrid retrieval, durable Work Boards, and built-in tool manifests.
- Previewed Claude Code/Hermes configuration, memory, skill, and MCP import/export with backups and no shared-database writes.

**Exit:** tool-heavy runs are understandable and permissions are enforced outside the model.

### Phase 3: orchestration

- Subagent templates and dynamic proposals.
- Agent tree, budgets, concurrency, steering, queueing, pause/resume.
- `/side` forks, promotion, checkpoints, rewind, and compaction.
- Additional native provider adapters and route/fallback policies.
- Claude Code and Hermes external runtime lanes through supported SDK/CLI, MCP, or ACP interfaces.

**Exit:** parallel work is controllable, auditable, and cannot exceed parent authority.

### Phase 4: hardening and distribution

- Crash/reconnect recovery, large-transcript performance, memory/index maintenance, updater, signing/notarization, migration framework.
- Accessibility, theming, Windows/Linux adaptation, telemetry opt-in, privacy controls.
- Eval/replay tooling and performance regression suite.

**Exit:** production-ready desktop releases with safe upgrades and supportable diagnostics.

For a small experienced team, a polished macOS alpha covering Phases 0–2 is roughly a 12–16 week effort; the full brief is more plausibly 5–7 months. Those estimates assume existing OmniRoute documentation and no hosted cloud sync.

## 12. Acceptance criteria

### User-facing macOS MVP/alpha

1. Model, effort, context, reasoning visibility, tool, and file controls are capability-driven; unsupported settings cannot be sent accidentally.
2. Every run can be reconstructed from its event log after an app restart.
3. Plan mode cannot invoke mutating tools, even when the selected permission profile is Full local.
4. The Context Orbit explains its number, distinguishes exact from estimated counts, and warns before overflow.
5. Per-message TPS, TTFT, tokens, cache usage, route, and cost reconcile with final provider usage where available.
6. Cache diagnostics identify the stable prefix and achieve repeatable hits on a fixed benchmark suite; no single target percentage is promised across providers.
7. MCP servers can be enabled per chat, and each sensitive tool call has an inspectable approval and result.
8. Provider or tool errors preserve partial work and offer a concrete recovery path without duplicating messages.
9. A 100,000-event thread remains responsive through transcript virtualization and batched stream rendering.
10. The app is operable by keyboard, supports reduced motion, and pairs color with text or shape for state.
11. Markdown renders lists, inline code, tables, task lists, diffs, citations, and incomplete streaming blocks without flicker or unsafe HTML execution.
12. Each injected memory is visible with scope, token cost, and provenance; users can correct or forget it, and untrusted memory cannot alter permissions.
13. Todos and work-board state survive compaction/restarts, retain a history, and remain distinct from queued chat messages.
14. Claude Code/Hermes imports produce a previewed mapping report, preserve unknown fields where possible, flag lossy conversions, and avoid writes to another agent's live private database.

### Orchestration beta additions

1. Steering lands at a defined safe boundary and queued work remains distinct from steering.
2. Subagents cannot exceed the parent's permission or budget ceiling without an explicit approval.
3. Hermes/Claude Code runtime bridges negotiate capabilities, fail closed on unknown approval events, and preserve cancellation, tool, diff, usage, and error events.
4. Side chats, forks, checkpoints, and compaction preserve their source-event provenance.

## 13. Decisions to make before implementation

These are the few choices that materially change the architecture or roadmap:

- Is v1 macOS-only, or must Windows/Linux ship concurrently?
- Is OmniRoute's API fully OpenAI-compatible, and does it expose a model registry, cache usage, route metadata, and session stickiness?
- Should the app execute tools directly on the host, inside containers, or support both from day one?
- Are user accounts/cloud sync/team sharing in scope, or is the first release strictly local-first?
- Which providers are required at launch beyond OmniRoute?
- Is memory strictly local, or must encrypted cloud sync and team-shared memory ship later?
- Does “Full local” authorize external browser/MCP submissions, or should irreversible external actions always remain a separate approval category?

My recommendation is: macOS-first, local-first, Electron, direct-host execution plus an optional container profile, OmniRoute plus one direct provider adapter, configuration import/export in the alpha, runtime bridges in the orchestration beta, and irreversible external actions kept separate from local Full access.
