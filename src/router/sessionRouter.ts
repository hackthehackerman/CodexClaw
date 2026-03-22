import type { InboundMessage } from "../adapters/base";
import type { AccessRule, WorkspaceConfig } from "../config/schema";
import type { Logger } from "../logger";
import type { ChatSession, StateStore } from "../storage/stateStore";

export interface RouteContext {
  kind: "user" | "admin";
  workspace: WorkspaceConfig;
  label?: string;
  allowedSenderIds?: string[];
}

export interface SessionRouterOptions {
  workspaceId: string;
  policyDefault: "allow" | "deny";
  allowRules: AccessRule[];
  denyRules: AccessRule[];
  admins: Array<{
    transportId: string;
    conversationId: string;
    allowedSenderIds: string[];
  }>;
}

export class SessionRouter {
  private readonly workspacesById = new Map<string, WorkspaceConfig>();
  private readonly workspace: WorkspaceConfig;

  constructor(
    private readonly options: SessionRouterOptions,
    workspaces: WorkspaceConfig[],
    private readonly store: StateStore,
    private readonly logger: Logger,
  ) {
    for (const workspace of workspaces) {
      this.workspacesById.set(workspace.id, workspace);
    }

    const workspace = this.workspacesById.get(options.workspaceId);
    if (!workspace) {
      throw new Error(`Bot references missing workspace: ${options.workspaceId}`);
    }

    this.workspace = workspace;
  }

  match(message: InboundMessage): RouteContext | undefined {
    if (this.isAdminConversation(message)) {
      const admin = this.options.admins.find((candidate) =>
        candidate.transportId === message.adapterId && candidate.conversationId === message.conversationId,
      );

      return {
        kind: "admin",
        workspace: this.workspace,
        label: "admin",
        allowedSenderIds: admin?.allowedSenderIds,
      };
    }

    if (this.options.denyRules.some((rule) => matchesAccessRule(rule, message))) {
      return undefined;
    }

    const matchedAllowRule = this.options.allowRules.find((rule) => matchesAccessRule(rule, message));
    if (matchedAllowRule) {
      return {
        kind: "user",
        workspace: this.workspace,
        label: matchedAllowRule.label,
      };
    }

    if (this.options.policyDefault === "allow") {
      return {
        kind: "user",
        workspace: this.workspace,
      };
    }

    return undefined;
  }

  async getOrCreateChatSession(message: InboundMessage): Promise<ChatSession> {
    const existing = await this.store.getChatSession(message.adapterId, message.conversationId);

    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const session = {
      id: "",
      adapterId: message.adapterId,
      channel: message.channel,
      externalChatId: message.conversationId,
      displayName: message.conversationName ?? message.senderName,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.saveChatSession(session);

    const created = await this.store.getChatSession(message.adapterId, message.conversationId);

    if (!created) {
      throw new Error("Failed to create chat session");
    }

    this.logger.info("Created chat session", {
      adapterId: message.adapterId,
      conversationId: message.conversationId,
      sessionId: created.id,
    });

    return created;
  }

  private isAdminConversation(message: InboundMessage): boolean {
    return this.options.admins.some((admin) =>
      message.adapterId === admin.transportId && message.conversationId === admin.conversationId,
    );
  }
}

function matchesAccessRule(rule: AccessRule, message: InboundMessage): boolean {
  if (rule.transportId !== message.adapterId) {
    return false;
  }

  switch (rule.kind) {
    case "conversation":
      return rule.conversationId === message.conversationId;
    case "sender":
      return rule.senderId === message.senderId;
    case "direct_messages":
      if (message.conversationType !== "direct") {
        return false;
      }

      if (rule.contactScope === "any") {
        return true;
      }

      if (rule.contactScope === "known") {
        return message.isKnownContact === true;
      }

      return message.isKnownContact === false;
    case "groups":
      return message.conversationType === "group";
  }
}
