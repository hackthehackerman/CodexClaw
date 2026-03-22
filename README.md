# CodexClaw

Thin orchestration layer on top of `codex app-server`.

CodexClaw lets you run a Codex-powered assistant through messaging transports like:
- Telegram
- iMessage via BlueBubbles

It handles:
- transport adapters
- access policy and allowlists
- one chat = one Codex thread
- per-thread queueing
- approvals
- a small local control page for status and debugging

## v0 Scope

CodexClaw v0 is intentionally narrow:
- Telegram Bot API
- iMessage through BlueBubbles
- local SQLite state
- local control page

It does not try to be a general multi-agent or multi-runtime platform yet.

## Requirements

- Node.js 18+
- `codex` installed and authenticated
- at least one messaging transport configured
  - Telegram bot token, or
  - BlueBubbles server on a Mac with Messages configured

## Install

```bash
npm install -g codexclaw
```

## Quickstart

From the workspace where you want CodexClaw to run:

```bash
codexclaw init
codexclaw start
```

Fastest safe presets:

```bash
codexclaw init --telegram-chat 123456789 --telegram-bot-token "$TELEGRAM_BOT_TOKEN"
codexclaw init --imessage-chat 'any;-;+15555550123' --bluebubbles-password "$BLUEBUBBLES_PASSWORD" --imessage-admin-sender '+15555550123'
```

`codexclaw init` creates:
- `codexclaw.toml`
- `personality/soul.md`

The generated config starts closed by default:
- `policy.default = "deny"`
- no broad allow rules
- transports disabled until you opt in

That means nobody can message Yanny until you explicitly configure access.

## First Run

1. Edit `codexclaw.toml`
2. Enable one transport
3. Add one narrow allow rule so only you can message it
4. If you keep `approval_policy = "untrusted"`, add an admin route
5. Run `codexclaw start`

See the full setup guide in [docs/quickstart.md](docs/quickstart.md).

## Commands

```bash
codexclaw init
codexclaw start
```

You can also pass an explicit config path:

```bash
codexclaw start --config /path/to/codexclaw.toml
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
- `approval_policy = "untrusted"`
- `sandbox = "workspace-write"`
- groups use `addressed` triggers unless you intentionally want ambient replies

Start with one explicit chat. Widen access only after the bot is behaving the way you want.
