import type { ChannelAdapter, InboundMessage } from "../adapters/base";
import type { CodexClawConfig } from "../config/schema";
import { parseAdminCommand } from "../core/approvalCommands";
import type { AppServerClient, ApprovalDecision, ApprovalRequest } from "../codex/appServerClient";
import type { Logger } from "../logger";
import { PerThreadQueue } from "../queue/perThreadQueue";
import { SessionRouter } from "../router/sessionRouter";
import type { ApprovalRecord, StateStore } from "../storage/stateStore";

export class Gateway {
  private readonly adaptersById = new Map<string, ChannelAdapter>();

  constructor(
    private readonly config: CodexClawConfig,
    adapters: ChannelAdapter[],
    private readonly router: SessionRouter,
    private readonly queue: PerThreadQueue,
    private readonly codex: AppServerClient,
    private readonly store: StateStore,
    private readonly logger: Logger,
  ) {
    for (const adapter of adapters) {
      this.adaptersById.set(adapter.id, adapter);
    }

    this.codex.setApprovalRequestHandler((request) => this.handleApprovalRequest(request));
  }

  async start(): Promise<void> {
    await this.codex.start();

    await Promise.all(
      Array.from(this.adaptersById.values()).map((adapter) =>
        adapter.start((message) => this.handleInboundMessage(message)),
      ),
    );

    this.logger.info("Gateway started", {
      adapters: Array.from(this.adaptersById.keys()),
      allowlistedUserRoutes: this.config.routes
        .filter((route) => route.role === "user")
        .map((route) => ({
          name: route.name ?? route.conversationId,
          adapterId: route.adapterId,
          conversationId: route.conversationId,
        })),
      adminRoutes: this.config.routes
        .filter((route) => route.role === "admin")
        .map((route) => ({
          name: route.name ?? route.conversationId,
          adapterId: route.adapterId,
          conversationId: route.conversationId,
        })),
    });
  }

