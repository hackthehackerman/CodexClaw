import { strict as assert } from "assert";
import os from "os";
import path from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { loadConfig } from "../src/config/loadConfig";
import { test } from "./helpers/harness";
import { TestLogger } from "./helpers/testLogger";

test("loadConfig parses Telegram transport and multiple admins", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-config-"));
  const logger = new TestLogger();

  try {
    await mkdir(path.join(tempDir, "personality"), { recursive: true });
    await writeFile(path.join(tempDir, "personality", "soul.md"), "soul", "utf8");
    await writeFile(path.join(tempDir, "codexclaw.toml"), `
[bot]
name = "CodexClaw"
aliases = ["yanny"]
soul_path = "./personality/soul.md"
workspace_id = "main"

[policy]
default = "deny"

[[admins]]
transport_id = "primary-imessage"
conversation_id = "admin-imessage"
allowed_sender_ids = ["owner"]

[[admins]]
transport_id = "primary-telegram"
conversation_id = "123456"
allowed_sender_ids = ["123456"]

[[allow]]
kind = "direct_messages"
transport_id = "primary-telegram"
contact_scope = "any"

[[transports]]
id = "primary-imessage"
channel = "imessage"
provider = "custom"
enabled = true

[transports.triggers]
direct = "none"
group = "addressed"

[transports.config]

[[transports]]
id = "primary-telegram"
channel = "telegram"
provider = "bot-api"
enabled = true

[transports.triggers]
direct = "none"
group = "addressed"

[transports.config]
bot_token = "token"
mode = "polling"
poll_timeout_seconds = 10
allowed_updates = ["message"]

[[workspaces]]
id = "main"
cwd = "."
`, "utf8");

    const config = await loadConfig(path.join(tempDir, "codexclaw.toml"), logger);

    assert.equal(config.admins.length, 2);
    assert.equal(config.transports.length, 2);
    assert.equal(config.transports[1]?.channel, "telegram");
    if (config.transports[1]?.channel !== "telegram") {
      throw new Error("Expected Telegram transport");
    }
    assert.equal(config.host.keepAwake, true);
    assert.equal(config.transports[1].config.botToken, "token");
    assert.equal(config.transports[1].config.mode, "polling");
    assert.deepEqual(config.transports[1].config.allowedUpdates, ["message", "callback_query"]);
    assert.equal(config.transports[1].triggers.direct, "none");
    assert.equal(config.transports[1].triggers.group, "addressed");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects unsupported Telegram modes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-config-"));
  const logger = new TestLogger();

  try {
    await mkdir(path.join(tempDir, "personality"), { recursive: true });
    await writeFile(path.join(tempDir, "personality", "soul.md"), "soul", "utf8");
    await writeFile(path.join(tempDir, "codexclaw.toml"), `
[bot]
name = "CodexClaw"
aliases = ["yanny"]
soul_path = "./personality/soul.md"
workspace_id = "main"

[policy]
default = "deny"

[[admins]]
transport_id = "primary-telegram"
conversation_id = "123456"
allowed_sender_ids = ["123456"]

[[transports]]
id = "primary-telegram"
channel = "telegram"
provider = "bot-api"
enabled = true

[transports.config]
bot_token = "token"
mode = "webhook"

[[workspaces]]
id = "main"
cwd = "."
`, "utf8");

    await assert.rejects(
      () => loadConfig(path.join(tempDir, "codexclaw.toml"), logger),
      /polling/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig warns when Telegram direct-message rules use known-contact scopes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-config-"));
  const logger = new TestLogger();

  try {
    await mkdir(path.join(tempDir, "personality"), { recursive: true });
    await writeFile(path.join(tempDir, "personality", "soul.md"), "soul", "utf8");
    await writeFile(path.join(tempDir, "codexclaw.toml"), `
[bot]
name = "CodexClaw"
aliases = ["yanny"]
soul_path = "./personality/soul.md"
workspace_id = "main"

[policy]
default = "deny"

[[admins]]
transport_id = "primary-telegram"
conversation_id = "123456"
allowed_sender_ids = ["123456"]

[[allow]]
kind = "direct_messages"
transport_id = "primary-telegram"
contact_scope = "known"

[[transports]]
id = "primary-telegram"
channel = "telegram"
provider = "bot-api"
enabled = true

[transports.config]
bot_token = "token"
mode = "polling"

[[workspaces]]
id = "main"
cwd = "."
`, "utf8");

    await loadConfig(path.join(tempDir, "codexclaw.toml"), logger);

    assert.ok(
      logger.entries.some((entry) =>
        entry.level === "warn" && entry.message.includes("Telegram direct-message contact scope is unsupported"),
      ),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
