# Quickstart

This guide is the fastest safe path to a working CodexClaw install.

## 1. Install

```bash
npm install -g codexclaw
```

Make sure `codex` is installed and already authenticated on the same machine.

## 2. Initialize a local config

From the workspace where you want CodexClaw to run:

```bash
codexclaw init
```

This creates:
- `codexclaw.toml`
- `personality/soul.md`

## 3. Pick one transport first

Do not enable everything at once. For v0, get one transport working first.

Default trigger behavior is:
- direct chats: every allowed message reaches Yanny
- group chats: only messages explicitly addressed to Yanny reach it

### Telegram

Fastest “only me” path:

```bash
codexclaw init --telegram-chat 123456789 --telegram-bot-token "$TELEGRAM_BOT_TOKEN"
```

That generates:
- an enabled Telegram transport
- one narrow allow rule for your DM
- one matching admin route for approvals

Manual path:

1. Create a bot with `@BotFather`
2. Copy the bot token
3. In `codexclaw.toml`, set:
   - `[[transports]]` for Telegram to `enabled = true`
   - `bot_token` to the real token
4. Add a narrow allow rule for your own Telegram chat:

```toml
[[allow]]
kind = "conversation"
transport_id = "primary-telegram"
conversation_id = "123456789"
label = "my Telegram DM"
```

If you keep `approval_policy = "untrusted"`, add yourself as an admin too:

```toml
[[admins]]
transport_id = "primary-telegram"
conversation_id = "123456789"
allowed_sender_ids = ["123456789"]
command_format = "strict"
```

### iMessage / BlueBubbles

Fastest “only me” path:

```bash
codexclaw init --imessage-chat 'any;-;+15555550123' --bluebubbles-password "$BLUEBUBBLES_PASSWORD" --imessage-admin-sender '+15555550123'
```

That generates:
- an enabled iMessage transport
- one narrow allow rule for that conversation
- one matching admin route if you pass `--imessage-admin-sender`

Manual path:

1. Install and configure BlueBubbles Server on the Mac that runs Messages
2. Confirm BlueBubbles local API works
3. In `codexclaw.toml`, set:
   - `[[transports]]` for iMessage to `enabled = true`
   - `password` to the BlueBubbles server password
4. Add one explicit iMessage conversation allow rule:

```toml
[[allow]]
kind = "conversation"
transport_id = "primary-imessage"
conversation_id = "any;-;+15555550123"
label = "my iMessage DM"
```

If you keep `approval_policy = "untrusted"`, add your admin chat:

```toml
[[admins]]
transport_id = "primary-imessage"
conversation_id = "iMessage;-;ADMIN_CHAT_GUID"
allowed_sender_ids = ["OWNER_HANDLE_OR_EMAIL"]
command_format = "strict"
```

## 4. Keep the default policy narrow

The safe v0 path is:
- one enabled transport
- one explicit `[[allow]]` conversation rule
- one explicit `[[admins]]` route if approvals are on

Do not start with:
- all Telegram DMs
- all known iMessage contacts
- all groups

Widen later after the bot is stable.

## 5. Run the doctor

```bash
codexclaw doctor
```

or, if you only want config validation without network checks:

```bash
codexclaw doctor --offline
```

It checks:
- config loads
- soul file exists
- `codex` command is runnable
- Telegram token works if Telegram is enabled
- BlueBubbles is reachable if iMessage is enabled
- no obvious “nobody can talk to the bot” mistakes

## 6. Start CodexClaw

```bash
codexclaw start
```

By default, the control page is available at:

```text
http://127.0.0.1:4188
```

## 7. Expand carefully

After the first successful run, you can widen access by adding rules like:

```toml
[[allow]]
kind = "direct_messages"
transport_id = "primary-telegram"
contact_scope = "any"
label = "all Telegram direct messages"
```

or

```toml
[[allow]]
kind = "groups"
transport_id = "primary-imessage"
label = "all allowlisted iMessage groups"
```

But do that only after:
- the transport is stable
- your admin route works
- Yanny behaves the way you want
