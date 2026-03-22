import { promises as fs } from "fs";
import type { ChannelAdapter, InboundMessage } from "../adapters/base";
import type { CodexClawConfig } from "../config/schema";
import { parseAdminCommand } from "../core/approvalCommands";
import type { AppServerClient, ApprovalDecision, ApprovalRequest } from "../codex/appServerClient";
import type { Logger } from "../logger";
import { PerThreadQueue } from "../queue/perThreadQueue";
import { SessionRouter, type RouteContext } from "../router/sessionRouter";
import type { ApprovalRecord, QueuedInboundMessage, StateStore } from "../storage/stateStore";

interface QueuedInboundPayload {
  message: InboundMessage;
  context: RouteContext;
}

export class Gateway {
  private readonly adaptersById = new Map<string, ChannelAdapter>();
  private readonly transportsById = new Map(this.config.transports.map((transport) => [transport.id, transport]));
  private dispatchPromise?: Promise<void>;
  private readonly activeInboundTasks = new Set<Promise<void>>();

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
    const requeued = await this.store.requeueProcessingInboundMessages();
    if (requeued > 0) {
      this.logger.warn("Requeued interrupted inbound messages from a previous process", { count: requeued });
    }

    await this.codex.start();

    await Promise.all(
      Array.from(this.adaptersById.values()).map((adapter) =>
        adapter.start((message) => this.handleInboundMessage(message)),
      ),
    );

    this.logger.info("Gateway started", {
      transports: Array.from(this.adaptersById.keys()),
      policyDefault: this.config.policy.default,
      allowRules: this.config.allow.map((rule) => ({
        kind: rule.kind,
        label: rule.label,
        transportId: rule.transportId,
      })),
      denyRules: this.config.deny.map((rule) => ({
        kind: rule.kind,
        label: rule.label,
        transportId: rule.transportId,
      })),
      admins: this.config.admins.map((admin) => ({
        transportId: admin.transportId,
        conversationId: admin.conversationId,
      })),
    });

