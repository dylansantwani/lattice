# Read aloud (text-to-speech)

Lattice can read replies aloud. Everything runs on the Mac: nothing is sent to the PC 5080.

## Using it

- Every finished reply has a speaker button next to Copy. Click it to read the reply; click again
  (the button turns into a stop icon) to stop. Starting another reply stops the current one.
- `/read` reads the latest reply, or stops reading if something is playing.
- `/autoread` toggles reading each reply aloud as it finishes in the open thread. The same switch is in
  Settings → Voice. Only replies that finish while you are in the thread are read, never the history of
  a thread you open.
- Code blocks are announced as "code block" instead of read out (Settings → Voice → Skip code blocks).
  Tables are skipped, links read as their label, and URLs are shortened to their host.

## Voices

**System voices** (default) use macOS's built-in speech through the Web Speech API. They work offline,
cost nothing, and start instantly. Pick a voice and speed in Settings → Voice. For much better quality,
download an Enhanced or Premium voice in System Settings → Accessibility → Spoken Content → System voice
→ Manage Voices; it appears in Lattice's list after a restart.

**OpenAI-compatible endpoint** sends each sentence to an `/audio/speech` endpoint and plays the audio as
it arrives, fetching the next sentence while the current one plays. If the endpoint fails before
anything is heard, Lattice says so once and reads the reply with the system voice instead.

- **Kokoro (local, free):** a small, natural-sounding model that runs comfortably on the Mac's CPU. For
  example, run [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) on this Mac, which serves
  `http://127.0.0.1:8880/v1`, then choose the Kokoro preset and click **Load voices**.
- **OpenAI:** choose the OpenAI preset and paste an API key (`gpt-4o-mini-tts`, voices such as `alloy`).

The main process makes the request, so the API key stays out of the renderer. Remote clients (the iOS
bridge) only see whether a key is set.

## Implementation

| Piece | File |
| --- | --- |
| Settings shape, markdown-to-speech text, sentence chunking | `src/shared/speech.ts` |
| Endpoint synthesis and voice listing (main process) | `src/main/speech.ts`, API `synthesizeSpeech` / `listSpeechVoices` |
| Playback engines, stop and fallback logic | `src/renderer/src/speech/speaker.ts` |
| React hooks, auto-read | `src/renderer/src/speech/useSpeech.ts`, `autoRead.ts` |
| Speaker button, Settings → Voice, `/read` and `/autoread` | `Transcript.tsx`, `Settings.tsx`, `commands.ts` |

The renderer's Content-Security-Policy allows `media-src blob: data:` so synthesized audio can play.
