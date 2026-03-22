import { promises as fs } from "fs";
import path from "path";
import TOML from "@iarna/toml";
import { z } from "zod";
import type { Logger } from "../logger";
import { resolveDefaultStateDbPath, resolveDefaultStateDir } from "../paths";
import { configSchema, type CodexClawConfig } from "./schema";

export const rawConfigSchema = z.object({
  bot: z.object({
    name: z.string(),
    aliases: z.array(z.string()).optional(),
    soul_path: z.string(),
    workspace_id: z.string(),
    allow_self_messages: z.boolean().optional(),
  }),
  codex: z
    .object({
      command: z.array(z.string()).optional(),
      approval_policy: z.string().optional(),
      sandbox: z.string().optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      summary: z.string().optional(),
    })
    .optional(),
  storage: z.object({ db_path: z.string().optional() }).optional(),
  web: z.object({
    enabled: z.boolean().optional(),
    host: z.string().optional(),
    port: z.number().optional(),
  }).optional(),
  policy: z.object({
    default: z.string().optional(),
  }),
  allow: z.array(z.record(z.unknown())).optional(),
  deny: z.array(z.record(z.unknown())).optional(),
  admins: z.array(z.object({
    transport_id: z.string(),
    conversation_id: z.string(),
    allowed_sender_ids: z.array(z.string()),
    command_format: z.string().optional(),
  })).optional(),
  transports: z.array(z.record(z.unknown())),
  workspaces: z.array(z.object({ id: z.string(), cwd: z.string() })),
});

export async function loadConfig(configPath: string, logger: Logger): Promise<CodexClawConfig> {
  const resolvedPath = path.resolve(configPath);

  let rawText: string;

  try {
    rawText = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    const ioError = error as NodeJS.ErrnoException;
    if (ioError.code && ioError.code !== "ENOENT") {
      logger.error("Failed to read config file", { configPath: resolvedPath, error });
    }
    throw new Error(
      `Config file not found at ${resolvedPath}. Run codexclaw init to create the default config, or pass --config /path/to/codexclaw.toml.`,
    );
  }

  const normalized = parseConfigText(rawText, resolvedPath, logger);

  logger.info("Loaded configuration", { configPath: resolvedPath });
  return normalized;
}

export function parseConfigText(rawText: string, configPath: string, logger: Logger): CodexClawConfig {
  const resolvedPath = path.resolve(configPath);
  const baseDir = path.dirname(resolvedPath);
  const tomlValue = TOML.parse(rawText);
  const parsed = rawConfigSchema.parse(tomlValue);
  const configuredStateDir = process.env.CODEXCLAW_STATE_DIR
    ? resolveDefaultStateDir()
    : undefined;

  const normalized = configSchema.parse({
    bot: {
      name: parsed.bot.name,
      aliases: parsed.bot.aliases ?? [],
      soulPath: resolvePath(baseDir, parsed.bot.soul_path),
      workspaceId: parsed.bot.workspace_id,
      allowSelfMessages: parsed.bot.allow_self_messages,
    },
    codex: {
      command: parsed.codex?.command,
      approvalPolicy: parsed.codex?.approval_policy,
      sandbox: parsed.codex?.sandbox,
      model: parsed.codex?.model,
      effort: parsed.codex?.effort,
      summary: parsed.codex?.summary,
    },
    storage: {
      dbPath: configuredStateDir
        ? resolveDefaultStateDbPath()
        : resolvePath(baseDir, parsed.storage?.db_path ?? "./state/codexclaw.db"),
    },
    web: {
      enabled: parsed.web?.enabled,
      host: parsed.web?.host,
      port: parsed.web?.port,
    },
    policy: {
      default: parsed.policy.default,
    },
    allow: (parsed.allow ?? []).map(normalizeAccessRule),
    deny: (parsed.deny ?? []).map(normalizeAccessRule),
    admins: (parsed.admins ?? []).map((admin) => ({
      transportId: admin.transport_id,
      conversationId: admin.conversation_id,
      allowedSenderIds: admin.allowed_sender_ids,
      commandFormat: admin.command_format ?? "strict",
    })),
    transports: parsed.transports.map(normalizeTransport),
    workspaces: parsed.workspaces.map((workspace) => ({
      id: workspace.id,
      cwd: resolvePath(baseDir, workspace.cwd),
    })),
  });

  validateReferences(normalized);
  maybeWarnOnTelegramContactScope(normalized, logger);
  return normalized;
}

