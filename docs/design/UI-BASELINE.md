# UI baseline: Stitch "omniagent desktop harness" mockup

Source: `stitch_omniagent_desktop_harness (1).zip` (Dylan, 2026-08-31), vendored at
`docs/design/stitch-baseline/` — `screen.png` (the mockup), `code.html` (Tailwind-CDN
static page), `DESIGN.md` (Stitch-generated design-system doc).

This mockup is the **structural baseline** for the Lattice shell. This document is the
authoritative record of what it contains, what we adopted, what we deliberately changed,
and what it's missing relative to `docs/product-plan.md`.

---

## 1. What the mockup contains

Three fixed panes, each with its own 64px header row:

**Left pane (280px, `surface-container-low`)**
- Brand block: logo tile + "AI Harness" + pulsing "System Active" status line
- "Search threads…" input (rounded, `surface-container-high`)
- "+ New Session" button
- "RECENT THREADS" label-caps section: active thread highlighted with a 1px left accent
  bar + pin icon (`keep`); other threads show a pulsing activity dot
- Bottom "SYSTEM ENVIRONMENT" collapsible: **Models**, **MCP Modules** entries

**Center pane (`surface-container-lowest`)**
- Header: `Session:` + title in mono; settings + help icon buttons right
- Transcript (max-width 900px, centered):
  - User message: right-aligned bubble, `rounded-2xl rounded-tr-sm`, max-width 65%
  - **Thinking card**: bordered card with spinning `sync` icon, "THINKING…" label-caps in
    primary color, collapse chevron, and a left-bordered monospace `>`-prefixed log
  - **Assistant card**: bordered `surface-container` card containing prose, inline code,
    a syntax-highlighted code block (One-Dark-ish colors: `#C678DD`, `#61AFEF`, `#D19A66`,
    `#E5C07B`, `#98C379`), and a question; hover reveals a floating copy button
  - **Telemetry chips** under a hairline: `speed 124 TPS` · `memory 98% Cache Hit` ·
    `tag claude-3-opus-20240229`
- **Input dock** (absolute bottom, backdrop-blur):
  - Segmented control: **Bypass / Auto / Manual** (Auto active)
  - Textarea ("Command agent or type message… Use '/' for shortcuts."), focus glow
  - Bottom row: model chip dropdown (`claude-3.5-sonnet`), attach (+) and code buttons;
    right side: **context circle** (conic-gradient ring, "82% / Used", hover tooltip with
    breakdown: System Prompt 1.2k / Conversation 45.5k / Attached Files 58.2k / 128k Max)
    and an **Execute ⏎** primary button

**Right pane (280px)**
- Header: "Context / Files & Web" + collapse chevron (only functional JS in the file)
- "ACTIVE SUBAGENTS" section: cards for **Analyst** (active: pulse dot, model tag
  `claude-3.5-sonnet`, status line "Analyzing codebase architecture…"), **Executor** and
  **Reviewer** (idle, dimmed)
- Dashed "+ Deploy Subagent" button

### Its design tokens (from `code.html` tailwind config)

Material-3-style neutral roles: `background/surface #131313`, `surface-container-lowest
#0e0e0e`, `-low #1c1b1b`, `container #20201f`, `-high #2a2a2a`, `-highest #353535`,
`on-surface #e5e2e1`, `on-surface-variant #c4c7c8`, `outline #8e9192`, `outline-variant
#444748`, `primary #ffffff`, `error #ffb4ab`. Fonts: Inter (UI), JetBrains Mono
(body/code/telemetry), Geist (headlines/labels — declared but never loaded). Radius
default 0.25rem–0.75rem. Icons: Material Symbols Outlined via Google Fonts CDN.

## 2. Internal inconsistencies in the export (for the record)

The Stitch `DESIGN.md` and the actual `code.html` **contradict each other**:

| DESIGN.md says | code.html actually does |
|---|---|
| Pure `#000000`/`#FFFFFF`, "accents non-existent" | `#131313` neutral surface ramp, colored syntax highlighting, `error #ffb4ab` |
| All corners 0px, "strictly geometric" | `rounded-lg`/`rounded-2xl`/`rounded-full` everywhere |
| No shadows ("entirely flat") | `shadow-sm/-md/-inner`, blur glow on composer focus |
| Monochrome code highlighting via font weight | Five-color One-Dark palette |
| Geist as primary sans | Loads Inter + JetBrains Mono; Geist never loaded |

**Verdict:** treat `code.html`/`screen.png` as the real design; ignore the brutalist
`DESIGN.md` prose except as trivia.

