# Texting threads, rolling context, and the runtime fixes behind them

A Lattice thread normally behaves like a coding agent at a desk: long Markdown answers, checklists,
a context that grows until auto-compaction folds all of it at once. The text gateway
([channels](channels.md)) needs the opposite, a personal assistant you text from a phone and never
restart. That is two thread settings plus a few runtime fixes that also help the desktop app.

## `replyStyle: 'texting'`

Set on a thread (`createThread` / `updateThread`), it swaps the base system prompt for the texting
prompt in `src/main/runtime/textingProfile.ts`:

- The agent's working habits stay: act without asking for reads, background slow work, batch tool
  calls, try another route when something fails, verify before claiming success.
- The voice changes: one to three short sentences, the answer first, no Markdown, a blank line per
  text bubble, details only when asked. This section closes the system prompt, after the tool
  inventory and memory, because a model weighs the end of the prompt far more than its top. The
  gateway also adds a short reminder to every message header.
- The thread's goal is rendered under "Standing instructions from the owner" instead of "north-star
  goal".
- `set_thread_title` is not offered (the thread keeps its name). The image tools stay available even
  on a lean (local-model) profile, since `show_image` is how a picture reaches the phone.
- A final reply longer than 360 characters is rewound (a `retry` event with `rewound: true`, so
  neither the transcript nor the gateway keeps it) and the model is asked once for the text-sized
  version, or for the same reply again when the person asked for something long. Measured on
  2026-09-13: DeepSeek V4 Flash led with "Proton VPN." as instructed, then added three bubbles of
  endpoints and IP addresses; the instruction alone did not hold it.
- The "promise of later work" stall nudge is off: "i'll text you when it's done" is the right way
  to end a turn while a background job runs, because the result wakes the thread.

## `contextPolicy: { mode: 'rolling', triggerTokens, keepTokens }`

A thread that never has to be restarted (`src/main/runtime/rollingContext.ts`):

- After each turn, if live history (visible text, replayed tool exchanges, images at a flat 1,200
  tokens) passes `triggerTokens`, the oldest whole turns are folded so about `keepTokens` stay
  verbatim. The cut always lands on a turn boundary: a question stays with its answer, a mid-run
  steer stays with its run, and a queued or in-flight turn is never folded.
- The folded span and the previous running summary go to the utility model (or the thread's model)
  with a "running memory" instruction: open threads first, then recent topics with exact outcomes,
  then what was learned about the owner. The new summary is stored as one `system` message dated
  just before the first kept message, and the folded rows are marked `compacted`, all in one
  transaction. A turn that builds its context at the same moment sees the history entirely before or
  entirely after the roll.
- In parallel, the same span goes through model-based memory distillation (`distillSpan` in
  `selfLearn.ts`), with extra guidance for a personal assistant: people in the owner's life, accounts
  and services, plans with expiry dates. Per-turn auto-recall then finds those facts long after the
  summary has compressed them.
- A thread past 1.5 × `triggerTokens` (a burst of turns with no gap to roll in) rolls before the turn
  instead, so the model is never sent all of it.
- `rollThread(id, { keepTokens })` rolls on demand; `keepTokens: 0` folds everything that is not in
  flight (the gateway's `/new`). It works on any thread, with or without a policy.
- Summary usage is reported as `usage` events tagged `purpose: 'roll'`, distillation as `'distill'`.

The desktop transcript shows folded messages dimmed with the summary in their place, exactly like a
manual `/compact`. `buildWireMessages` now loads only unfolded rows (`listLiveMessages`), so a thread
with thousands of folded messages costs the same per turn as a new one.

## Fixes that apply to every thread

**Messages sent mid-run land at the next step.** A steer used to be injected only at a round that
made no tool call, so during a long browser task "update?" waited until the whole tool loop ended
(four minutes in the 2026-09-12 session). It is now injected after every tool round too, with the
same bubble split, and attached images are carried (`steerWireMessage`).

**Background completions wake the thread once.** A finished background job or agent used to go
through `send()` one at a time: the first started a run, each further one steered into it, aborting
its provider stream. Now each notice is stored the moment it is deliverable (the card shows at once)
and one wake-up run starts 1.2 seconds after the last one (at most 4 seconds after the first), so
jobs that finish together are read together. A run that took the thread in the meantime already has
the notices in its history, so no second run starts.

**Notices are clipped and may be answered silently.** A job's notice carries at most 16,000
characters of output, head and tail, with the full output spilled to a file it names (it used to
carry the whole 200 KB capture into every later turn). Every notice tells the model it is automatic
and that a notice changing nothing the user needs to hear is answered with exactly `NO_REPLY`. The
desktop shows that as a quiet "no reply needed"; the gateway sends nothing
(`src/shared/view/silentReply.ts`).

**Vision for models that cannot see.** Before each request of a model whose listing says
`vision: false`, every image in the wire (photos the user attached, screenshots tools returned) is
replaced by a description from a vision model (`src/main/runtime/visionFallback.ts`). The model is
the `visionModel` setting, or else a vision sibling on the same route
(`deepseek/deepseek-v4-flash` → `deepseek/deepseek-v4-flash-vision-exp`), the utility model if it
can see, or a cheap vision model. Each image is described once, keyed by the sha256 of its bytes in
the `image_descriptions` table, so later turns replay byte-identical text and stay cacheable. Usage
is tagged `purpose: 'vision'`.

**Recall reads the right message.** Auto-recall used to skip a user message with attachments (its
content is parts, not a string) and search memory with an older message instead. It now reads and
extends the text part, and it ignores a bracketed envelope line such as the gateway's header, which
otherwise recalled every memory that mentions Telegram.

**Texting threads save tool screenshots.** An image a tool returns in a texting thread is written
to the spill directory, named by content, and the carrier message says where, so the model can
`show_image` it to the phone.

## Tests

- `src/main/runtime/rollingContext.test.ts`: cut planning (turn boundaries, steers, queued and
  protected turns, earlier summaries), the summarizer transcript, and roll outcomes (commit, failure,
  concurrency, a history that changed underneath).
- `src/main/runtime/visionFallback.test.ts`: vision model choice and description caching.
- `src/main/runtime/textingRun.test.ts`: real runs through the run manager with a scripted provider,
  covering the texting prompt and tools, the length guard, steers between tool rounds, two jobs
  waking the thread once with `NO_REPLY`, clipped notices, rolling after and before a turn,
  on-demand rolls, and vision fallback on a photo.
