#!/usr/bin/env node
import { promises as fs } from "fs";
import http from "http";
import https from "https";
import path from "path";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import type { BlueBubblesIMessageTransportConfig, CodexClawConfig, TelegramTransportConfig } from "./config/schema";
import { loadConfig } from "./config/loadConfig";
import { startApp, resolveConfigPath } from "./index";
import { createLogger } from "./logger";

type CommandName = "start" | "init" | "doctor" | "help";

interface ParsedArgs {
  command: CommandName;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

interface DoctorCheck {
  status: "pass" | "warn" | "fail";
  label: string;
  detail: string;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  switch (parsed.command) {
    case "start":
      await runStart(parsed);
      return;
    case "init":
      await runInit(parsed);
      return;
    case "doctor":
      await runDoctor(parsed);
      return;
    case "help":
      printHelp();
      return;
  }
}

async function runStart(parsed: ParsedArgs): Promise<void> {
  const explicitConfig = readStringFlag(parsed, "config") ?? parsed.positionals[0];
  await startApp(explicitConfig);
}

async function runInit(parsed: ParsedArgs): Promise<void> {
  const targetInput = readStringFlag(parsed, "config") ?? parsed.positionals[0];
  const force = readBooleanFlag(parsed, "force");
  const configPath = resolveInitTarget(targetInput);
  const baseDir = path.dirname(configPath);
  const personalityDir = path.join(baseDir, "personality");
  const soulPath = path.join(personalityDir, "soul.md");
  const varDir = path.join(baseDir, "var");

  if (!force) {
    await assertPathDoesNotExist(configPath, "Config file already exists");
    await assertPathDoesNotExist(soulPath, "Soul file already exists");
  }

  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(personalityDir, { recursive: true });
  await fs.mkdir(varDir, { recursive: true });

  const packageRoot = path.resolve(__dirname, "..");
  const configTemplatePath = path.join(packageRoot, "templates", "codexclaw.toml");
  const soulTemplatePath = path.join(packageRoot, "templates", "soul.md");

  const configTemplate = await fs.readFile(configTemplatePath, "utf8");
  const soulTemplate = await fs.readFile(soulTemplatePath, "utf8");

  const renderedConfig = configTemplate
    .replace(/__WORKSPACE_CWD__/g, escapeTomlString(process.cwd()))
    .replace(/__GENERATED_WEBHOOK_TOKEN__/g, randomBytes(16).toString("hex"));

  await fs.writeFile(configPath, renderedConfig, "utf8");
  await fs.writeFile(soulPath, soulTemplate, "utf8");

  console.log(`Created ${configPath}`);
  console.log(`Created ${soulPath}`);
  console.log("");
  console.log("Next steps:");
  console.log(`1. Edit ${configPath} and enable one transport.`);
  console.log("2. Add one narrow allow rule so only you can message Yanny.");
  console.log("3. If you keep approval_policy = \"untrusted\", add an admin route.");
  console.log("4. Run: codexclaw doctor");
  console.log("5. Run: codexclaw start");
}

async function runDoctor(parsed: ParsedArgs): Promise<void> {
  const logger = createLogger("codexclaw:doctor");
  const explicitConfig = readStringFlag(parsed, "config") ?? parsed.positionals[0];
  const configPath = resolveConfigPath(explicitConfig);
  const checks: DoctorCheck[] = [];

  let config: CodexClawConfig;
  let rawText: string;

  try {
    rawText = await fs.readFile(configPath, "utf8");
  } catch {
    printDoctorResults([{
      status: "fail",
      label: "config",
      detail: `Config file not found at ${configPath}`,
    }]);
    process.exitCode = 1;
    return;
  }

  try {
    config = await loadConfig(configPath, logger.child("config"));
    checks.push({
      status: "pass",
      label: "config",
      detail: `Loaded ${configPath}`,
    });
  } catch (error) {
    printDoctorResults([{
      status: "fail",
      label: "config",
      detail: error instanceof Error ? error.message : String(error),
    }]);
    process.exitCode = 1;
    return;
  }

  if (await pathExists(config.bot.soulPath)) {
    checks.push({
      status: "pass",
      label: "soul",
      detail: `Found ${config.bot.soulPath}`,
    });
  } else {
    checks.push({
      status: "fail",
      label: "soul",
      detail: `Missing soul file at ${config.bot.soulPath}`,
    });
  }

  checks.push(await checkCodexCommand(config.codex.command));

  const enabledTransports = config.transports.filter((transport) => transport.enabled);
  if (enabledTransports.length === 0) {
    checks.push({
      status: "fail",
      label: "transports",
      detail: "No transports are enabled. Enable Telegram or iMessage before starting.",
    });
  } else {
    checks.push({
      status: "pass",
      label: "transports",
      detail: `Enabled transports: ${enabledTransports.map((transport) => transport.id).join(", ")}`,
    });
  }

  if (config.policy.default === "deny" && config.allow.length === 0) {
    checks.push({
      status: "fail",
      label: "policy",
      detail: "No allow rules are configured, so nobody can talk to Yanny.",
    });
  } else {
    checks.push({
      status: "pass",
      label: "policy",
      detail: `default=${config.policy.default}, allow_rules=${config.allow.length}, deny_rules=${config.deny.length}`,
    });
  }

  if (config.codex.approvalPolicy !== "never" && config.admins.length === 0) {
    checks.push({
      status: "warn",
      label: "approvals",
      detail: "No admin routes configured. Approval requests will be auto-declined.",
    });
  } else {
    checks.push({
      status: "pass",
      label: "approvals",
      detail: config.codex.approvalPolicy === "never"
        ? "Approval policy disabled"
        : `Configured admin routes: ${config.admins.length}`,
    });
  }

  const placeholderWarnings = findPlaceholderWarnings(rawText, config);
  checks.push(...placeholderWarnings);

  for (const transport of enabledTransports) {
    if (transport.channel === "telegram" && transport.provider === "bot-api") {
      checks.push(await checkTelegramTransport(transport));
      continue;
    }

    if (transport.channel === "imessage" && transport.provider === "bluebubbles") {
      checks.push(await checkBlueBubblesTransport(transport));
      continue;
    }

    checks.push({
      status: "warn",
      label: `${transport.id}`,
      detail: `No doctor checks implemented for ${transport.channel}/${transport.provider}`,
    });
  }

  for (const admin of config.admins) {
    const transport = config.transports.find((candidate) => candidate.id === admin.transportId);
    if (!transport?.enabled) {
      checks.push({
        status: "warn",
        label: "admin",
        detail: `Admin route ${admin.transportId}:${admin.conversationId} references a disabled transport`,
      });
    }
  }

  printDoctorResults(checks);
  if (checks.some((check) => check.status === "fail")) {
    process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log("CodexClaw");
  console.log("");
  console.log("Usage:");
  console.log("  codexclaw init [path]");
  console.log("  codexclaw doctor [path]");
  console.log("  codexclaw start [path]");
  console.log("");
  console.log("Options:");
  console.log("  --config <path>   Use an explicit config path");
  console.log("  --force           Overwrite files during init");
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  let command: CommandName | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "-h" || value === "--help") {
      command = "help";
      continue;
    }

    if (value.startsWith("--")) {
      const [name, inlineValue] = value.slice(2).split("=", 2);
      if (inlineValue !== undefined) {
        flags.set(name, inlineValue);
        continue;
      }

      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }

    if (!command && isCommandName(value)) {
      command = value;
      continue;
    }

    positionals.push(value);
  }

