import { strict as assert } from "assert";
import os from "os";
import path from "path";
import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
import { spawn } from "child_process";
import { loadConfig } from "../src/config/loadConfig";
import { test } from "./helpers/harness";
import { TestLogger } from "./helpers/testLogger";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

test("init can generate a narrow Telegram-only config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-cli-"));
  const configPath = path.join(tempDir, "codexclaw.toml");

  try {
    const result = await runCli([
      "init",
      "--config",
      configPath,
      "--force",
      "--telegram-chat",
      "123456789",
      "--telegram-bot-token",
      "123456:verification-token",
    ], tempDir);

    assert.equal(result.code, 0, result.stderr || result.stdout);

    const config = await loadConfig(configPath, new TestLogger());
    const telegram = config.transports.find((transport) => transport.id === "primary-telegram");

    assert.ok(telegram);
    assert.equal(telegram?.enabled, true);
    assert.equal(config.allow.length, 1);
    assert.equal(config.allow[0]?.kind, "conversation");
    if (config.allow[0]?.kind !== "conversation") {
      throw new Error("Expected conversation allow rule");
    }
    assert.equal(config.allow[0].conversationId, "123456789");
    assert.equal(config.admins.length, 1);
    assert.equal(config.admins[0]?.conversationId, "123456789");
    assert.deepEqual(config.admins[0]?.allowedSenderIds, ["123456789"]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("doctor offline passes for generated iMessage-only config", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-cli-"));
  const configPath = path.join(tempDir, "codexclaw.toml");

  try {
    const initResult = await runCli([
      "init",
      "--config",
      configPath,
      "--force",
      "--imessage-chat",
      "any;-;+15555550123",
      "--bluebubbles-password",
      "verification-password",
      "--imessage-admin-sender",
      "+15555550123",
    ], tempDir);

    assert.equal(initResult.code, 0, initResult.stderr || initResult.stdout);

    const doctorResult = await runCli([
      "doctor",
      "--offline",
      "--config",
      configPath,
    ], tempDir);

    assert.equal(doctorResult.code, 0, doctorResult.stderr || doctorResult.stdout);
    assert.match(doctorResult.stdout, /PASS primary-imessage: Offline mode skipped BlueBubbles reachability check/);

    const rawConfig = await readFile(configPath, "utf8");
    assert.match(rawConfig, /\[\[allow\]\]/);
    assert.match(rawConfig, /\[\[admins\]\]/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function runCli(args: string[], cwd: string): Promise<CliResult> {
  await mkdir(cwd, { recursive: true });
  const cliPath = path.resolve(__dirname, "../src/cli.js");

  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}
