<div align="center">
  <h1>CodexClaw</h1>
  <p><em>Run Codex through your favorite messenger.</em></p>
</div>

CodexClaw is a thin orchestration layer on top of `codex app-server`. It lets you control Codex through chat surfaces like Telegram and iMessage, while keeping the Codex setup you already have: your skills, model defaults, workspace access, etc.

## Requirements

- Node.js 18+
- `codex` installed and authenticated
- at least one messaging transport configured
  - Telegram bot token, or
  - BlueBubbles server on a Mac with Messages configured

## Install

```bash
npm install -g @yansen/codexclaw
```

## Quickstart

```bash
codexclaw init
codexclaw start
```

`codexclaw init` is interactive by default. It can also take preset flags if you already know your transport details.
By default it creates and uses:

- `~/.codexclaw/codexclaw.toml`
- `~/.codexclaw/personality/soul.md`
- `~/.codexclaw/state/codexclaw.db`

If you have both options available, start with Telegram first. It is the faster, simpler v0 setup.

If you want a project-local setup instead, pass `--config /path/to/codexclaw.toml` to both `init` and `start`.

Environment overrides:

- `CODEXCLAW_HOME`
- `CODEXCLAW_CONFIG_PATH`
- `CODEXCLAW_STATE_DIR`

See the full setup guide in [docs/quickstart.md](docs/quickstart.md).

## Config

The main config lives at `~/.codexclaw/codexclaw.toml`.

The most important controls are:

- `[[transports]]`: how CodexClaw connects to Telegram or iMessage
- `[[allow]]`: who is allowed to talk to the bot
- `[[deny]]`: explicit blocks
- `[[admins]]`: who can approve risky actions

By default, access is narrow:

- `policy.default = "deny"`
- nobody can message the bot until you add an allow rule
- if approvals are enabled, only configured admin routes can approve them

On macOS, the generated config also defaults to:

```toml
[host]
keep_awake = true
```

That makes `codexclaw start` run under `caffeinate` so the bot keeps serving messages while the process is running.

### Add Telegram

Enable the Telegram transport and add your bot token:

```toml
[[transports]]
id = "primary-telegram"
channel = "telegram"
provider = "bot-api"
enabled = true

[transports.triggers]
direct = "none"
group = "addressed"

[transports.config]
bot_token = "YOUR_TELEGRAM_BOT_TOKEN"
mode = "polling"
poll_timeout_seconds = 30
allowed_updates = ["message", "callback_query"]
```

Allow one Telegram DM:

```toml
[[allow]]
kind = "conversation"
transport_id = "primary-telegram"
conversation_id = "123456789"
label = "my Telegram DM"
```

To allow another Telegram user, add another `[[allow]]` block with that chat's `conversation_id`.

### Add iMessage

Enable the BlueBubbles transport:

```toml
[[transports]]
id = "primary-imessage"
channel = "imessage"
provider = "bluebubbles"
enabled = true

[transports.triggers]
direct = "addressed"
group = "addressed"

[transports.config]
server_url = "http://127.0.0.1:1234"
password = "YOUR_BLUEBUBBLES_PASSWORD"
webhook_listen_host = "127.0.0.1"
webhook_listen_port = 4101
webhook_path = "/webhooks/bluebubbles"
webhook_token = "replace-with-random-secret"
auto_register_webhook = true
allowed_event_types = ["new-message", "updated-message"]
```

Allow one iMessage conversation:

```toml
[[allow]]
kind = "conversation"
transport_id = "primary-imessage"
conversation_id = "any;-;+15555550123"
label = "my iMessage DM"
```

To allow another person or group on iMessage, add another `[[allow]]` block with that conversation's `conversation_id`.

### Permission Controls

Allow one owner to approve actions:

```toml
[[admins]]
transport_id = "primary-telegram"
conversation_id = "123456789"
allowed_sender_ids = ["123456789"]
command_format = "strict"
```

Block someone explicitly:

```toml
[[deny]]
kind = "sender"
transport_id = "primary-telegram"
sender_id = "999999999"
label = "blocked user"
```

## Control Page

By default, the local control page is served at:

```text
http://127.0.0.1:4188
```

Use it for:

- recent runs
- pending approvals
- session activity
- current config snapshot

## Safe Defaults

The recommended v0 posture is:

- `policy.default = "deny"`
- `allow_self_messages = false`
- `approval_policy = "on-request"`
- `sandbox = "workspace-write"`
- `network_access = "restricted"`
- groups use `addressed` triggers unless you intentionally want ambient replies

Start with one explicit chat. Widen access only after the bot is behaving the way you want.