    this.ensureInboundDispatcher();
  }

  private async handleInboundMessage(message: InboundMessage): Promise<void> {
    const payload = this.prepareInboundPayload(message);
    if (!payload) {
      return;
    }

    const enqueuedAt = new Date().toISOString();
    const enqueued = await this.store.enqueueInboundMessage({
      message,
      payloadJson: JSON.stringify(payload),
    });

    if (!enqueued) {
      this.logger.warn("Ignoring duplicate inbound message", {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
        messageId: message.messageId,
      });
      return;
    }

    this.logger.info("Inbound message enqueued", buildMessageLogContext(message, {
      routeKind: payload.context.kind,
      enqueuedAt,
      ingestDelayMs: diffMs(message.receivedAt, enqueuedAt),
    }));

    this.ensureInboundDispatcher();
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

    if (this.config.admins.length === 0) {
      this.logger.warn("Declining approval because no admin routes are configured", {
        requestId: request.requestId,
        kind: request.kind,
        threadId: request.threadId,
        turnId: request.turnId,
      });
      await this.codex.resolveApproval(approval.requestId, "decline");
      await this.store.updateApproval(approval.id, {
        status: "denied",
        decidedAt: new Date().toISOString(),
      });
      return;
    }

    const lines = [
      `CodexClaw approval ${approval.id}`,
      `Kind: ${request.kind}`,
      `Summary: ${request.summary}`,
      `Reply with: APPROVE ${approval.id}, APPROVE ${approval.id} SESSION, DENY ${approval.id}, or CANCEL ${approval.id}`,
    ];

    await Promise.all(
      this.config.admins.map((admin) =>
        this.sendMessage(
          admin.transportId,
          admin.conversationId,
          lines.join("\n"),
        ),
      ),
    );
  }

  private async handleAdminMessage(message: InboundMessage, context: RouteContext): Promise<void> {
    if (!context.allowedSenderIds?.includes(message.senderId)) {
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

  private prepareInboundPayload(message: InboundMessage): QueuedInboundPayload | undefined {
    const context = this.router.match(message);

    if (!context) {
      this.logger.debug("Ignoring message rejected by policy", {
        adapterId: message.adapterId,
        conversationId: message.conversationId,
        conversationType: message.conversationType,
        senderId: message.senderId,
        isKnownContact: message.isKnownContact,
        isFromSelf: message.isFromSelf,
        textPreview: previewText(message.text),
      });
      return undefined;
    }

    if (context.kind === "admin") {
      return { message, context };
    }

    if (message.isBotEcho) {
      this.logger.debug("Ignoring bot-authored echo", { conversationId: message.conversationId });
      return undefined;
    }

    if (message.isFromSelf && !this.config.bot.allowSelfMessages) {
      this.logger.debug("Ignoring self-authored message", {
        conversationId: message.conversationId,
        senderId: message.senderId,
        textPreview: previewText(message.text),
      });
      return undefined;
    }

    if (this.shouldIgnoreSelfAuthoredIMessageGroupMessage(message)) {
      this.logger.debug("Ignoring self-authored iMessage group message", {
        conversationId: message.conversationId,
        senderId: message.senderId,
        textPreview: previewText(message.text),
      });
      return undefined;
    }

    const triggerMode = this.triggerModeFor(message);
    if (!this.matchesTrigger(message, triggerMode)) {
      this.logger.debug("Ignoring message without required trigger", {
        conversationId: message.conversationId,
        senderId: message.senderId,
        triggerMode,
        addressedToBot: message.addressedToBot === true,
        textPreview: previewText(message.text),
      });
      return undefined;
    }

    return { message, context };
  }

  private ensureInboundDispatcher(): void {
    if (this.dispatchPromise) {
      return;
    }

    this.dispatchPromise = this.dispatchInboundMessages().finally(() => {
      this.dispatchPromise = undefined;
      void this.restartDispatcherIfNeeded();
    });
  }

  private async restartDispatcherIfNeeded(): Promise<void> {
    if (!await this.store.hasQueuedInboundMessages()) {
      return;
    }

    this.ensureInboundDispatcher();
  }

  private async dispatchInboundMessages(): Promise<void> {
    while (true) {
      const queuedMessage = await this.store.claimNextQueuedInboundMessage();
      if (!queuedMessage) {
        return;
      }

      this.scheduleQueuedInboundMessage(queuedMessage);
    }
  }

  private scheduleQueuedInboundMessage(queuedMessage: QueuedInboundMessage): void {
    const task = this.processQueuedInboundMessage(queuedMessage)
      .catch((error) => {
        this.logger.error("Failed to process queued inbound message", {
          adapterId: queuedMessage.adapterId,
          conversationId: queuedMessage.conversationId,
          inboundMessageId: queuedMessage.id,
          error,
        });
      })
      .finally(() => {
        this.activeInboundTasks.delete(task);
      });

    this.activeInboundTasks.add(task);
  }

  private async processQueuedInboundMessage(queuedMessage: QueuedInboundMessage): Promise<void> {
    let payload: QueuedInboundPayload;

    try {
      payload = JSON.parse(queuedMessage.payloadJson) as QueuedInboundPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.failInboundMessage(queuedMessage.id, `Invalid queued payload: ${message}`);
      throw error;
    }

    try {
      this.logger.info("Inbound message processing started", buildMessageLogContext(payload.message, {
        inboundMessageId: queuedMessage.id,
        queueStatus: queuedMessage.status,
        enqueuedAt: queuedMessage.createdAt,
        dequeuedAt: queuedMessage.startedAt,
        ingestDelayMs: diffMs(payload.message.receivedAt, queuedMessage.createdAt),
        queueWaitMs: diffMs(queuedMessage.createdAt, queuedMessage.startedAt),
      }));

      if (payload.context.kind === "admin") {
        await this.handleAdminMessage(payload.message, payload.context);
        await this.store.completeInboundMessage(queuedMessage.id);
        this.logger.info("Inbound admin message completed", buildMessageLogContext(payload.message, {
          inboundMessageId: queuedMessage.id,
          completedAt: new Date().toISOString(),
          queueWaitMs: diffMs(queuedMessage.createdAt, queuedMessage.startedAt),
          totalLatencyMs: diffMs(payload.message.receivedAt),
        }));
        return;
      }

      if (this.shouldIgnoreSelfAuthoredIMessageGroupMessage(payload.message)) {
        await this.store.completeInboundMessage(queuedMessage.id);
        this.logger.warn("Dropped self-authored iMessage group message from the queue without running Codex", buildMessageLogContext(payload.message, {
          inboundMessageId: queuedMessage.id,
          completedAt: new Date().toISOString(),
          queueWaitMs: diffMs(queuedMessage.createdAt, queuedMessage.startedAt),
          totalLatencyMs: diffMs(payload.message.receivedAt),
        }));
        return;
      }

      await this.processUserMessage(payload.message, payload.context, queuedMessage);
      await this.store.completeInboundMessage(queuedMessage.id);
    } catch (error) {
      await this.store.failInboundMessage(
        queuedMessage.id,
        error instanceof Error ? error.message : String(error),
      );
      this.logger.error("Inbound message processing failed", buildMessageLogContext(payload.message, {
        inboundMessageId: queuedMessage.id,
        queueWaitMs: diffMs(queuedMessage.createdAt, queuedMessage.startedAt),
        totalLatencyMs: diffMs(payload.message.receivedAt),
        error: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  }

  private async processUserMessage(
    message: InboundMessage,
    context: RouteContext,
    queuedMessage: QueuedInboundMessage,
  ): Promise<void> {
    const attachmentStageStartedAt = Date.now();
    const materializedAttachments = await this.materializeAttachments(message);
    const attachmentStageCompletedAt = new Date().toISOString();
    const session = await this.router.getOrCreateChatSession(message);
    const run = await this.store.createRun({
      chatSessionId: session.id,
      status: "queued",
      startedAt: new Date().toISOString(),
    });

    let result:
      | {
          turnId: string;
          finalResponse: string;
          attachments: InboundMessage["attachments"];
          threadId: string;
        }
      | undefined;

    try {
      await this.queue.enqueue(this.queueKey(message), async () => {
        const latestSession = await this.store.getChatSession(message.adapterId, message.conversationId) ?? session;
        const threadContext = {
          workspaceCwd: context.workspace.cwd,
          soulPath: this.config.bot.soulPath,
        };
        let threadId = latestSession.codexThreadId;

        if (threadId) {
          try {
            threadId = await this.codex.resumeThread(threadId, threadContext);
          } catch (error) {
            this.logger.warn("Failed to resume stored Codex thread; creating a new thread", {
              adapterId: message.adapterId,
              conversationId: message.conversationId,
              threadId,
              error: error instanceof Error ? error.message : String(error),
            });
            threadId = await this.codex.createThread(threadContext);
          }
        } else {
          threadId = await this.codex.createThread(threadContext);
        }

        if (threadId !== latestSession.codexThreadId) {
          await this.store.saveChatSession({
            ...latestSession,
            codexThreadId: threadId,
            updatedAt: new Date().toISOString(),
          });
        }

        const codexStartedAt = Date.now();

        this.logger.info("Codex turn started", buildMessageLogContext(message, {
          inboundMessageId: queuedMessage.id,
          runId: run.id,
          threadId,
          sessionId: latestSession.id,
          queueWaitMs: diffMs(queuedMessage.createdAt, queuedMessage.startedAt),
          attachmentMaterializationMs: Math.max(0, Date.parse(attachmentStageCompletedAt) - attachmentStageStartedAt),
          inboundAttachmentCount: message.attachments.length,
          materializedAttachmentCount: materializedAttachments.length,
        }));

        const turnRequest = {
          threadId,
          channel: message.channel,
          messageText: message.text.trim(),
          workspaceCwd: context.workspace.cwd,
          senderName: message.senderName,
          senderId: message.senderId,
          conversationId: message.conversationId,
          conversationName: context.label ?? message.conversationName ?? message.conversationId,
          attachments: materializedAttachments,
        };
        const turnStartPayload = await this.codex.buildTurnStartPayload(turnRequest);

        await this.store.updateRun(run.id, {
          status: "in_progress",
          codexRequestJson: JSON.stringify(turnStartPayload),
        });

        const turnResult = await this.codex.runTurn(turnRequest, turnStartPayload);

        this.logger.info("Codex turn completed", buildMessageLogContext(message, {
          inboundMessageId: queuedMessage.id,
          runId: run.id,
          threadId,
          turnId: turnResult.turnId,
          codexDurationMs: Date.now() - codexStartedAt,
          outboundAttachmentCount: turnResult.attachments.length,
          finalResponsePreview: previewText(turnResult.finalResponse),
        }));

        result = {
          ...turnResult,
          threadId,
        };
      });

      if (!result) {
        throw new Error("Codex turn completed without a result");
      }

      const deliveryStartedAt = Date.now();
      const outboundAttachments = await this.filterExistingAttachments(result.attachments);
      await this.sendMessage(
        message.adapterId,
        message.conversationId,
        result.finalResponse,
        outboundAttachments,
      );
      const completedAt = new Date().toISOString();

      this.logger.info("Outbound delivery completed", buildMessageLogContext(message, {
        inboundMessageId: queuedMessage.id,
        runId: run.id,
        threadId: result.threadId,
        turnId: result.turnId,
        deliveryDurationMs: Date.now() - deliveryStartedAt,
        outboundAttachmentCount: outboundAttachments.length,
        completedAt,
      }));

      await this.store.updateRun(run.id, {
        codexTurnId: result.turnId,
        status: "completed",
        completedAt,
        codexResponseJson: JSON.stringify({
          turnId: result.turnId,
          finalResponse: result.finalResponse,
          attachments: result.attachments,
          threadId: result.threadId,
        }),
      });

      this.logger.info("Inbound message completed", buildMessageLogContext(message, {
        inboundMessageId: queuedMessage.id,
        runId: run.id,
        threadId: result.threadId,
        turnId: result.turnId,
        enqueuedAt: queuedMessage.createdAt,
        dequeuedAt: queuedMessage.startedAt,
        completedAt,
        queueWaitMs: diffMs(queuedMessage.createdAt, queuedMessage.startedAt),
        totalLatencyMs: diffMs(message.receivedAt, completedAt),
      }));
    } catch (error) {
      const failedAt = new Date().toISOString();
      await this.store.updateRun(run.id, {
        status: "failed",
        completedAt: failedAt,
        errorText: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async sendMessage(
    adapterId: string,
    conversationId: string,
    text: string,
    attachments: InboundMessage["attachments"] = [],
  ): Promise<void> {
    const adapter = this.adaptersById.get(adapterId);

    if (!adapter) {
      throw new Error(`Unknown adapter: ${adapterId}`);
    }

    await adapter.sendMessage({ conversationId, text, attachments });
  }

  private triggerModeFor(message: InboundMessage): "none" | "addressed" {
    const transport = this.transportsById.get(message.adapterId);
    if (!transport) {
      return message.conversationType === "group" ? "addressed" : "none";
    }

    return message.conversationType === "group"
      ? transport.triggers.group
      : transport.triggers.direct;
  }

  private matchesTrigger(
    message: InboundMessage,
    triggerMode: "none" | "addressed",
  ): boolean {
    switch (triggerMode) {
      case "none":
        return true;
      case "addressed":
        return message.addressedToBot === true;
    }
  }

  private queueKey(message: InboundMessage): string {
    return `${message.adapterId}:${message.conversationId}`;
  }

  private shouldIgnoreSelfAuthoredIMessageGroupMessage(message: InboundMessage): boolean {
    return message.channel === "imessage"
      && message.conversationType === "group"
      && message.isFromSelf;
  }

  private async materializeAttachments(message: InboundMessage): Promise<InboundMessage["attachments"]> {
    const adapter = this.adaptersById.get(message.adapterId);

    if (!adapter || message.attachments.length === 0) {
      return [];
    }

    const materialized = await Promise.all(
      message.attachments.map(async (attachment) => {
        try {
          return await adapter.materializeAttachment(attachment);
        } catch (error) {
          this.logger.warn("Failed to materialize inbound attachment", {
            adapterId: message.adapterId,
            conversationId: message.conversationId,
            attachmentId: attachment.id,
            attachmentName: attachment.name,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      }),
    );

    return materialized.filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== undefined);
  }

  private async filterExistingAttachments(attachments: InboundMessage["attachments"]): Promise<InboundMessage["attachments"]> {
    const existing = await Promise.all(
      attachments.map(async (attachment) => {
        if (!attachment.localPath) {
          return undefined;
        }

        try {
          await fs.access(attachment.localPath);
          return attachment;
        } catch {
          this.logger.warn("Skipping outbound attachment because the file does not exist", {
            localPath: attachment.localPath,
          });
          return undefined;
        }
      }),
    );

    return existing.filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== undefined);
  }
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

function previewText(value: string, maxLength = 80): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function buildMessageLogContext(message: InboundMessage, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adapterId: message.adapterId,
    channel: message.channel,
    messageId: message.messageId,
    conversationId: message.conversationId,
    conversationName: message.conversationName,
    conversationType: message.conversationType,
    senderId: message.senderId,
    senderName: message.senderName,
    receivedAt: message.receivedAt,
    attachmentCount: message.attachments.length,
    textPreview: previewText(message.text),
    ...extra,
  };
}

function diffMs(start: string | undefined, end: string | number = Date.now()): number | undefined {
  if (!start) {
    return undefined;
  }

  const startTime = Date.parse(start);
  if (Number.isNaN(startTime)) {
    return undefined;
  }

  const endTime = typeof end === "number" ? end : Date.parse(end);
  if (Number.isNaN(endTime)) {
    return undefined;
  }

  return Math.max(0, endTime - startTime);
}
