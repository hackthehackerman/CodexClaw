import { z } from "zod";

export const approvalPolicySchema = z.enum([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);

export const sandboxSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

export const networkAccessSchema = z.enum([
  "restricted",
  "enabled",
]);

export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const telegramAllowedUpdateSchema = z.enum([
  "message",
  "callback_query",
]);

export const triggerModeSchema = z.enum([
  "none",
  "addressed",
]);

const triggerConfigSchema = z.object({
  direct: triggerModeSchema.default("none"),
  group: triggerModeSchema.default("addressed"),
});

const botSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  soulPath: z.string().min(1),
  workspaceId: z.string().min(1),
  allowSelfMessages: z.boolean().default(false),
});

const codexSchema = z.object({
  command: z.array(z.string().min(1)).min(1).default(["codex", "app-server"]),
  approvalPolicy: approvalPolicySchema.default("on-request"),
  sandbox: sandboxSchema.default("workspace-write"),
  networkAccess: networkAccessSchema.default("restricted"),
  model: z.string().min(1).optional(),
  effort: reasoningEffortSchema.optional(),
  summary: z.string().min(1).default("concise"),
});

const storageSchema = z.object({
  dbPath: z.string().min(1).default("./state/codexclaw.db"),
});

const webSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().positive().max(65535).default(4188),
});

const transportBaseSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  triggers: triggerConfigSchema.default({
    direct: "none",
    group: "addressed",
  }),
});

const blueBubblesConfigSchema = z.object({
  serverUrl: z.string().url(),
  password: z.string().min(1),
  webhookListenHost: z.string().min(1).default("127.0.0.1"),
  webhookListenPort: z.number().int().positive().default(4101),
  webhookPath: z.string().min(1).default("/webhooks/bluebubbles"),
  webhookPublicUrl: z.string().url().optional(),
  webhookToken: z.string().min(1).optional(),
  autoRegisterWebhook: z.boolean().default(true),
  webhookEvents: z.array(z.string().min(1)).min(1).default(["new-message"]),
});

const blueBubblesIMessageTransportSchema = transportBaseSchema.extend({
  channel: z.literal("imessage"),
  provider: z.literal("bluebubbles"),
  config: blueBubblesConfigSchema,
});

const genericIMessageTransportSchema = transportBaseSchema.extend({
  channel: z.literal("imessage"),
  provider: z.enum(["imsg", "custom"]),
  config: z.record(z.unknown()).default({}),
});

const whatsappTransportSchema = transportBaseSchema.extend({
  channel: z.literal("whatsapp"),
  provider: z.enum(["meta-cloud-api", "custom"]).default("custom"),
  config: z.record(z.unknown()).default({}),
});

const telegramBotApiConfigSchema = z.object({
  botToken: z.string().min(1),
  mode: z.literal("polling").default("polling"),
  pollTimeoutSeconds: z.number().int().positive().max(60).default(30),
  allowedUpdates: z.array(telegramAllowedUpdateSchema).min(1).default(["message", "callback_query"]),
});

const telegramTransportSchema = transportBaseSchema.extend({
  channel: z.literal("telegram"),
  provider: z.literal("bot-api"),
  config: telegramBotApiConfigSchema,
});

const policySchema = z.object({
  default: z.enum(["allow", "deny"]).default("deny"),
});

const accessRuleBaseSchema = z.object({
  transportId: z.string().min(1),
  label: z.string().min(1).optional(),
});

const conversationAccessRuleSchema = accessRuleBaseSchema.extend({
  kind: z.literal("conversation"),
  conversationId: z.string().min(1),
});

const senderAccessRuleSchema = accessRuleBaseSchema.extend({
  kind: z.literal("sender"),
  senderId: z.string().min(1),
});

const directMessagesAccessRuleSchema = accessRuleBaseSchema.extend({
  kind: z.literal("direct_messages"),
  contactScope: z.enum(["any", "known", "unknown"]).default("any"),
});

const groupsAccessRuleSchema = accessRuleBaseSchema.extend({
  kind: z.literal("groups"),
});

const accessRuleSchema = z.discriminatedUnion("kind", [
  conversationAccessRuleSchema,
  senderAccessRuleSchema,
  directMessagesAccessRuleSchema,
  groupsAccessRuleSchema,
]);

const adminSchema = z.object({
  transportId: z.string().min(1),
  conversationId: z.string().min(1),
  allowedSenderIds: z.array(z.string().min(1)).min(1),
  commandFormat: z.enum(["strict"]).default("strict"),
});

const workspaceSchema = z.object({
  id: z.string().min(1),
  cwd: z.string().min(1),
});

export const configSchema = z.object({
  bot: botSchema,
  codex: codexSchema,
  storage: storageSchema,
  web: webSchema.default({
    enabled: true,
    host: "127.0.0.1",
    port: 4188,
  }),
  policy: policySchema,
  allow: z.array(accessRuleSchema).default([]),
  deny: z.array(accessRuleSchema).default([]),
  admins: z.array(adminSchema).default([]),
  transports: z.array(
    z.union([
      blueBubblesIMessageTransportSchema,
      genericIMessageTransportSchema,
      whatsappTransportSchema,
      telegramTransportSchema,
    ]),
  ).min(1),
  workspaces: z.array(workspaceSchema).min(1),
});

export type CodexClawConfig = z.infer<typeof configSchema>;
export type TransportConfig = CodexClawConfig["transports"][number];
export type IMessageTransportConfig = Extract<TransportConfig, { channel: "imessage" }>;
export type BlueBubblesIMessageTransportConfig = Extract<
  TransportConfig,
  { channel: "imessage"; provider: "bluebubbles" }
>;
export type TelegramTransportConfig = Extract<
  TransportConfig,
  { channel: "telegram"; provider: "bot-api" }
>;
export type AccessRule = z.infer<typeof accessRuleSchema>;
export type WorkspaceConfig = CodexClawConfig["workspaces"][number];