  private async handleInboundMessage(message: InboundMessage): Promise<void> {
    const context = this.router.match(message);

    if (!context) {
      this.logger.debug("Ignoring message for non-allowlisted conversation", {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
      });
      return;
    }

    if (context.route.role === "admin") {
      await this.handleAdminMessage(message);
      return;
    }

    if (message.isFromSelf) {
      this.logger.debug("Ignoring self-authored message", { conversationId: message.conversationId });
      return;
    }

    if (context.route.mentionRequired && !this.hasTriggerPrefix(message.text)) {
      this.logger.debug("Ignoring message without trigger prefix", { conversationId: message.conversationId });
      return;
    }

    const conversationQueueKey = this.queueKey(message);

    await this.queue.enqueue(conversationQueueKey, async () => {
      const session = await this.router.getOrCreateChatSession(message);
      const threadId = session.codexThreadId
        ?? (await this.codex.createThread({
          workspaceCwd: context.workspace.cwd,
          developerInstructionsPath: this.config.bot.developerInstructionsPath,
          avatarPath: this.config.bot.avatarPath,
        }));

      if (!session.codexThreadId) {
        await this.store.saveChatSession({
          ...session,
          codexThreadId: threadId,
          updatedAt: new Date().toISOString(),
        });
      }

      const run = await this.store.createRun({
        chatSessionId: session.id,
        status: "queued",
        startedAt: new Date().toISOString(),
      });

      try {
        await this.store.updateRun(run.id, { status: "in_progress" });

        const result = await this.codex.runTurn({
          threadId,
          messageText: this.stripTriggerPrefix(message.text),
          workspaceCwd: context.workspace.cwd,
          senderName: message.senderName,
        });

        await this.store.updateRun(run.id, {
          codexTurnId: result.turnId,
          status: "completed",
          completedAt: new Date().toISOString(),
        });

        await this.sendMessage(message.adapterId, message.conversationId, result.finalResponse);
      } catch (error) {
        await this.store.updateRun(run.id, {
          status: "failed",
          completedAt: new Date().toISOString(),
          errorText: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  private async handleApprovalRequest(request: ApprovalRequest): Promise<void> {
    const approval = await this.store.createApproval({
      runId: "pending",
      requestId: request.requestId,
      kind: request.kind,
      threadId: request.threadId,
      turnId: request.turnId,
      itemId: request.itemId,
      payloadJson: JSON.stringify(request.payload),
      status: "pending",
    });

    const lines = [
      `CodexClaw approval ${approval.id}`,
      `Kind: ${request.kind}`,
      `Summary: ${request.summary}`,
      `Reply with: APPROVE ${approval.id}, APPROVE ${approval.id} SESSION, DENY ${approval.id}, or CANCEL ${approval.id}`,
    ];

    await this.sendMessage(
      this.config.approvals.targetAdapterId,
      this.config.approvals.targetConversationId,
      lines.join("\n"),
    );
  }

  private async handleAdminMessage(message: InboundMessage): Promise<void> {
    const context = this.router.match(message);

    if (!context || context.route.role !== "admin") {
      return;
    }

    if (!context.route.allowedSenderIds?.includes(message.senderId)) {
      this.logger.warn("Ignoring admin command from unauthorized sender", {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
        senderId: message.senderId,
      });
      return;
    }

    const command = parseAdminCommand(message.text);

    if (!command) {
      return;
    }

    const approval = await this.store.getApproval(command.approvalId);

    if (!approval) {
      await this.sendMessage(message.adapterId, message.conversationId, `Unknown approval id: ${command.approvalId}`);
      return;
    }

    if (approval.status !== "pending") {
      await this.sendMessage(
        message.adapterId,
        message.conversationId,
        `Approval ${approval.id} is already ${approval.status}.`,
      );
      return;
    }

    const decision = toDecision(command.action, "scope" in command ? command.scope : undefined);
    const nextStatus = toApprovalStatus(decision);

    await this.codex.resolveApproval(approval.requestId, decision);
    await this.store.updateApproval(approval.id, {
      status: nextStatus,
      decidedAt: new Date().toISOString(),
    });

    await this.sendMessage(
      message.adapterId,
      message.conversationId,
      `Approval ${approval.id} ${nextStatus}.`,
    );
  }

  private async sendMessage(adapterId: string, conversationId: string, text: string): Promise<void> {
    const adapter = this.adaptersById.get(adapterId);

    if (!adapter) {
      throw new Error(`Unknown adapter: ${adapterId}`);
    }

    await adapter.sendMessage({ conversationId, text });
  }

  private hasTriggerPrefix(text: string): boolean {
    return this.findTriggerPrefix(text) !== undefined;
  }

  private stripTriggerPrefix(text: string): string {
    const trimmed = text.trimStart();
    const alias = this.findTriggerPrefix(trimmed);

    if (!alias) {
      return trimmed;
    }

    const suffix = trimmed.slice(alias.length).replace(/^[\s:,.!?-]+/, "");
    return suffix.trim();
  }

  private findTriggerPrefix(text: string): string | undefined {
    const trimmed = text.trimStart();

    return this.config.bot.aliases.find((alias) => startsWithTrigger(trimmed, alias));
  }

  private queueKey(message: InboundMessage): string {
    return `${message.adapterId}:${message.conversationId}`;
  }
}

function startsWithTrigger(text: string, alias: string): boolean {
  const loweredText = text.toLowerCase();
  const loweredAlias = alias.toLowerCase();

  if (!loweredText.startsWith(loweredAlias)) {
    return false;
  }

  const nextCharacter = loweredText.charAt(loweredAlias.length);
  return nextCharacter.length === 0 || /[\s:,.!?-]/.test(nextCharacter);
}

function toDecision(action: "approve" | "deny" | "cancel", scope?: "turn" | "session"): ApprovalDecision {
  if (action === "approve") {
    return scope === "session" ? "acceptForSession" : "accept";
  }

  if (action === "deny") {
    return "decline";
  }

  return "cancel";
}

function toApprovalStatus(decision: ApprovalDecision): ApprovalRecord["status"] {
  switch (decision) {
    case "accept":
    case "acceptForSession":
      return "approved";
    case "decline":
      return "denied";
    case "cancel":
      return "canceled";
  }
}
