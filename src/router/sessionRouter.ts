import type { InboundMessage } from "../adapters/base";
import type { RouteConfig, WorkspaceConfig } from "../config/schema";
import type { Logger } from "../logger";
import type { ChatSession, StateStore } from "../storage/stateStore";

export interface RouteContext {
  route: RouteConfig;
  workspace: WorkspaceConfig;
}

export class SessionRouter {
  private readonly routesByKey = new Map<string, RouteConfig>();
  private readonly workspacesById = new Map<string, WorkspaceConfig>();

  constructor(
    routes: RouteConfig[],
    workspaces: WorkspaceConfig[],
    private readonly store: StateStore,
    private readonly logger: Logger,
  ) {
    for (const route of routes) {
      this.routesByKey.set(this.routeKey(route.adapterId, route.conversationId), route);
    }

    for (const workspace of workspaces) {
      this.workspacesById.set(workspace.id, workspace);
    }
  }

  match(message: InboundMessage): RouteContext | undefined {
    const route = this.routesByKey.get(this.routeKey(message.adapterId, message.conversationId));

    if (!route) {
      return undefined;
    }

    const workspace = this.workspacesById.get(route.workspaceId);

    if (!workspace) {
      throw new Error(`Route references missing workspace: ${route.workspaceId}`);
    }

    return { route, workspace };
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
      displayName: message.senderName,
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

  private routeKey(adapterId: string, conversationId: string): string {
    return `${adapterId}:${conversationId}`;
  }
}