  return {
    command: command ?? "start",
    positionals,
    flags,
  };
}

function isCommandName(value: string): value is CommandName {
  return value === "start" || value === "init" || value === "doctor" || value === "help";
}

function readStringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function readBooleanFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

function resolveInitTarget(input?: string): string {
  if (!input) {
    return path.resolve(process.cwd(), "codexclaw.toml");
  }

  const resolved = path.resolve(input);
  return path.extname(resolved) === ".toml"
    ? resolved
    : path.join(resolved, "codexclaw.toml");
}

async function assertPathDoesNotExist(targetPath: string, message: string): Promise<void> {
  if (await pathExists(targetPath)) {
    throw new Error(`${message}: ${targetPath}. Re-run with --force to overwrite.`);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\");
}

function printDoctorResults(checks: DoctorCheck[]): void {
  for (const check of checks) {
    const prefix = check.status === "pass"
      ? "PASS"
      : check.status === "warn"
        ? "WARN"
        : "FAIL";
    console.log(`${prefix} ${check.label}: ${check.detail}`);
  }
}

async function checkCodexCommand(command: string[]): Promise<DoctorCheck> {
  const executable = command[0];
  const args = [...command.slice(1), "--help"];

  return await new Promise<DoctorCheck>((resolve) => {
    const child = spawn(executable, args, {
      stdio: "ignore",
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        status: "warn",
        label: "codex",
        detail: `Timed out while checking ${[executable, ...args].join(" ")}`,
      });
    }, 5000);

    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        status: "fail",
        label: "codex",
        detail: `Failed to execute ${executable}: ${error.message}`,
      });
    });

    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        status: code === 0 || code === 1 ? "pass" : "warn",
        label: "codex",
        detail: `Executed ${[executable, ...args].join(" ")} (exit ${code ?? "unknown"})`,
      });
    });
  });
}