function resolvePath(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function normalizeTransport(transport: Record<string, unknown>): Record<string, unknown> {
  const config = (transport.config ?? {}) as Record<string, unknown>;
  const triggers = (transport.triggers ?? {}) as Record<string, unknown>;

  if (transport.channel === "imessage" && transport.provider === "bluebubbles") {
    return {
      id: transport.id,
      channel: transport.channel,
      provider: transport.provider,
      enabled: transport.enabled,
      triggers: {
        direct: triggers.direct,
        group: triggers.group,
      },
      config: {
        serverUrl: config.server_url,
        password: config.password,
        webhookListenHost: config.webhook_listen_host,
        webhookListenPort: config.webhook_listen_port,
        webhookPath: config.webhook_path,
        webhookPublicUrl: config.webhook_public_url,
        webhookToken: config.webhook_token,
        autoRegisterWebhook: config.auto_register_webhook,
        webhookEvents: config.webhook_events,
      },
    };
  }

  if (transport.channel === "telegram" && transport.provider === "bot-api") {
    return {
      id: transport.id,
      channel: transport.channel,
      provider: transport.provider,
      enabled: transport.enabled,
      triggers: {
        direct: triggers.direct,
        group: triggers.group,
      },
      config: {
        botToken: config.bot_token,
        mode: config.mode,
        pollTimeoutSeconds: config.poll_timeout_seconds,
        allowedUpdates: ensureTelegramAllowedUpdates(config.allowed_updates),
      },
    };
  }

  return {
    id: transport.id,
    channel: transport.channel,
    provider: transport.provider,
    enabled: transport.enabled,
    triggers: {
      direct: triggers.direct,
      group: triggers.group,
    },
    config,
  };
}

function ensureTelegramAllowedUpdates(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return Array.from(new Set([
    ...value.filter((entry): entry is string => typeof entry === "string"),
    "callback_query",
  ]));
}

function normalizeAccessRule(rule: Record<string, unknown>): Record<string, unknown> {
  switch (rule.kind) {
    case "conversation":
      return {
        kind: rule.kind,
        transportId: rule.transport_id,
        conversationId: rule.conversation_id,
        label: rule.label,
      };
    case "sender":
      return {
        kind: rule.kind,
        transportId: rule.transport_id,
        senderId: rule.sender_id,
        label: rule.label,
      };
    case "direct_messages":
      return {
        kind: rule.kind,
        transportId: rule.transport_id,
        contactScope: rule.contact_scope,
        label: rule.label,
      };
    case "groups":
      return {
        kind: rule.kind,
        transportId: rule.transport_id,
        label: rule.label,
      };
    default:
      return rule;
  }
}

function validateReferences(config: CodexClawConfig): void {
  const transportIds = new Set(config.transports.map((transport) => transport.id));
  const workspaceIds = new Set(config.workspaces.map((workspace) => workspace.id));

  if (!workspaceIds.has(config.bot.workspaceId)) {
    throw new Error(`Bot references unknown workspace: ${config.bot.workspaceId}`);
  }

  for (const rule of [...config.allow, ...config.deny]) {
    if (!transportIds.has(rule.transportId)) {
      throw new Error(`Policy rule references unknown transport: ${rule.transportId}`);
    }
  }

  for (const admin of config.admins) {
    if (!transportIds.has(admin.transportId)) {
      throw new Error(`Admin config references unknown transport: ${admin.transportId}`);
    }
  }
}

function maybeWarnOnTelegramContactScope(config: CodexClawConfig, logger: Logger): void {
  for (const rule of [...config.allow, ...config.deny]) {
    if (rule.kind !== "direct_messages" || rule.contactScope === "any") {
      continue;
    }

    const transport = config.transports.find((candidate) => candidate.id === rule.transportId);
    if (transport?.channel !== "telegram") {
      continue;
    }

    logger.warn("Telegram direct-message contact scope is unsupported; the rule will never match", {
      transportId: rule.transportId,
      ruleLabel: rule.label,
      contactScope: rule.contactScope,
    });
  }
}
