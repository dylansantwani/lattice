# Wire examples

These JSON files are the canonical wire examples for the protocol. TypeScript
and Swift sides must stay consistent with them; tests in each package validate
representative shapes against `schema/`.

- `session.example.json` — a live Background Assist session (idle → observing)
- `app-state.example.json` — a `computer_get_app_state` result (Calculator)
- `action.request.click_element.example.json` — a focus-free AX press
- `action.request.type_text.example.json` — a focus-requiring action (shows `needs_focus` handling)
- `action.result.ok.example.json` — success carries the fresh observation
- `action.result.stale.example.json` — generation mismatch, no side effect
- `core.event.example.json` — canonical event envelope
- `error.example.json` — structured error envelope
