import { strict as assert } from "assert";
import http from "http";
import os from "os";
import path from "path";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { ConfigManager } from "../src/config/configManager";
import { loadConfig } from "../src/config/loadConfig";
import type {
  ApprovalHistoryRecord,
  RunHistoryRecord,
  SessionActivitySummary,
  StateStore,
} from "../src/storage/stateStore";
import { ControlServer } from "../src/web/controlServer";
import { test } from "./helpers/harness";
import { TestLogger } from "./helpers/testLogger";

test("ControlServer exposes overview data and updates editable config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-control-"));
  const logger = new TestLogger();
  const configPath = path.join(tempDir, "codexclaw.toml");

  try {
    await mkdir(path.join(tempDir, "personality"), { recursive: true });
    await writeFile(path.join(tempDir, "personality", "soul.md"), "soul", "utf8");
    await writeFile(configPath, `
[bot]
name = "CodexClaw"
aliases = ["yanny"]
soul_path = "./personality/soul.md"
workspace_id = "main"
allow_self_messages = false

[codex]
summary = "concise"

[storage]
db_path = "./codexclaw.db"

[web]
enabled = true
host = "127.0.0.1"
port = 4188

[policy]
default = "deny"

[[admins]]
transport_id = "primary-telegram"
conversation_id = "123456"
allowed_sender_ids = ["123456"]

[[allow]]
kind = "direct_messages"
transport_id = "primary-telegram"
contact_scope = "any"

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

[[workspaces]]
id = "main"
cwd = "."
`, "utf8");

    const config = await loadConfig(configPath, logger);
    const startedAt = new Date().toISOString();
    const session = {
      id: "session_1",
      adapterId: "primary-telegram",
      channel: "telegram",
      externalChatId: "chat-1",
      displayName: "Primary Chat",
      codexThreadId: "thread_1",
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const run = {
      id: "run_1",
      chatSessionId: "session_1",
      status: "in_progress" as const,
      startedAt,
      codexRequestJson: JSON.stringify({
        threadId: "thread_1",
        input: [{ type: "text", text: "From Demo User (111): ping", text_elements: [] }],
        cwd: "/tmp/workspace",
        model: "gpt-5.4",
        summary: "concise",
        personality: "none",
      }),
      codexResponseJson: JSON.stringify({
        turnId: "turn_1",
        finalResponse: "pong",
        attachments: [],
      }),
    };
    const approval = {
      id: "approval_1",
      runId: run.id,
      requestId: "req_1",
      kind: "command" as const,
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "item_1",
      payloadJson: "{}",
      status: "pending" as const,
    };
    const store: Pick<StateStore, "listSessionActivity" | "listRecentRuns" | "listRecentApprovals"> = {
      async listSessionActivity(_limit: number): Promise<SessionActivitySummary[]> {
        return [{
          session,
          runCount: 1,
          pendingApprovals: 1,
          latestRun: run,
        }];
      },
      async listRecentRuns(_limit: number): Promise<RunHistoryRecord[]> {
        return [{
          run,
          session,
        }];
      },
      async listRecentApprovals(_limit: number): Promise<ApprovalHistoryRecord[]> {
        return [{
          approval,
          session,
          runStatus: run.status,
        }];
      },
    };
    const configManager = new ConfigManager(configPath, config, logger);
    const server = new ControlServer({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
    }, configManager, store as StateStore, logger);

    await server.start();
    const baseUrl = server.getUrl();
    assert.ok(baseUrl);

    const overview = await requestJson("GET", `${baseUrl}/api/overview`);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.stats.totalSessions, 1);
    assert.equal(overview.body.stats.activeRuns, 1);
    assert.equal(overview.body.stats.pendingApprovals, 1);
    assert.equal(overview.body.sessions[0]?.session.displayName, "Primary Chat");
    assert.equal(overview.body.sessions[0]?.pendingApprovals, 1);
    assert.match(overview.body.runs[0]?.run.codexRequestJson, /thread_1/);
    assert.match(overview.body.runs[0]?.run.codexResponseJson, /pong/);

    const update = await requestJson("PUT", `${baseUrl}/api/config`, {
      botName: "Claw Operator",
      aliases: ["claw", "operator", "claw"],
      allowSelfMessages: true,
      model: "gpt-5.4",
      effort: "high",
      summary: "detailed",
    });

    assert.equal(update.status, 200);
    assert.equal(update.body.config.editable.botName, "Claw Operator");
    assert.deepEqual(update.body.config.editable.aliases, ["claw", "operator"]);

    const reloaded = await loadConfig(configPath, logger);
    assert.equal(reloaded.bot.name, "Claw Operator");
    assert.deepEqual(reloaded.bot.aliases, ["claw", "operator"]);
    assert.equal(reloaded.bot.allowSelfMessages, true);
    assert.equal(reloaded.codex.model, "gpt-5.4");
    assert.equal(reloaded.codex.effort, "high");
    assert.equal(reloaded.codex.summary, "detailed");
    assert.equal(config.bot.name, "Claw Operator");
    assert.deepEqual(config.bot.aliases, ["claw", "operator"]);

    await server.stop();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

function requestJson(
  method: string,
  urlString: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const url = new URL(urlString);
  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const request = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: payload ? {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      } : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: text ? JSON.parse(text) : undefined,
        });
      });
      response.on("error", reject);
    });

    request.on("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}
