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

export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const botSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  developerInstructionsPath: z.string().min(1),
  avatarPath: z.string().min(1).optional(),
});

const codexSchema = z.object({
  command: z.array(z.string().min(1)).min(1).default(["codex", "app-server"]),
  approvalPolicy: approvalPolicySchema.default("untrusted"),
  sandbox: sandboxSchema.default("workspace-write"),
  model: z.string().min(1).optional(),
  effort: reasoningEffortSchema.optional(),
  summary: z.string().min(1).default("concise"),
});

const storageSchema = z.object({
  dbPath: z.string().min(1).default("./var/codexclaw.db"),
});

const adapterBaseSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
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

const blueBubblesIMessageAdapterSchema = adapterBaseSchema.extend({
  type: z.literal("imessage"),
  provider: z.literal("bluebubbles"),
  config: blueBubblesConfigSchema,
});

const genericIMessageAdapterSchema = adapterBaseSchema.extend({
  type: z.literal("imessage"),
  provider: z.enum(["imsg", "custom"]),
  config: z.record(z.unknown()).default({}),
});

const whatsappAdapterSchema = adapterBaseSchema.extend({
  type: z.literal("whatsapp"),
  provider: z.enum(["meta-cloud-api", "custom"]).default("custom"),
  config: z.record(z.unknown()).default({}),
});

const routeSchema = z.object({
  name: z.string().min(1).optional(),
  adapterId: z.string().min(1),
  conversationId: z.string().min(1),
  workspaceId: z.string().min(1),
  threadStrategy: z.literal("one_conversation_one_thread").default("one_conversation_one_thread"),
  mentionRequired: z.boolean().default(true),
  role: z.enum(["user", "admin"]).default("user"),
  allowedSenderIds: z.array(z.string().min(1)).optional(),
});

const approvalsSchema = z.object({
  targetAdapterId: z.string().min(1),
  targetConversationId: z.string().min(1),
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
  adapters: z.array(
    z.union([blueBubblesIMessageAdapterSchema, genericIMessageAdapterSchema, whatsappAdapterSchema]),
  ).min(1),
  routes: z.array(routeSchema).min(1),
  approvals: approvalsSchema,
  workspaces: z.array(workspaceSchema).min(1),
});

export type CodexClawConfig = z.infer<typeof configSchema>;
export type AdapterConfig = CodexClawConfig["adapters"][number];
export type IMessageAdapterConfig = Extract<AdapterConfig, { type: "imessage" }>;
export type BlueBubblesIMessageAdapterConfig = Extract<
  AdapterConfig,
  { type: "imessage"; provider: "bluebubbles" }
>;
export type RouteConfig = CodexClawConfig["routes"][number];
export type WorkspaceConfig = CodexClawConfig["workspaces"][number];
