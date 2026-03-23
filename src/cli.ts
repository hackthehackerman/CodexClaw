#!/usr/bin/env node
import { promises as fs } from "fs";
import http from "http";
import https from "https";
import path from "path";
import { randomBytes } from "crypto";
import { spawn } from "child_process";
import { createInterface } from "readline";
import type { BlueBubblesIMessageTransportConfig, CodexClawConfig, TelegramTransportConfig } from "./config/schema";
import { loadConfig } from "./config/loadConfig";
import { startApp, resolveConfigPath } from "./index";
import { createLogger } from "./logger";
import { resolveDefaultConfigPath } from "./paths";

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

interface InitPreset {
  telegramChatId?: string;
  telegramBotToken?: string;
  telegramAdminEnabled?: boolean;
  imessageConversationId?: string;
  blueBubblesPassword?: string;
  imessageAdminSenderId?: string;
}

type InitTransportChoice = "telegram" | "imessage";

interface PromptSession {
  question(prompt: string): Promise<string>;
  close(): void;
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
  const portraitPath = path.join(personalityDir, "yanny.png");

  if (!force) {
    await assertPathDoesNotExist(configPath, "Config file already exists");
    await assertPathDoesNotExist(soulPath, "Soul file already exists");
    await assertPathDoesNotExist(portraitPath, "Portrait file already exists");
  }

  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(personalityDir, { recursive: true });

  const packageRoot = await resolvePackageRoot();
  const configTemplatePath = path.join(packageRoot, "templates", "codexclaw.toml");
  const soulTemplatePath = path.join(packageRoot, "templates", "soul.md");
  const portraitTemplatePath = path.join(packageRoot, "templates", "yanny.png");

  const configTemplate = await fs.readFile(configTemplatePath, "utf8");
  const soulTemplate = await fs.readFile(soulTemplatePath, "utf8");
  const preset = await resolveInitPreset(parsed);

  const renderedConfig = renderInitConfig(configTemplate, {
    workspaceCwd: process.cwd(),
    webhookToken: randomBytes(16).toString("hex"),
    preset,
  });

  await fs.writeFile(configPath, renderedConfig, "utf8");
  await fs.writeFile(soulPath, soulTemplate, "utf8");
  await fs.copyFile(portraitTemplatePath, portraitPath);

  console.log(`Created ${configPath}`);
  console.log(`Created ${soulPath}`);
  console.log(`Created ${portraitPath}`);
  console.log("");
  printInitNextSteps(configPath, preset);
}

async function runDoctor(parsed: ParsedArgs): Promise<void> {
  const logger = createLogger("codexclaw:doctor");
  const explicitConfig = readStringFlag(parsed, "config") ?? parsed.positionals[0];
  const configPath = resolveConfigPath(explicitConfig);
  const offline = readBooleanFlag(parsed, "offline");
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
      checks.push(await checkTelegramTransport(transport, offline));
      continue;
    }

    if (transport.channel === "imessage" && transport.provider === "bluebubbles") {
      checks.push(await checkBlueBubblesTransport(transport, offline));
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
  console.log("  codexclaw start [path]");
  console.log("");
  console.log("Defaults:");
  console.log("  config: ~/.codexclaw/codexclaw.toml");
  console.log("  soul:   ~/.codexclaw/personality/soul.md");
  console.log("  image:  ~/.codexclaw/personality/yanny.png");
  console.log("  state:  ~/.codexclaw/state/codexclaw.db");
  console.log("");
  console.log("Options:");
  console.log("  --config <path>   Use an explicit config path");
  console.log("  --force           Overwrite files during init");
  console.log("");
  console.log("Environment:");
  console.log("  CODEXCLAW_HOME         Override ~/.codexclaw");
  console.log("  CODEXCLAW_CONFIG_PATH  Override the default config path");
  console.log("  CODEXCLAW_STATE_DIR    Override the state directory");
  console.log("");
  console.log("Init presets:");
  console.log("  --telegram-chat <chat-id>              Enable Telegram and allow only that DM");
  console.log("  --telegram-bot-token <token>           Fill the Telegram bot token");
  console.log("  --imessage-chat <conversation-id>      Enable iMessage and allow only that chat");
  console.log("  --bluebubbles-password <password>      Fill the BlueBubbles server password");
  console.log("  --imessage-admin-sender <sender-id>    Reuse the iMessage chat for approvals from that sender");
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
    return resolveDefaultConfigPath();
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

async function resolvePackageRoot(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, ".."),
    path.resolve(__dirname, "..", ".."),
  ];

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "templates", "codexclaw.toml"))) {
      return candidate;
    }
  }

  throw new Error("Could not find bundled templates directory");
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

