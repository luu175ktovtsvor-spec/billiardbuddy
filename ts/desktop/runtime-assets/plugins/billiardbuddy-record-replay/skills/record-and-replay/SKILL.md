---
name: record-and-replay
description: Record a user-demonstrated BilliardBuddy desktop workflow as a redacted trace, then create a user-reviewable Skill. Use only when the user explicitly asks to record a workflow or create a Skill from a demonstration.
---

# Record and Replay

Use this capability only after the user explicitly asks to record their workflow and has stated the task they intend to demonstrate.

## Privacy and safety

- `start_recording` is the only tool that begins collection. Recording automatically expires within 30 minutes and ends immediately when the user asks to stop.
- The trace contains coarse click/scroll context, focused application labels and redacted text-input events. It never contains typed text, key codes, clipboard contents, cookies, passwords, screen video or screenshots.
- Do not ask the user to demonstrate sign-in, payment, secret entry, account-security or destructive workflows.
- `stop_recording` returns a trace to help draft instructions; it is not a macro and cannot replay coordinates.
- Draft a clear Skill that describes goals, inputs, steps, verification and required confirmations. Show it to the user for review before calling `save_recorded_skill`.
- A saved Skill does not inherit recording-time permissions. On later use, the current Computer Use, Browser and Chrome permissions apply again.

## Workflow

1. Explain the data boundary and ask the user to confirm that recording should begin.
2. Call `start_recording` with the narrow workflow purpose; do not use the default maximum when a shorter duration is sufficient.
3. End the current response and ask the user to say when the demonstration is finished. Do not sleep, poll `recording_status`, or keep an Agent turn running while recording.
4. When the user says they are done, call `stop_recording`.
5. Treat the returned trace as evidence, not a script. Confirm the intended outcome and which demonstrated values are reusable inputs. Prefer stable connectors or dedicated tools where available; use Computer Use only for UI-dependent steps.
6. Draft a discoverable Skill with goals, inputs, stable targets, verification and current approval requirements. Do not encode raw coordinates or secrets.
7. Validate and show the Skill to the user. Only after explicit approval call `save_recorded_skill` with a safe lowercase name.