async function checkTelegramTransport(transport: TelegramTransportConfig): Promise<DoctorCheck> {
  if (looksLikePlaceholder(transport.config.botToken)) {
    return {
      status: "fail",
      label: transport.id,
      detail: "Telegram bot token is still a placeholder",
    };
  }

  try {
    const result = await requestJson<{
      ok: boolean;
      result?: { username?: string };
      description?: string;
    }>(`https://api.telegram.org/bot${transport.config.botToken}/getMe`);

    if (!result.ok) {
      return {
        status: "fail",
        label: transport.id,
        detail: result.description ?? "Telegram getMe failed",
      };
    }

    return {
      status: "pass",
      label: transport.id,
      detail: `Telegram bot is reachable as @${result.result?.username ?? "unknown"}`,
    };
  } catch (error) {
    return {
      status: "fail",
      label: transport.id,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkBlueBubblesTransport(transport: BlueBubblesIMessageTransportConfig): Promise<DoctorCheck> {
  if (looksLikePlaceholder(transport.config.password)) {
    return {
      status: "fail",
      label: transport.id,
      detail: "BlueBubbles password is still a placeholder",
    };
  }

  try {
    const url = new URL("/api/v1/contact", transport.config.serverUrl);
    url.searchParams.set("password", transport.config.password);
    await requestJson(url.toString());
    return {
      status: "pass",
      label: transport.id,
      detail: `BlueBubbles is reachable at ${transport.config.serverUrl}`,
    };
  } catch (error) {
    return {
      status: "fail",
      label: transport.id,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function findPlaceholderWarnings(rawText: string, config: CodexClawConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  if (rawText.includes("replace-with-")) {
    checks.push({
      status: "warn",
      label: "placeholders",
      detail: "Config still contains replace-with-* placeholder values",
    });
  }

  if (rawText.includes("GROUP_CHAT_GUID") || rawText.includes("ADMIN_CHAT_GUID") || rawText.includes("OWNER_HANDLE_OR_EMAIL")) {
    checks.push({
      status: "warn",
      label: "placeholders",
      detail: "Config still contains example conversation or admin placeholder values",
    });
  }

  if (config.workspaces.some((workspace) => workspace.cwd === "/absolute/path/to/workspace")) {
    checks.push({
      status: "fail",
      label: "workspace",
      detail: "Workspace path is still the example placeholder",
    });
  }

  return checks;
}

function looksLikePlaceholder(value: string): boolean {
  return value.includes("replace-with") || value.includes("YOUR_") || value.includes("ADMIN_CHAT_GUID");
}

async function requestJson<T>(urlString: string): Promise<T> {
  const url = new URL(urlString);
  const transport = url.protocol === "https:" ? https : http;

  return await new Promise<T>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "GET",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`Request failed (${response.statusCode ?? "unknown"}): ${body || "no body"}`));
            return;
          }

          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("error", reject);
    request.end();
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