async function checkTelegramTransport(
  transport: TelegramTransportConfig,
  offline: boolean,
): Promise<DoctorCheck> {
  if (looksLikePlaceholder(transport.config.botToken)) {
    return {
      status: "fail",
      label: transport.id,
      detail: "Telegram bot token is still a placeholder",
    };
  }

  if (offline) {
    return {
      status: "pass",
      label: transport.id,
      detail: "Offline mode skipped Telegram reachability check",
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

async function checkBlueBubblesTransport(
  transport: BlueBubblesIMessageTransportConfig,
  offline: boolean,
): Promise<DoctorCheck> {
  if (looksLikePlaceholder(transport.config.password)) {
    return {
      status: "fail",
      label: transport.id,
      detail: "BlueBubbles password is still a placeholder",
    };
  }

  if (offline) {
    return {
      status: "pass",
      label: transport.id,
      detail: "Offline mode skipped BlueBubbles reachability check",
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

  const enabledTransportHasPlaceholder = config.transports.some((transport) => {
    if (!transport.enabled) {
      return false;
    }

    if (transport.channel === "telegram" && transport.provider === "bot-api") {
      return looksLikePlaceholder(transport.config.botToken);
    }

    if (transport.channel === "imessage" && transport.provider === "bluebubbles") {
      return looksLikePlaceholder(transport.config.password);
    }

    return false;
  });

  const adminHasPlaceholder = config.admins.some((admin) =>
    looksLikePlaceholder(admin.conversationId) || admin.allowedSenderIds.some(looksLikePlaceholder),
  );

  if (enabledTransportHasPlaceholder || adminHasPlaceholder) {
    checks.push({
      status: "warn",
      label: "placeholders",
      detail: "Enabled transports or admin routes still contain placeholder values",
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

async function resolveInitPreset(parsed: ParsedArgs): Promise<InitPreset> {
  const parsedPreset = parseInitPreset(parsed);
  const explicitTransport = inferInitTransport(parsedPreset);

  if (explicitTransport === "mixed") {
    throw new Error("Init flags mixed Telegram and iMessage values. Choose one transport.");
  }

  if (explicitTransport === "telegram") {
    return await promptForTelegramInit(parsedPreset);
  }

  if (explicitTransport === "imessage") {
    return await promptForIMessageInit(parsedPreset);
  }

  return await promptForInitWizard();
}

function parseInitPreset(parsed: ParsedArgs): InitPreset {
  const telegramChatId = readStringFlag(parsed, "telegram-chat");
  const telegramBotToken = readStringFlag(parsed, "telegram-bot-token");
  const imessageConversationId = readStringFlag(parsed, "imessage-chat");
  const blueBubblesPassword = readStringFlag(parsed, "bluebubbles-password");
  const imessageAdminSenderId = readStringFlag(parsed, "imessage-admin-sender");

  return {
    telegramChatId,
    telegramBotToken,
    telegramAdminEnabled: telegramChatId || telegramBotToken ? true : undefined,
    imessageConversationId,
    blueBubblesPassword,
    imessageAdminSenderId,
  };
}

function inferInitTransport(preset: InitPreset): InitTransportChoice | "mixed" | undefined {
  const hasTelegram = Boolean(preset.telegramChatId || preset.telegramBotToken);
  const hasIMessage = Boolean(
    preset.imessageConversationId ||
    preset.blueBubblesPassword ||
    preset.imessageAdminSenderId,
  );

  if (hasTelegram && hasIMessage) {
    return "mixed";
  }

  if (hasTelegram) {
    return "telegram";
  }

  if (hasIMessage) {
    return "imessage";
  }

  return undefined;
}

async function promptForInitWizard(): Promise<InitPreset> {
  const io = createPromptSession();

  try {
    console.log("CodexClaw init");
    console.log("");
    console.log("- This will generate a narrow first-run config so only you can message the bot.");
    console.log(`- By default it writes to ${resolveDefaultConfigPath()}.`);
    console.log("- Start with one transport and one allowed chat.");
    console.log("- Telegram is the fastest first setup. Use iMessage if BlueBubbles is already ready.");
    console.log("");

    const transport = await promptChoice(io, "First transport (recommended: telegram)", ["telegram", "imessage"]);
    if (transport === "telegram") {
      return await promptForTelegramInit({}, io);
    }

    return await promptForIMessageInit({}, io);
  } finally {
    io.close();
  }
}

async function promptForTelegramInit(preset: InitPreset, io?: PromptSession): Promise<InitPreset> {
  const reader = io ?? createPromptSession();
  const ownsInterface = !io;
  const cameFromFlags = Boolean(preset.telegramChatId || preset.telegramBotToken || preset.telegramAdminEnabled !== undefined);

  try {
    console.log("");
    console.log("Telegram setup");
    console.log("- Message your bot once from the Telegram account you want to allow.");
    console.log("- Need a bot token? Open https://t.me/BotFather and run /newbot.");
    console.log("- If you already have a bot, paste the token below.");

    const botToken = preset.telegramBotToken ?? await promptRequired(reader, "Telegram bot token");
    let chatId = preset.telegramChatId;

    if (!chatId) {
      const autoDetect = await promptYesNo(reader, "Detect your Telegram DM chat id from recent bot messages?", true);
      if (autoDetect) {
        console.log("- Send your bot a DM in Telegram now, then press Enter here.");
        await askQuestion(reader, "");
        const discovered = await discoverLatestTelegramPrivateChat(botToken);
        if (discovered) {
          console.log(`- Found Telegram DM: ${discovered.label} (${discovered.chatId})`);
          chatId = discovered.chatId;
        } else {
          console.log("- No recent Telegram DM was found. Paste the chat id manually.");
        }
      }
    }

    chatId = chatId ?? await promptRequired(reader, "Telegram DM chat id");
    const useSameChatForApprovals = preset.telegramAdminEnabled ?? (cameFromFlags
      ? true
      : await promptYesNo(reader, "Use the same Telegram DM for approvals?", true));

    return {
      telegramBotToken: botToken,
      telegramChatId: chatId,
      telegramAdminEnabled: useSameChatForApprovals,
      imessageConversationId: undefined,
      blueBubblesPassword: undefined,
      imessageAdminSenderId: undefined,
    };
  } finally {
    if (ownsInterface) {
      reader.close();
    }
  }
}

async function promptForIMessageInit(preset: InitPreset, io?: PromptSession): Promise<InitPreset> {
  const reader = io ?? createPromptSession();
  const ownsInterface = !io;
  const cameFromFlags = Boolean(
    preset.imessageConversationId ||
    preset.blueBubblesPassword ||
    preset.imessageAdminSenderId,
  );

  try {
    console.log("");
    console.log("iMessage / BlueBubbles setup");
    console.log("- Use one explicit chat first.");
    console.log("- Paste the conversation id from BlueBubbles or an earlier CodexClaw log.");

    const password = preset.blueBubblesPassword ?? await promptRequired(reader, "BlueBubbles server password");
    const conversationId = preset.imessageConversationId ?? await promptRequired(reader, "iMessage conversation id");
    let adminSenderId = preset.imessageAdminSenderId;

    if (!adminSenderId && !cameFromFlags) {
      const useSameChatForApprovals = await promptYesNo(reader, "Use this same iMessage chat for approvals?", true);
      if (useSameChatForApprovals) {
        adminSenderId = await promptRequired(
          reader,
          "Sender id allowed to approve in that chat (phone number, email, or handle)",
        );
      }
    }

    return {
      telegramBotToken: undefined,
      telegramChatId: undefined,
      telegramAdminEnabled: undefined,
      blueBubblesPassword: password,
      imessageConversationId: conversationId,
      imessageAdminSenderId: adminSenderId,
    };
  } finally {
    if (ownsInterface) {
      reader.close();
    }
  }
}

function renderInitConfig(
  template: string,
  options: {
    workspaceCwd: string;
    webhookToken: string;
    preset: InitPreset;
  },
): string {
  const allowBlocks = buildInitAllowBlocks(options.preset);
  const adminBlocks = buildInitAdminBlocks(options.preset);
  const telegramEnabled = Boolean(options.preset.telegramChatId || options.preset.telegramBotToken);
  const imessageEnabled = Boolean(
    options.preset.imessageConversationId ||
    options.preset.blueBubblesPassword ||
    options.preset.imessageAdminSenderId,
  );
  const approvalPolicy = chooseInitApprovalPolicy(options.preset);

  return template
    .replace(/__WORKSPACE_CWD__/g, escapeTomlString(options.workspaceCwd))
    .replace(/__GENERATED_WEBHOOK_TOKEN__/g, options.webhookToken)
    .replace(/__INIT_ALLOW_BLOCKS__/g, allowBlocks)
    .replace(/__INIT_ADMIN_BLOCKS__/g, adminBlocks)
    .replace(/__APPROVAL_POLICY__/g, approvalPolicy)
    .replace(/__IMESSAGE_ENABLED__/g, imessageEnabled ? "true" : "false")
    .replace(
      /__IMESSAGE_PASSWORD__/g,
      escapeTomlString(options.preset.blueBubblesPassword ?? "replace-with-bluebubbles-server-password"),
    )
    .replace(/__TELEGRAM_ENABLED__/g, telegramEnabled ? "true" : "false")
    .replace(
      /__TELEGRAM_BOT_TOKEN__/g,
      escapeTomlString(options.preset.telegramBotToken ?? "replace-with-telegram-bot-token"),
    );
}

function buildInitAllowBlocks(preset: InitPreset): string {
  const sections: string[] = [];

  if (preset.telegramChatId) {
    sections.push([
      '[[allow]]',
      'kind = "conversation"',
      'transport_id = "primary-telegram"',
      `conversation_id = "${escapeTomlString(preset.telegramChatId)}"`,
      'label = "my Telegram DM"',
    ].join("\n"));
  }

  if (preset.imessageConversationId) {
    sections.push([
      '[[allow]]',
      'kind = "conversation"',
      'transport_id = "primary-imessage"',
      `conversation_id = "${escapeTomlString(preset.imessageConversationId)}"`,
      'label = "my iMessage chat"',
    ].join("\n"));
  }

  if (sections.length === 0) {
    return "";
  }

  return `\n\n${sections.join("\n\n")}\n`;
}

function buildInitAdminBlocks(preset: InitPreset): string {
  const sections: string[] = [];

  if (preset.telegramChatId && inferInitTransport(preset) === "telegram" && preset.telegramAdminEnabled !== false) {
    sections.push([
      '[[admins]]',
      'transport_id = "primary-telegram"',
      `conversation_id = "${escapeTomlString(preset.telegramChatId)}"`,
      `allowed_sender_ids = ["${escapeTomlString(preset.telegramChatId)}"]`,
      'command_format = "strict"',
    ].join("\n"));
  }

  if (preset.imessageConversationId && preset.imessageAdminSenderId) {
    sections.push([
      '[[admins]]',
      'transport_id = "primary-imessage"',
      `conversation_id = "${escapeTomlString(preset.imessageConversationId)}"`,
      `allowed_sender_ids = ["${escapeTomlString(preset.imessageAdminSenderId)}"]`,
      'command_format = "strict"',
    ].join("\n"));
  }

  if (sections.length === 0) {
    return "";
  }

  return `\n\n${sections.join("\n\n")}\n`;
}

function printInitNextSteps(configPath: string, preset: InitPreset): void {
  const hasPreset = Boolean(
    preset.telegramChatId ||
    preset.telegramBotToken ||
    preset.imessageConversationId ||
    preset.blueBubblesPassword,
  );

  console.log("Next steps:");
  if (!hasPreset) {
    console.log(`- Edit ${configPath} and enable one transport.`);
    console.log("- Add one narrow allow rule so only you can message Yanny.");
    console.log("- If you keep approvals enabled, add an admin route.");
    console.log(`- Run: ${renderStartCommand(configPath)}`);
    return;
  }

  console.log(`- Review ${configPath} and replace any remaining placeholder secrets.`);
  if (preset.imessageConversationId && !preset.imessageAdminSenderId) {
    console.log("- Approval policy was set to \"never\" because no admin sender was configured.");
    console.log(`- Run: ${renderStartCommand(configPath)}`);
    return;
  }

  if (chooseInitApprovalPolicy(preset) === "never") {
    console.log("- Approval policy was set to \"never\" for first-run simplicity.");
    console.log(`- Run: ${renderStartCommand(configPath)}`);
    return;
  }

  console.log(`- Run: ${renderStartCommand(configPath)}`);
}

function renderStartCommand(configPath: string): string {
  return path.resolve(configPath) === resolveDefaultConfigPath()
    ? "codexclaw start"
    : `codexclaw start --config ${configPath}`;
}

function chooseInitApprovalPolicy(preset: InitPreset): string {
  if (!inferInitTransport(preset)) {
    return "on-request";
  }

  return hasInitAdminRoute(preset) ? "on-request" : "never";
}

function hasInitAdminRoute(preset: InitPreset): boolean {
  if (preset.telegramChatId && inferInitTransport(preset) === "telegram" && preset.telegramAdminEnabled !== false) {
    return true;
  }

  return Boolean(preset.imessageConversationId && preset.imessageAdminSenderId);
}

async function promptRequired(
  io: PromptSession,
  label: string,
): Promise<string> {
  while (true) {
    const answer = (await askQuestion(io, `${label}: `)).trim();
    if (answer.length > 0) {
      return answer;
    }
  }
}

async function promptChoice(
  io: PromptSession,
  label: string,
  choices: InitTransportChoice[],
): Promise<InitTransportChoice> {
  const renderedChoices = choices.join("/");

  while (true) {
    const answer = (await askQuestion(io, `${label} (${renderedChoices}): `)).trim().toLowerCase();
    if (answer === "telegram" || answer === "t") {
      return "telegram";
    }
    if (answer === "imessage" || answer === "i") {
      return "imessage";
    }
  }
}

async function promptYesNo(
  io: PromptSession,
  label: string,
  defaultYes: boolean,
): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";

  while (true) {
    const answer = (await askQuestion(io, `${label} ${suffix} `)).trim().toLowerCase();
    if (!answer) {
      return defaultYes;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
  }
}

async function discoverLatestTelegramPrivateChat(
  botToken: string,
): Promise<{ chatId: string; label: string } | undefined> {
  const result = await requestJson<{
    ok: boolean;
    result?: Array<{
      message?: {
        chat?: { id?: number; type?: string; first_name?: string; last_name?: string; username?: string };
        from?: { first_name?: string; last_name?: string; username?: string };
      };
    }>;
    description?: string;
  }>(`https://api.telegram.org/bot${botToken}/getUpdates`);

  if (!result.ok || !result.result) {
    return undefined;
  }

  for (const update of [...result.result].reverse()) {
    const chat = update.message?.chat;
    if (chat?.type !== "private" || chat.id === undefined) {
      continue;
    }

    const label = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim()
      || chat.username
      || String(chat.id);

    return {
      chatId: String(chat.id),
      label,
    };
  }

  return undefined;
}

async function askQuestion(io: PromptSession, prompt: string): Promise<string> {
  return await io.question(prompt);
}

function createPromptSession(): PromptSession {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const io = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return {
      question(prompt: string): Promise<string> {
        return new Promise<string>((resolve) => {
          io.question(prompt, resolve);
        });
      },
      close(): void {
        io.close();
      },
    };
  }

  let bufferedLines: string[] | undefined;

  return {
    async question(prompt: string): Promise<string> {
      if (process.stdout.writable) {
        process.stdout.write(prompt);
      }

      if (!bufferedLines) {
        bufferedLines = await readAllStdinLines();
      }

      return bufferedLines.shift() ?? "";
    },
    close(): void {
      return;
    },
  };
}

async function readAllStdinLines(): Promise<string[]> {
  const chunks: Buffer[] = [];

  return await new Promise<string[]>((resolve, reject) => {
    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    process.stdin.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(text.split(/\r?\n/));
    });
    process.stdin.on("error", reject);
  });
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
