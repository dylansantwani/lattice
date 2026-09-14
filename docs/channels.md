# Text gateway: text or call your Lattice assistant

`lattice channels` connects messaging apps and a phone line to one Lattice assistant that lives in a
single conversation forever. Text it from Telegram or iMessage, call it on a real phone number, and
it answers with the full Lattice runtime behind it: tools, web access, background jobs, images both
ways, and long-term memory. It is built to feel like Poke (poke.com): short plain texts, a quick "on
it" before real work, updates while it works, and no reason to ever start a new chat. It runs on your
own machine and costs nothing for the text channels.

```text
 iPhone ──► Telegram Bot API ─┐   long polling (outbound only)
 iPhone ──► Photon iMessage ──┼─► lattice channels serve ──► Lattice runtime (control socket)
 Phone  ──► Vapi number ──────┘   OpenAI-compatible SSE        one pinned "Assistant" thread
            (custom LLM) ◄── cloudflared quick tunnel            + memory_search / memory_save
```

## Why these channels (research, September 2026)

| Channel | Cost | Needs a public URL | Notes |
| --- | --- | --- | --- |
| Telegram bot | Free | No (long polling) | 2-minute setup with @BotFather. Voice notes (transcribed on-device), photos and files both ways, inline Yes/No buttons. |
| iMessage via Photon | Free tier: shared line, up to 10 users, SMS/RCS fallback | No (gRPC stream) | Blue bubbles in the Messages app without running a Mac relay. Shared lines can only reply to numbers that texted first. Pro is $25/mo; a dedicated line is $250/mo. |
| Phone calls via Vapi | Free number (1, no card); calls about $0.05/min platform fee plus voice costs, paid from $10 starting credit | Yes (the gateway starts a free Cloudflare quick tunnel) | Inbound only on free numbers. Custom LLM = this gateway. |
| SMS number (Twilio/Telnyx) | About $1–2/mo plus about $0.008/SMS plus A2P 10DLC registration ($4 brand + $15 campaign, 2–4 weeks) | Yes (webhook) | Not built: registration friction, and minors may not be able to register. |
| WhatsApp Cloud API | Per-message; replies inside the 24h window start costing on Oct 1, 2026 | Yes (webhook) | Not built. Unofficial libraries (Baileys) get numbers banned. |
| Google Voice | Free number | n/a | No API. Not automatable. |
| Self-hosted iMessage (BlueBubbles, `imsg`) | Free | No | Needs your Mac awake with Full Disk Access and a second Apple ID. Photon is simpler. |

Poke itself runs on Linq's iMessage API and Browserbase. The design choices copied here: one
continuous conversation, instant acknowledgement (read receipt, 👀, typing), long work that
finishes asynchronously and reports back, approval before outward actions, and memory about the
people in the owner's life.

