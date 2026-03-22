# CodexClaw Todo

- Add tests for route matching, trigger handling, duplicate webhook dedupe, bot-echo suppression, and one-conversation-to-one-thread behavior.
- Add a UI monitor for the human operator to inspect active runs, recent messages, thread mappings, approvals, failures, and output files.
- Add setup and operating docs for BlueBubbles, config, skills, approvals, debugging, and safe day-to-day use.
- Add SQLite migrations/schema versioning so state changes stay safe over time.
- Add clearer restart behavior so interrupted/in-flight turns are surfaced instead of becoming confusing.
- Add structured run history and audit logs so it is easier to debug what Yanny did and why.
- Add admin commands like `status`, `stop`, `pause`, `resume`, `reload config`, and `reset thread`.
- Add per-route controls like `allow_self_messages`, custom trigger aliases, and route enable/disable flags.
- Add a simple “working on it” status for long image/audio turns so the bot does not look dead.
- Add first-class tasks that can outlive a single chat message and stay attached to a Codex thread.
- Add app-owned automations/scheduling on top of Codex threads.
- Keep the adapter boundary clean so WhatsApp and other channels can be added without touching gateway logic.
- Add a proper README once the boot flow is stable.
