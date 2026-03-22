import { promises as fs } from "fs";
import TOML from "@iarna/toml";
import { z } from "zod";
import type { Logger } from "../logger";
import { parseConfigText } from "./loadConfig";
import { reasoningEffortSchema, type CodexClawConfig } from "./schema";

const editableConfigSchema = z.object({
  botName: z.string().trim().min(1).max(80),
  aliases: z.array(z.string().trim().min(1).max(40)).max(12),
  allowSelfMessages: z.boolean(),
  model: z.string().trim().min(1).max(80).optional(),
  effort: reasoningEffortSchema.optional(),
  summary: z.string().trim().min(1).max(80),
});

export interface EditableConfigSnapshot {
  botName: string;
  aliases: string[];
  allowSelfMessages: boolean;
  model?: string;
  effort?: CodexClawConfig["codex"]["effort"];
  summary: string;
}

export interface OperatorConfigSnapshot {
  path: string;
  web: CodexClawConfig["web"];
  bot: CodexClawConfig["bot"];
  codex: CodexClawConfig["codex"];
  policy: CodexClawConfig["policy"];
  transports: Array<{
    id: string;
    channel: string;
    provider: string;
    enabled: boolean;
  }>;
  workspaces: CodexClawConfig["workspaces"];
  editable: EditableConfigSnapshot;
}

type RuntimeConfigAppliedCallback = (nextConfig: CodexClawConfig) => void;

export class ConfigManager {
  constructor(
    private readonly configPath: string,
    private readonly config: CodexClawConfig,
    private readonly logger: Logger,
    private readonly onConfigApplied?: RuntimeConfigAppliedCallback,
  ) {}

  getSnapshot(): OperatorConfigSnapshot {
    return {
      path: this.configPath,
      web: { ...this.config.web },
      bot: {
        ...this.config.bot,
        aliases: [...this.config.bot.aliases],
      },
      codex: {
        ...this.config.codex,
        command: [...this.config.codex.command],
      },
      policy: { ...this.config.policy },
      transports: this.config.transports.map((transport) => ({
        id: transport.id,
        channel: transport.channel,
        provider: transport.provider,
        enabled: transport.enabled,
      })),
      workspaces: this.config.workspaces.map((workspace) => ({ ...workspace })),
      editable: {
        botName: this.config.bot.name,
        aliases: [...this.config.bot.aliases],
        allowSelfMessages: this.config.bot.allowSelfMessages,
        model: this.config.codex.model,
        effort: this.config.codex.effort,
        summary: this.config.codex.summary,
      },
    };
  }

  async updateEditableConfig(input: unknown): Promise<OperatorConfigSnapshot> {
    const rawInput = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const rawAliases = Array.isArray(rawInput.aliases)
      ? rawInput.aliases.filter((alias): alias is string => typeof alias === "string")
      : [];

    const normalizedInput = editableConfigSchema.parse({
      ...rawInput,
      aliases: Array.from(new Set(rawAliases.map((alias) => alias.trim()).filter(Boolean))),
      model: typeof rawInput.model === "string" ? rawInput.model.trim() || undefined : undefined,
      summary: typeof rawInput.summary === "string" ? rawInput.summary.trim() : rawInput.summary,
      botName: typeof rawInput.botName === "string" ? rawInput.botName.trim() : rawInput.botName,
    });

    const rawText = await fs.readFile(this.configPath, "utf8");
    const document = TOML.parse(rawText) as ConfigDocument;
    document.bot = document.bot ?? {};
    document.codex = document.codex ?? {};
    document.web = document.web ?? {};

    document.bot.name = normalizedInput.botName;
    document.bot.aliases = normalizedInput.aliases;
    document.bot.allow_self_messages = normalizedInput.allowSelfMessages;
    document.codex.model = normalizedInput.model;
    document.codex.effort = normalizedInput.effort;
    document.codex.summary = normalizedInput.summary;

    if (!normalizedInput.model) {
      delete document.codex.model;
    }

    if (!normalizedInput.effort) {
      delete document.codex.effort;
    }

    const nextText = TOML.stringify(document as never);
    const nextConfig = parseConfigText(nextText, this.configPath, this.logger.child("validator"));

    await fs.writeFile(this.configPath, nextText, "utf8");
    this.applyNextConfig(nextConfig);
    this.logger.info("Updated editable config from control panel", {
      configPath: this.configPath,
      botName: normalizedInput.botName,
        aliases: normalizedInput.aliases,
        model: normalizedInput.model,
        effort: normalizedInput.effort,
    });

    return this.getSnapshot();
  }

  private applyNextConfig(nextConfig: CodexClawConfig): void {
    this.config.bot = nextConfig.bot;
    this.config.codex = nextConfig.codex;
    this.config.web = nextConfig.web;
    this.onConfigApplied?.(nextConfig);
  }
}

interface ConfigDocument {
  bot?: {
    name?: string;
    aliases?: string[];
    allow_self_messages?: boolean;
    [key: string]: unknown;
  };
  codex?: {
    model?: string;
    effort?: CodexClawConfig["codex"]["effort"];
    summary?: string;
    [key: string]: unknown;
  };
  web?: Record<string, unknown>;
  [key: string]: unknown;
}