## 3. What Lattice adopts (implemented)

- **Three-pane structure with per-pane 64px headers** replacing the single slim titlebar:
  brand block + status (left), `Session:` + title + settings/help (center), panel
  title + collapse (right)
- **Sidebar**: thread search field, New Session button, label-caps section headers,
  active-thread left accent bar, pin affordance, pulsing running dots, bottom
  "System Environment" section (Models, MCP Modules → open the model picker / settings)
- **Assistant turns as cards** on `surface-container` with hairline borders, hover copy
  action; user bubbles `rounded-2xl rounded-tr-sm`, right-aligned, max 65%
- **Thinking card** styling for the reasoning stream: spinner + label-caps header +
  collapse chevron + left-bordered mono log (replaces the plainer spine receipt)
- **Telemetry chips** (icon + mono value) instead of a bare mono text line
- **Permission segmented control** above the composer — relabeled to Lattice's presets
  (see §4)
- **Composer dock**: backdrop-blur dock, model chip with dropdown affordance, attach
  button, context ring with hover breakdown tooltip + "N% Used" text, primary
  **Execute ⏎** button
- **Right pane**: subagent card design (pulse dot, name, model tag, status line; idle
  rows dimmed) + dashed "Deploy Subagent" button — used as the Agents tab design; the
  pane keeps Lattice's inspector tabs (Context / Run / Tasks / Memory / Agents)
- **Surface ramp**: Graphite theme re-based on the mockup's neutral values
  (`#0e0e0e`→`#353535` ramp) — they're close cousins of the original Graphite grays and
  the ramp gives one more usable elevation step
- Custom 6px scrollbars

## 4. Deliberate deviations (and why)

| Mockup | Lattice | Why |
|---|---|---|
| Bypass / Auto / Manual | **Manual / Auto / Full** segmented control bound to `permissionPreset` (`manual`/`workspace`/`full`) | Same three-stop idea; Lattice names match the product plan's presets. "Full" is brass-tinted per plan ("visible in brass instead of alarming red") |
| Inter + JetBrains Mono + phantom Geist | **Instrument Sans + IBM Plex Mono** (bundled) | Product-plan typography; already licensed/bundled; JetBrains-Mono-for-body hurts long-prose readability |
| Monochrome white `primary` | Neutral surfaces + **Route violet** (models/agents) and **Signal brass** (permissions/queued) accents | The plan's two functional accents carry meaning the mockup's monochrome can't (model identity vs authority states) |
| Prose in 14px mono-ish body | 16px Instrument Sans, 78ch measure per plan §"Rich Markdown" | Readability for long answers |
| Tailwind CDN + Google-hosted Material Symbols | Hand-rolled CSS tokens + **self-hosted `material-symbols` npm font** | Renderer CSP allows no external origins; production builds must be self-contained |
| Static context circle (82% hardcoded conic) | Live **segmented** Context Orbit (per-segment colors) + the mockup's hover-tooltip breakdown | Plan's signature element is a *segmented* gauge; mockup ring is single-value |
| Model tag chip in telemetry row | Model shown in card header; telemetry chips carry TPS/TTFT/tokens/cache/cost | Model is a header-level fact; keeps chips to true metrics |
| Right pane = subagents only | Inspector keeps tabs; subagent cards live in the **Agents** tab | Plan requires Context/Run/Tasks/Memory surfaces too |
| `Execute` sends | Enter sends / steers, ⌘Enter queues; Execute button reflects run state (→ Stop while running) | Plan's steering/queueing model |

## 5. What the mockup is missing (tracked in ROADMAP)

No Plan/Act/Review mode control · no effort selector · no reasoning-fidelity labels
(raw/summary/hidden/off) · no steering/queue shelf · no error states of any kind · no
approval sheet (despite having a permission toggle) · no tool-call events in the
transcript (only a thinking log) · no model picker palette (chip only) · no settings,
memory, todos, files, browser, or run-log surfaces · no light theme · no keyboard/a11y
affordances (`cursor-help` tooltips only) · single hardcoded screen, no empty/loading
states · no window drag region (Electron traffic lights need header padding).

## 6. Icon usage

Adopted Material Symbols Outlined (self-hosted). Names used so far: `terminal`, `search`,
`add`, `keep`, `settings`, `help`, `sync`, `expand_more/less`, `chevron_right`,
`content_copy`, `speed`, `memory`, `tag`, `model_training`, `add_circle`, `code_blocks`,
`keyboard_return`, `data_object`, `account_tree`, `hub`, `donut_large`, `more_horiz`.
