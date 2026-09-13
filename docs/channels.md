# Text gateway — text or call your Lattice assistant

`lattice channels` connects messaging apps and a phone line to one long-lived Lattice assistant
thread. Text it from Telegram or iMessage, call it on a real phone number, and it answers with the
full Lattice runtime behind it: tools, web access, background jobs, and long-term memory. It is
built to feel like Poke (poke.com), but it runs on your own machine and costs nothing for the
text channels.

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
standing instructions), `--progress 45s` (the "still working" text; `0` disables), and
`--busy steer|queue` (what a text does while the assistant is mid-task).

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

Text normally. Gateway commands:

| Command | Does |
| --- | --- |
| `/new` | Start a fresh conversation (the old thread stays in Lattice) |
| `/stop` | Stop everything the assistant is running |
| `/status` | Idle/working, model, pending approvals, channel health |
| `/model [name]` | Show or switch the model (substring match) |
| `/remember <fact>` | Save an approved long-term memory |
| `/pair` | Get a code to link another app to the same assistant |
| `/help` | The list |

Send photos, files and voice notes as you would to a person. Files land in the assistant's
workspace under `Inbox/` (kept 30 days), so a PDF or a spreadsheet can be opened by path, and
photos are attached to the turn. The assistant sends files back the same way: a reply containing
`![chart](/Users/you/LatticeAssistant/chart.png)` or `[report](/Users/you/Documents/report.pdf)`
arrives as a photo or document (50 MB Bot API limit). Only files in the home folder or a temp folder
are sent, never anything in a hidden folder, in `~/Library`, or named like key material; a refused
file is named in the text with the reason.

Approvals arrive as texts with Yes / No / Always buttons on Telegram. On iMessage, reply `yes`,
`no`, or `always`. Questions from the assistant can be answered by typing, or by replying with
the option number.

From scripts, cron jobs, or the assistant's own shell:

```bash
lattice channels notify "Deploy finished"
lattice channels notify "Nightly report" --file ~/reports/nightly.pdf
lattice channels pair --wait     # link another phone or app: QR + link, waits for the tap
```

## How it works

- **Transport.** The gateway attaches to the running Lattice app through the same control socket
  the CLI uses, and reconnects with backoff when Lattice restarts. `--remote <url>` (with
  `LATTICE_PASSWORD`) targets a bridge on another machine; `--embedded` boots its own runtime for a
  headless box where the desktop app is not running.
- **One thread.** Every paired handle talks to one pinned `Assistant` thread in a dedicated
  workspace. The texting contract (reply style, the memory protocol, ask-before-acting) is the
  thread's goal, so it is in the system prompt on every turn and is visible in the app. It is
  refreshed whenever `setup assistant` changes it.
- **Headers.** Each inbound text is stamped `[Texted via Telegram · Sat, Sep 12, 4:32 PM CDT]`,
  which gives the model the channel and local time. Delivery uses the same header to decide
  whether the conversation currently lives on the phone.
- **Delivery.** On every `run.completed`, and after every reconnect, the router reads the thread
  and texts settled assistant messages it has not delivered yet. Delivered ids are persisted. So
  queued turns, background-job completions, and replies that finished while the gateway was down
  all reach the phone once. Replies to messages you typed in the desktop app stay on the desktop.
- **Offline.** Adapters run even when Lattice is unreachable. A text that arrives then gets one
  "saved it" reply, and is replayed on reconnect.
- **Memory.** The assistant searches Lattice memory before answering about people, plans, or
  preferences. It saves durable facts about the owner and the people in their life as
  `Person — <name> (<relationship>): <fact>`. `/remember` writes an approved memory directly.
- **Voice.** `POST /chat/completions` takes the latest user utterance, sends it to the thread, and
  streams the run's text deltas as OpenAI chunks. It says "One sec." after 4s of silence and hands
  off to text at `maxWaitMs`. A spoken answer is marked so delivery does not text it again.

Code: `src/cli/channels/` (router, adapters, voice, gateway, files, transcribe, qr) and `src/cli/commands/channels.ts`.

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

The gateway, Lattice, and your tools all run where Lattice runs. With the Mac asleep nothing
answers. Texts are held by Telegram/Photon and delivered when the gateway polls again, while calls
fail. Options, from least to most effort:

- Keep the Mac awake on power with the lid closed (`sudo pmset -a disablesleep 1`, or Amphetamine's
  closed-display mode).
- Run the headless backend on an always-on box (see `docs/deploy/`), and run
  `lattice channels serve --embedded` there, or `--remote https://…` pointed at it.

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

## Tests

- `pnpm exec vitest run src/cli/channels src/cli/commands/channels.test.ts`: router (pairing,
  delivery, approvals, offline replay, voice hand-off, files both ways), a fake Bot API server for
  Telegram (profile, multipart uploads, downloads), a fake Spectrum SDK for Photon, real HTTP/SSE for
  the voice endpoint, the outbound file policy, local transcription, the setup command, and the QR
  encoder (its matrices were verified by decoding them with macOS CoreImage).
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
