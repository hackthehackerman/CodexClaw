# CodexClaw v0 Ship Plan

Goal: ship a usable, safe v0 by end of day tomorrow.

1. Freeze the v0 scope.
Ship only Telegram, iMessage/BlueBubbles, Codex app-server, the current control page, and the safe policy model. Defer WhatsApp, presence, richer UI, and any other nice-to-have work.

2. Make the package installable from npm.
Turn the repo into a real npm package, remove the current private packaging blocker, add a `bin` entry, and support a minimal CLI with:
- `codexclaw init`
- `codexclaw start`
- `codexclaw doctor`

3. Build the onboarding path.
Make `codexclaw init` generate a local `codexclaw.toml` from the example config, then add a clear README and quickstart guide for:
- Telegram bot setup
- iMessage / BlueBubbles setup
- first run

4. Keep the default policy restrictive.
Ship with safe defaults:
- `policy.default = "deny"`
- `allow_self_messages = false`
- `approval_policy = "untrusted"`
- `sandbox = "workspace-write"`
Also provide an obvious “only me” setup path for both Telegram and iMessage so users can start narrow and widen access later.

5. Use the current control page as the v0 monitor.
Do not build a larger UI before ship. Keep the existing control server and document how to use it for status, debugging, and basic config inspection.

6. Add release verification.
Before publishing, verify:
- fresh install
- `codexclaw init`
- `codexclaw doctor`
- `codexclaw start`
- one Telegram DM flow
- one iMessage flow
- control page loads
- repo hygiene pass with no private config or generated junk tracked

Recommended execution order:
1. npm packaging + CLI
2. `init`
3. `doctor`
4. README + quickstart
5. safe default presets / “only me” path
6. release smoke test and cleanup