Sources: [Photon pricing](https://photon.codes/pricing), [Vapi free telephony](https://docs.vapi.ai/free-telephony),
[Vapi custom LLM](https://docs.vapi.ai/customization/custom-llm/using-your-server),
[Twilio 10DLC](https://www.twilio.com/en-us/phone-numbers/a2p-10dlc),
[Telegram Bot API](https://core.telegram.org/bots/api),
[Poke on Linq](https://techcrunch.com/2026/04/08/poke-makes-ai-agents-as-easy-as-sending-a-text/),
[OpenPoke architecture](https://www.shloked.com/writing/openpoke).

## Quick start

The gateway is a CLI command. From a checkout run `pnpm build:cli` first; the examples use
`lattice` (see `lattice install`), and `node out/cli/lattice.cjs` works the same.

### 1. Name the assistant (optional)

```bash
lattice channels setup assistant --name Dylan --model deepseek/deepseek-v4-flash --timezone America/Chicago
```

Other options: `--preset manual|workspace|full` (default `workspace`), `--root DIR` (working
directory, default `~/LatticeAssistant`), `--persona "TEXT"` or `--persona @file.md` (extra
standing instructions), `--busy steer|queue` (what a text does while the assistant is mid-task),
`--progress 30s` and `--progress-every 90s` (when "still on it" updates start, and how often they
repeat; `--progress 0` turns them off), and `--rolling-trigger 64k` / `--rolling-keep 24k` (the
rolling memory window, see "One conversation, forever" below).

### 2. Telegram (free, about 2 minutes)

1. In Telegram, open **@BotFather**, send `/newbot`, pick a name and a username ending in `bot`, and
   tap the token it replies with to copy it.
2. On the Mac, run:
   ```bash
   lattice channels setup telegram
   ```
   It asks for the token without echoing it (so it stays out of scrollback and shell history), then:
   - checks the token with Telegram and saves it to `<data>/channels/config.json` (mode 0600);
   - sets the bot's `/` command menu and the description strangers see ("only answers the person who
     paired it");
   - turns on voice notes when a local faster-whisper is available (see step 5);
   - on macOS, installs and starts the gateway as a login agent, or restarts the running one, and
     waits until it answers;
   - prints a QR code and the `https://t.me/<bot>?start=<code>` link, then waits. Scan the code with
     the phone camera and tap **Start**; setup prints `Paired Telegram (…)` and exits.

   Other ways to hand over the token: `--from-clipboard` (reads `pbpaste`, so a token copied on the
   iPhone arrives through Universal Clipboard), `--token-stdin`, `--token <T>`, or
   `TELEGRAM_BOT_TOKEN`. `--no-agent` skips launchd, `--no-wait` returns right after printing the
   link, `--no-transcription` leaves voice notes off. Pasting the whole BotFather message works too;
   the token is picked out of it.

### 3. iMessage through Photon (free tier)

The fastest path borrows Hermes Agent's Photon device login (already installed here). It signs you
in through the browser, creates a "Lattice Assistant" project, registers your number, and prints
the iMessage line to text:

```bash
hermes photon setup --phone +1XXXXXXXXXX --project-name "Lattice Assistant" --skip-sidecar-install
lattice channels setup imessage --from-hermes   # imports the project id/secret, installs the SDK, verifies
```

Or sign up at <https://app.photon.codes>, create a project, add your phone number as a user, then
run `lattice channels setup imessage --project-id <id> --secret <secret>`. Pair by texting
`/pair <code>` to the line Photon assigned you.

Only run Photon in one place: if Hermes's own gateway also uses the same project, both will answer.

### 4. Phone calls through Vapi (free number, starting credit)

```bash
lattice channels setup voice --caller +1XXXXXXXXXX
```

This prints a bearer secret and the Vapi dashboard steps:

1. Sign up at <https://dashboard.vapi.ai>, then **Phone Numbers → Create → Free Vapi Number**.
2. **Provider Credentials → Custom LLM**: paste the printed secret.
3. **Assistants → Create**: Model provider "Custom LLM", model `lattice-assistant`, URL = the tunnel
   URL from the gateway log (`tunnel: voice endpoint is public at https://….trycloudflare.com`).
   Assign the assistant to the number.
4. Let the gateway re-point Vapi whenever the quick-tunnel URL changes:
   ```bash
   lattice channels setup voice --vapi-key <Vapi private key> --vapi-assistant <assistant id>
   ```

Calls are answered by the same thread and memory as your texts. The caller hears the reply as it
streams. If an answer takes longer than `--max-wait` (default 25s), the line says so and the
result arrives by text.

### 5. Voice notes

Free and on-device by default: `setup telegram` enables local transcription when it finds a Python
that can import `faster_whisper` (`$LATTICE_WHISPER_PYTHON`, Hermes Agent's venv, then `python3`).
To set it up or change it by hand:

```bash
lattice channels setup transcription --local                  # faster-whisper small, about 3s per note on Apple silicon
lattice channels setup transcription --local --model large-v3 --language en
lattice channels setup transcription --groq <GROQ_API_KEY>    # hosted free tier, whisper-large-v3-turbo
```

`--local` speaks a test sentence with `say` and transcribes it before saving, which also downloads
the model on first use. Telegram's OGG/Opus notes decode through PyAV, so no ffmpeg is needed. Any
OpenAI-compatible `/audio/transcriptions` endpoint works too (`--base-url … --model … --api-key …`).

### 6. Run it

```bash
lattice channels serve            # foreground; Ctrl-C to stop
lattice channels install-agent    # macOS: start at login, restart if it dies, pick up setup changes; logs in <data>/channels/gateway.log
lattice channels status           # config, paired owners, and the live gateway's connections
```

## Using it

Text normally, the way you would text a person. Replies come back as a few short texts, not a
report: the assistant runs on a texting prompt (see [texting threads](texting-threads.md)), and a
reply that still runs long is rewritten short before it is sent. Formatting a phone cannot show is
never sent raw: bold and headings become plain words, tables become one line per row, bullets become
"•", inline code becomes tap-to-copy monospace on Telegram, and labeled links stay tappable.

Gateway commands:

| Command | Does |
| --- | --- |
| `/new` | Clear the slate. The same conversation continues, with everything so far folded into its summary and long-term memory |
| `/stop` | Stop everything the assistant is running |
| `/status` | Idle or what it is doing, model, memory window, pending approvals, channel health |
| `/model [name]` | Show or switch the model (substring match) |
| `/remember <fact>` | Save an approved long-term memory |
| `/pair` | Get a code to link another app to the same assistant |
| `/help` | The list |

While it works:

- Anything the model writes before it starts a tool ("on it, checking seller central") is texted the
  moment the tool starts.
- If it then goes quiet, you get short updates built from what it is doing ("still on it, reading
  ebay.com", "3 min in and still working, rescan the Jellyfin library"): the first after 30 seconds
  without a text, then at most every 90 seconds, at most six per task, never while it is waiting on
  your yes or no.
- A text you send mid-task reaches the model at its next step, even in the middle of a long run of
  tool calls. If the model has not answered it within 15 seconds, the gateway tells you where things
  stand.
- Long jobs run in the background. When one finishes, the assistant texts the result if it matters
  and stays silent if it does not. Several jobs finishing together produce one reply, not one each.

Images and files, both ways:

- Photos, files and voice notes land in the assistant's workspace under `Inbox/` (kept 30 days).
  Photos are attached to the turn. An iPhone HEIC or a very large image is converted to a JPEG first
  (macOS `sips`), and a model that cannot see images (DeepSeek, most local models) gets a vision
  model's description of it instead.
- When the assistant shows you an image (a screenshot a browser tool took, a chart it made), it
  arrives as a photo right away. Screenshots returned by tools are saved to a temp file the model can
  hand on.
- Any other file arrives when a reply links its absolute path: `[report](/Users/you/Documents/report.pdf)`
  or `![chart](/Users/you/LatticeAssistant/chart.png)` (50 MB Bot API limit). Only files in the home
  folder or a temp folder are sent, never anything in a hidden folder, in `~/Library`, or named like
  key material; a refused file is named in the text with the reason.

Approvals arrive as texts with Yes / No / Always buttons on Telegram. On iMessage, reply `yes`,
`no`, or `always`. Questions from the assistant can be answered by typing, or by replying with
the option number.

From scripts, cron jobs, or the assistant's own shell:

```bash
lattice channels notify "Deploy finished"
lattice channels notify "Nightly report" --file ~/reports/nightly.pdf
lattice channels pair --wait     # link another phone or app: QR + link, waits for the tap
lattice channels roll            # fold older conversation into the summary and memory now
lattice channels roll --keep 0   # the same as texting /new
```

## How it works

- **Transport.** The gateway attaches to the running Lattice app through the same control socket
  the CLI uses, and reconnects with backoff when Lattice restarts. `--remote <url>` (with
  `LATTICE_PASSWORD`) targets a bridge on another machine; `--embedded` boots its own runtime for a
  headless box where the desktop app is not running.
- **One conversation, forever.** Every paired handle talks to one pinned `Assistant` thread. It is a
  `texting` thread with a `rolling` context policy, both runtime features (see
  [texting threads](texting-threads.md)). Once the thread's live history passes 64k tokens, its
  oldest whole turns are folded into a running summary and, in the same pass, mined for long-term
  memories, keeping about the last 24k tokens verbatim. That happens right after a reply, so a text
  never waits for it. Memories that match a new text are recalled into it automatically, so a fact
  from weeks ago is still there after the summary has compressed it away. A thread made before this
  existed is upgraded in place on the next connect.
- **Standing instructions.** The owner's name, time zone, the message header, the Inbox path and the
  people-memory format ride in the thread's goal, which a texting thread places under "Standing
  instructions" in its system prompt. `setup assistant` refreshes it. An older Lattice build that does
  not know texting threads gets the texting voice through the goal instead.
- **Headers.** Each inbound text is stamped `[Texted via Telegram · Sat, Sep 12, 4:32 PM CDT · text back short and plain]`,
  which gives the model the channel and local time and a last-moment reminder of the voice. Delivery
  uses the same header to decide whether the conversation currently lives on the phone.
- **Delivery.** The gateway follows each run's events. Text that precedes a tool call is sent when the
  call starts; the rest is sent when the run completes, split into up to four texts at paragraph
  breaks. Already-sent words are never sent again. After a reconnect, replies that settled while the
  gateway was away are read from the runtime's event log and texted once. Delivered ids are
  persisted. Replies to messages you typed in the desktop app stay on the desktop. A reply of exactly
  `NO_REPLY` (the answer to a background notice that changes nothing) is never texted.
- **Offline.** Adapters run even when Lattice is unreachable. A text that arrives then gets one
  "saved it" reply, and is replayed on reconnect.
- **Voice.** `POST /chat/completions` takes the latest user utterance, sends it to the thread, and
  streams the run's text deltas as OpenAI chunks. It says "One sec." after 4s of silence and hands
  off to text at `maxWaitMs`. A spoken answer is marked so delivery does not text it again.

Code: `src/cli/channels/` (router, activity, textRender, adapters, voice, gateway, files, imagePrep,
transcribe, qr) and `src/cli/commands/channels.ts`; runtime side in `src/main/runtime/`
(textingProfile, rollingContext, visionFallback, runManager).

## Security model

- **Owner allowlist.** Only paired handles reach the model. Unknown senders are dropped silently,
  because a reply would confirm the line is live. Files from unpaired senders are never downloaded,
  so strangers messaging the public bot or the shared line cannot fill the disk.
- **Pairing codes.** Six digits, valid 15 minutes. After 5 wrong codes from one sender, that sender
  is ignored. After 20 wrong codes in total, the code is revoked.
- **Tool permissions.** The thread uses the `workspace` permission preset. Only read-only network
  tools (`web_search`, `web_fetch`, `fetch_image`) are pre-approved, and they are re-seeded on
  every connect. Shell, file writes, MCP tools, and anything outward-facing still ask by text.
  Change the list with `assistant.allowTools` in `config.json`.
- **Voice endpoint.** The bearer secret is the real gate (constant-time compare); treat it like a
  password. `--caller` adds a second check on the caller id Vapi reports, so other people who dial
  the number are refused. Anyone holding the secret could put a fake caller id in a request, so the
  allowlist does not replace the secret. Requests with no caller id are refused when an allowlist
  is set.
- **Local files.** `config.json` and `state.json` (bot token, Photon secret, Vapi key) are written
  0600 in `<data>/channels/`, and the control socket is 0600. While the gateway runs it is the only
  writer of `state.json` (`pair` and `owners rm` go through its socket); `setup` waits for a
  restarted gateway before issuing a pairing code so a booting gateway cannot overwrite it. Files the
  owner sends are kept in `<workspace>/Inbox` for 30 days.
- **Outbound files.** Files only ever go to the paired owner, but they still land on Telegram's (or
  Photon's) servers, so a prompt-injected "send me ~/.ssh/id_ed25519" is refused: see the file rules
  under "Using it".
- **The bot is public.** Anyone can find a bot by username. Its profile says it answers only its
  owner, strangers get no reply, and pairing needs the six-digit code shown on the Mac.

## Keeping it reachable

By default the gateway runs on the Mac (launch agent `com.lattice.channels`) and a second agent
(`com.pulsecore.lattice-awake`, `caffeinate -s`) keeps the Mac from sleeping — which only works on AC
power and burns power all night. With the Mac asleep nothing answers: texts are held by Telegram/Photon
and delivered when the gateway polls again, calls fail.

**The power-efficient way: run the gateway in the relay container.** Once the relay is installed
(`relay/install.sh`, see `relay/README.md`), move the gateway with

```bash
bash ~/lattice/scripts/channels-to-relay.sh --check   # preflight
bash ~/lattice/scripts/channels-to-relay.sh           # move it; --back undoes it
```

It installs `lattice-channels.service` in CT 149, running `lattice --remote http://127.0.0.1:8973
channels serve` against the relay edge: the edge routes to the Mac while the Mac is up and to the
cloud replica while it sleeps, and the relay keeps the conversation thread and memory in sync both
ways. The script retires the Mac's gateway agent (Telegram allows one poller per bot token) and the
caffeinate agent, so the Mac sleeps normally. While it sleeps the assistant runs on the cloud replica:
API-key models only (the texting thread's model should be one, e.g. `deepseek/deepseek-v4-flash`);
local models, the 5080 lane and Claude/Codex OAuth are back the moment the Mac wakes.

Other options: keep the Mac awake on power with the lid closed (`sudo pmset -a disablesleep 1`, or
Amphetamine's closed-display mode); or run the headless backend on any always-on box (`docs/deploy/`)
with `lattice channels serve --embedded` there.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No reply at all | `lattice channels status`: is the gateway running and `runtime: attached`? Is the sender listed under `owners`? |
| "Lattice isn't reachable" | The app is quit or restarting. The text is queued and replays automatically. |
| Telegram `409 Conflict` in the log | Another process is polling the same bot token. Stop it. |
| `setup telegram` says the token was rejected | Copy it again from @BotFather (`/mybots` → your bot → API Token). Revoking a token there invalidates the old one. |
| Voice notes answered with "can't listen" | `lattice channels status` shows `transcription: off`. Run `lattice channels setup transcription --local`. |
| "couldn't send <file>" | The reply linked a file in a hidden folder, `~/Library`, outside home/temp, or over 50 MB. |
| Photon "Target not allowed" | Shared lines cannot start conversations. Text the line first. |
| Calls say "this line is private" | The caller id does not match `--caller`, or Vapi sent none. |
| Replies landed on the desktop only | The last message you typed was in the app. Text once to move the conversation back to the phone. |
| Replies are long reports again | `lattice channels status` shows `texting: false` under the gateway: the Lattice app predates texting threads. Update Lattice.app; the gateway upgrades the thread on the next connect. |
| "what did we talk about yesterday" draws a blank | Check the thread in the app: a summary message stands in for folded turns. Memories from folded turns show in the Memory tab. `lattice channels roll` forces a fold now. |
| Photos are answered with "I can't see images" | No vision-capable model is listed on your providers, or the automatic pick fails. Choose one under Settings → Vision fallback model. |

## Tests

- `pnpm exec vitest run src/cli/channels src/cli/commands/channels.test.ts`: router (pairing,
  delivery, approvals, offline replay, voice hand-off, files both ways, heads-up texts sent when a
  tool starts, no repeated words, `NO_REPLY`, status updates and their holds, the mid-task status,
  shown images, catch-up from the runtime event log, `/new` as a roll, older runtimes), the text
  renderer (tables, entities, UTF-16 offsets, bubbles), tool activity phrases, image conversion, a
  fake Bot API server for Telegram (profile, entities, multipart uploads, downloads), a fake Spectrum
  SDK for Photon, real HTTP/SSE for the voice endpoint, the outbound file policy, local
  transcription, the setup and roll commands, and the QR encoder (its matrices were verified by
  decoding them with macOS CoreImage).
- The runtime side is covered in [texting threads](texting-threads.md#tests).
- The end-to-end run on 2026-09-12 (evening) drove the real gateway process against the live app
  with a scripted Bot API: setup from stdin, pairing by `/start`, a text answered in 2.2s, a voice
  note transcribed locally and answered in 4.2s, a document read from `Inbox/`, an assistant reply
  with `![](path)` uploaded as a photo, `/status`, `notify --file`, and `status` (18/18). A second run
  in a real pseudo-terminal covered the hidden prompt, the terminal QR (decoded from the terminal
  output), the launchd agent, pairing, a restart on config change, and an answer after it (11/11).
- The end-to-end run on 2026-09-12 used the live app, a fake Telegram server, and a scratch data
  directory whose `runtime.json` pointed at the live control socket. All 22 checks passed: offline
  pairing → offline notice → reconnect → replayed turn answered; model reply in about 2s;
  `web_fetch` without an approval prompt; `/status`; streamed voice answer ("Paris.", 1.9s) not
  double-texted; unknown caller refused; `status` and `notify` over the control socket.
