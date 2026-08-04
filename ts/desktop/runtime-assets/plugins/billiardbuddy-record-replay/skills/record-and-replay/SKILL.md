---
name: record-and-replay
description: Record a user-demonstrated BilliardBuddy desktop workflow as a bounded redacted semantic event stream, then create a user-reviewable Skill. Use only when the user explicitly asks to record a workflow or create a Skill from a demonstration.
---

# Record and Replay

Use this capability only after the user explicitly asks to record their workflow and has stated the task they intend to demonstrate.

## Privacy and safety

- `start_recording` is the only tool that begins collection. Recording automatically expires within 30 minutes and ends immediately when the user asks to stop.
- `stop_recording` returns `metadataPath` and `eventsPath`. Read both with normal filesystem tools before using the recording. `events.jsonl` is the primary evidence; `session.json` has timing, completion reason, event count and privacy metadata. The BilliardBuddy recorder does not persist the stated purpose in its state, process arguments or session file.
- `start_recording` refuses to replace an existing raw recording. Inspect and save it first when appropriate, then use `discard_recording` only after the user explicitly agrees to remove the raw evidence.
- Each event has an ordered action, redacted app/window/control identity, and only the accessibility-state fields that changed. It never contains typed text, key codes, clipboard contents, cookies, passwords, window titles, raw coordinates, screen video or screenshots. Control identifiers are one-way digests.
- Do not ask the user to demonstrate sign-in, payment, secret entry, account-security or destructive workflows.
- A recording is evidence, not a macro. It cannot replay coordinates or silently grant permissions.
- Draft a clear Skill that describes goals, inputs, steps, verification and required confirmations. Show it to the user for review before calling `save_recorded_skill`.
- A saved Skill does not inherit recording-time permissions. On later use, the current Computer Use, Browser and Chrome permissions apply again.

## Workflow

1. Explain the data boundary and ask the user to confirm that recording should begin.
2. If a prior recording exists, inspect or save it, then obtain explicit approval before `discard_recording`. Call `start_recording` with the narrow workflow purpose; do not use the default maximum when a shorter duration is sufficient.
3. End the current response and ask the user to say when the demonstration is finished. Do not sleep, poll `recording_status`, or keep an Agent turn running while recording.
4. When the user says they are done, call `stop_recording`, then read its `metadataPath` and `eventsPath`. If the recording was cancelled, do not attempt to use it or create a Skill.
5. Treat the returned semantic events as evidence, not a script. Confirm the intended outcome and which demonstrated values are reusable inputs. Prefer stable connectors or dedicated tools where available; use Computer Use only for UI-dependent steps.
6. Draft a discoverable Skill with goals, inputs, stable targets, verification and current approval requirements. Do not encode raw coordinates or secrets.
7. Validate and show the Skill to the user. Only after explicit approval call `save_recorded_skill` with a safe lowercase name. If that name already exists, preserve it and ask separately before retrying with `replace: true`; never overwrite an existing Skill implicitly.
