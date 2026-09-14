# Transcript: how a turn reads

The transcript is the one surface a person reads for hours. Its job is to make an agentic run
legible at a glance and inspectable on demand, without ever making the reader work out what a box
is. This note records the reading model the transcript follows and why. The code is in
`src/renderer/src/components/Transcript.tsx` (turns), `TurnActivity.tsx` (the flow inside a turn),
and `turnFlow.ts` (the pure shape of that flow, unit-tested).

## The problem it replaces

The previous layout gave every event its own bordered panel. A single reply became a stack of
same-weight boxes: a mono tool cluster, a prose bubble with the model name repeated on it, another
cluster, another bubble, then a row of seven telemetry chips. Tool rows carried a thought chip
("🧠 0s"), a server tag, a purpose, a kind chip, the word "complete", a millisecond count, and a
chevron. Nothing had priority, so nothing could be skimmed, and the images a model showed were
hidden inside a folded "3 tool calls" header.

## Three tiers

**1. Prose is the turn.** What the model said renders as plain text in the reading column. No
panel, no border. The model is named once, in a small byline at the top of the turn (short model
id, thinking effort, and "interrupted"/"failed" when that is the state), never per passage.

**2. Work is one line.** Every stretch of reasoning and tool calls between two passages is one
activity block. Settled, it is a sentence: *Ran 4 commands, edited Transcript.tsx, thought 21s*,
with the span on the right and *2 failed* in red when something went wrong. Live, it is open: each
step lands as its own line under a thin rail, the current one spinning, with the arguments still
streaming in, a running command's output, or an edit's diff shown beneath it. The block folds
itself when the work finishes unless the reader opened or closed it by hand. Anything a reader
must see regardless (an image the model showed) surfaces under the folded line.

**3. Detail is a click away.** A step line says what happened (*Read* `src/app.ts`, *Ran* `npm
test`, or the model's own purpose for a command) and how it went (nothing for a quick success, the
duration when it took a second or more, *failed* / *denied* / *exit 2* in red). Opening a step shows
the arguments, the output with its exit chip, the diff, the reasoning text, and a raw JSON toggle.
Sub-second silent reasoning blips (a hosted reasoner that only reports a token count) are dropped
from the flow entirely; a bout with text, tokens, or real duration is a *Thought for 21s* step.

**Stats are one quiet line.** Wall time, output tokens, cache hit rate, and cost, in faint mono
under the turn. Throughput, time to first token, reasoning tokens, and cache writes live in the
hover text. A locally priced cost is click-to-edit, as everywhere else in the app.

## What stayed

Subagent cards, the recovery card, the error card, the ask log, steered/queued user bubbles,
incoming (subagent / background command / session) cards, and compaction summaries are unchanged
in behavior. The same `RunTimeline` renders a subagent's full log inside the Agents panel, with
`.agent-detail` overrides for the narrow column.

## Working on it

`pnpm harness` starts the transcript lab at <http://localhost:5199/harness/>: the real transcript
components mounted on threads read straight from the local database (`vite.harness.config.ts`,
read-only), outside Electron, with hot reload. Pick a thread, a theme, and a column width; choose
*replay turn N* and scrub through that run's events to reach every live state (drafting, running,
thinking, streaming) without waiting on a model. `?thread=&replay=&cursor=&theme=` reproduce a
view from the URL. Set `LATTICE_DB` to point at another database.
