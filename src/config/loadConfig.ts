import { promises as fs } from "fs";
import path from "path";
import TOML from "@iarna/toml";
import { z } from "zod";
import type { Logger } from "../logger";
import { configSchema, type CodexClawConfig } from "./schema";

const rawConfigSchema = z.object({
  bot: z.object({
    name: z.string(),
    aliases: z.array(z.string()).optional(),
    developer_instructions_path: z.string(),
    avatar_path: z.string().optional(),
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
  adapters: z.array(z.record(z.unknown())),
  routes: z.array(z.record(z.unknown())),
  approvals: z.object({
    target_adapter_id: z.string(),
    target_conversation_id: z.string(),
    command_format: z.string().optional(),
  }),
  workspaces: z.array(z.object({ id: z.string(), cwd: z.string() })),
});

export async function loadConfig(configPath: string, logger: Logger): Promise<CodexClawConfig> {
  const resolvedPath = path.resolve(configPath);
  const baseDir = path.dirname(resolvedPath);

  let rawText: string;

  try {
    rawText = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    logger.error("Failed to read config file", { configPath: resolvedPath, error });
    throw new Error(
      `Config file not found at ${resolvedPath}. Copy codexclaw.example.toml to codexclaw.toml and edit it.`,
    );
  }

  const tomlValue = TOML.parse(rawText);
  const parsed = rawConfigSchema.parse(tomlValue);

  const normalized = configSchema.parse({
    bot: {
      name: parsed.bot.name,
      aliases: parsed.bot.aliases ?? [],
      developerInstructionsPath: resolvePath(baseDir, parsed.bot.developer_instructions_path),
      avatarPath: parsed.bot.avatar_path ? resolvePath(baseDir, parsed.bot.avatar_path) : undefined,
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
      dbPath: resolvePath(baseDir, parsed.storage?.db_path ?? "./var/codexclaw.db"),
    },
    adapters: parsed.adapters.map(normalizeAdapter),
    routes: parsed.routes.map(normalizeRoute),
    approvals: {
      targetAdapterId: parsed.approvals.target_adapter_id,
      targetConversationId: parsed.approvals.target_conversation_id,
      commandFormat: parsed.approvals.command_format ?? "strict",
    },
    workspaces: parsed.workspaces.map((workspace) => ({
      id: workspace.id,
      cwd: resolvePath(baseDir, workspace.cwd),
    })),
  });

  validateReferences(normalized);
  logger.info("Loaded configuration", { configPath: resolvedPath });
  return normalized;
}

function resolvePath(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function normalizeAdapter(adapter: Record<string, unknown>): Record<string, unknown> {
  const config = (adapter.config ?? {}) as Record<string, unknown>;

  if (adapter.type === "imessage" && adapter.provider === "bluebubbles") {
    return {
      id: adapter.id,
      type: adapter.type,
      provider: adapter.provider,
      enabled: adapter.enabled,
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

  return {
    id: adapter.id,
    type: adapter.type,
    provider: adapter.provider,
    enabled: adapter.enabled,
    config,
  };
}

function normalizeRoute(route: Record<string, unknown>): Record<string, unknown> {
  return {
    name: route.name,
    adapterId: route.adapter_id,
    conversationId: route.conversation_id,
    workspaceId: route.workspace_id,
    threadStrategy: route.thread_strategy,
    mentionRequired: route.mention_required,
    role: route.role,
    allowedSenderIds: route.allowed_sender_ids,
  };
}

function validateReferences(config: CodexClawConfig): void {
  const adapterIds = new Set(config.adapters.map((adapter) => adapter.id));
  const workspaceIds = new Set(config.workspaces.map((workspace) => workspace.id));

  for (const route of config.routes) {
    if (!adapterIds.has(route.adapterId)) {
      throw new Error(`Route references unknown adapter: ${route.adapterId}`);
    }

    if (!workspaceIds.has(route.workspaceId)) {
      throw new Error(`Route references unknown workspace: ${route.workspaceId}`);
    }

    if (route.role === "admin" && (!route.allowedSenderIds || route.allowedSenderIds.length === 0)) {
      throw new Error(`Admin route must declare at least one allowed sender id: ${route.conversationId}`);
    }
  }

  if (!adapterIds.has(config.approvals.targetAdapterId)) {
    throw new Error(`Approvals target references unknown adapter: ${config.approvals.targetAdapterId}`);
  }
}
