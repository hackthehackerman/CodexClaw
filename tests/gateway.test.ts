import { strict as assert } from "assert";
import { Gateway } from "../src/runtime/gateway";
import type {
  AdapterEventHandlers,
  AdapterFeatures,
  ApprovalPrompt,
  ChannelAdapter,
  Attachment,
  InboundMessage,
  OutboundMessage,
} from "../src/adapters/base";
import type { CodexClawConfig } from "../src/config/schema";
import type { ApprovalRequest, ApprovalRequestHandler } from "../src/codex/appServerClient";
import { test } from "./helpers/harness";
import { TestLogger } from "./helpers/testLogger";

class FakeAdapter implements ChannelAdapter {
  readonly sentMessages: OutboundMessage[] = [];
  readonly approvalPrompts: Array<Record<string, unknown>> = [];
  private handlers?: AdapterEventHandlers;
  features: AdapterFeatures = {
    approvalTextCommands: false,
    approvalInteractive: false,
  };
  approvalPromptError?: Error;

  constructor(
    readonly id: string,
    readonly channel: "imessage" | "telegram",
  ) {}

  async start(handlers: AdapterEventHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
  }

  async emit(message: InboundMessage): Promise<void> {
    if (!this.handlers?.onMessage) {
      throw new Error("adapter not started");
    }

    await this.handlers.onMessage(message);
  }

  async sendMessage(message: OutboundMessage): Promise<void> {
    this.sentMessages.push(message);
  }

  async materializeAttachment(attachment: Attachment): Promise<Attachment> {
    return attachment;
  }

  getFeatures(): AdapterFeatures {
    return this.features;
  }

  async sendApprovalPrompt(prompt: ApprovalPrompt): Promise<void> {
    if (this.approvalPromptError) {
      throw this.approvalPromptError;
    }

    this.approvalPrompts.push(prompt as unknown as Record<string, unknown>);
  }
}

class FakeCodexClient {
  approvalHandler?: ApprovalRequestHandler;
  resolvedApprovals: Array<{ requestId: string; decision: string }> = [];

  setApprovalRequestHandler(handler: ApprovalRequestHandler): void {
    this.approvalHandler = handler;
  }

  async start(): Promise<void> {}
  async createThread(): Promise<string> { return "thread"; }
  async resumeThread(threadId: string): Promise<string> { return threadId; }
  async runTurn(): Promise<never> { throw new Error("not used"); }
  async resolveApproval(requestId: string, decision: string): Promise<void> {
    this.resolvedApprovals.push({ requestId, decision });
  }
}

class FakeStore {
  approvals: Array<Record<string, unknown>> = [];
  enqueuedMessages: InboundMessage[] = [];
  enqueuedPayloads: string[] = [];

  async getChatSession(): Promise<undefined> { return undefined; }
  async saveChatSession(): Promise<void> {}
  async createRun(): Promise<never> { throw new Error("not used"); }
  async updateRun(): Promise<void> {}
  async createApproval(input: Record<string, unknown>) {
    const approval = { id: `APPR_${this.approvals.length + 1}`, ...input };
    this.approvals.push(approval);
    return approval as {
      id: string;
      runId: string;
      requestId: string;
      kind: "command" | "fileChange" | "permissions";
      threadId: string;
      turnId: string;
      itemId: string;
      payloadJson: string;
      status: "pending" | "approved" | "denied" | "canceled";
      decidedAt?: string;
    };
  }
  async getApproval(): Promise<undefined> { return undefined; }
  async updateApproval(): Promise<void> {}
  async enqueueInboundMessage(input: { message: InboundMessage; payloadJson?: string }): Promise<boolean> {
    this.enqueuedMessages.push(input.message);
    if (input.payloadJson) {
      this.enqueuedPayloads.push(input.payloadJson);
    }
    return true;
  }
  async claimNextQueuedInboundMessage(): Promise<undefined> { return undefined; }
  async hasQueuedInboundMessages(): Promise<boolean> { return false; }
  async completeInboundMessage(): Promise<void> {}
  async failInboundMessage(): Promise<void> {}
  async requeueProcessingInboundMessages(): Promise<number> { return 0; }
}

function buildConfig(): CodexClawConfig {
  return {
    bot: {
      name: "Yanny",
      aliases: ["yanny"],
      soulPath: "/tmp/soul.md",
      workspaceId: "main",
      allowSelfMessages: false,
    },
    codex: {
      command: ["codex", "app-server"],
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      networkAccess: "restricted",
      summary: "concise",
    },
    storage: {
      dbPath: "/tmp/codexclaw.db",
    },
    host: {
      keepAwake: true,
    },
    web: {
      enabled: true,
      host: "127.0.0.1",
      port: 4188,
    },
    policy: {
      default: "deny",
    },
    allow: [],
    deny: [],
    admins: [
      {
        transportId: "primary-imessage",
        conversationId: "admin-imessage",
        allowedSenderIds: ["owner"],
        commandFormat: "strict",
      },
      {
        transportId: "primary-telegram",
        conversationId: "123456",
        allowedSenderIds: ["123456"],
        commandFormat: "strict",
      },
    ],
    transports: [
      {
        id: "primary-imessage",
        channel: "imessage",
        provider: "custom",
        enabled: true,
        triggers: {
          direct: "addressed",
          group: "addressed",
        },
        config: {},
      },
      {
        id: "primary-telegram",
        channel: "telegram",
        provider: "bot-api",
        enabled: true,
        triggers: {
          direct: "none",
          group: "addressed",
        },
        config: {
          botToken: "token",
          mode: "polling",
          pollTimeoutSeconds: 30,
          allowedUpdates: ["message"],
        },
      },
    ],
    workspaces: [{ id: "main", cwd: "/tmp/workspace" }],
  };
}

function createGatewayHarness() {
  const logger = new TestLogger();
  const imessageAdapter = new FakeAdapter("primary-imessage", "imessage");
  const telegramAdapter = new FakeAdapter("primary-telegram", "telegram");
  const codex = new FakeCodexClient();
  const store = new FakeStore();
  const config = buildConfig();
  const routerStub = {
    match(message: InboundMessage) {
      return routerStub.matchAdmin(message) ?? routerStub.matchUser(message);
    },
    matchUser(_message?: InboundMessage) {
      return {
        kind: "user" as const,
        workspace: config.workspaces[0]!,
      };
    },
    matchAdmin(message: InboundMessage) {
      if (!config.admins.some((admin) =>
        admin.transportId === message.adapterId && admin.conversationId === message.conversationId
      )) {
        return undefined;
      }

      return {
        kind: "admin" as const,
        workspace: config.workspaces[0]!,
        label: "admin",
        allowedSenderIds: config.admins.find((admin) =>
          admin.transportId === message.adapterId && admin.conversationId === message.conversationId
        )?.allowedSenderIds,
      };
    },
    async getOrCreateChatSession() { throw new Error("not used"); },
  };

  const gateway = new Gateway(
    config,
    [imessageAdapter, telegramAdapter],
    routerStub as never,
    {
      enqueue: async (_key: string, task: () => Promise<void>) => {
        await task();
      },
    } as never,
    codex as never,
    store as never,
    logger,
  );

  return {
    gateway,
    config,
    codex,
    store,
    imessageAdapter,
    telegramAdapter,
    logger,
  };
}

function inboundMessage(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    adapterId: "primary-telegram",
    channel: "telegram",
    messageId: "1",
    conversationId: "123",
    conversationName: "chat",
    conversationType: "direct",
    senderId: "111",
    senderName: "User",
    isKnownContact: undefined,
    text: "hello",
    attachments: [],
    isFromSelf: false,
    addressedToBot: false,
    receivedAt: new Date().toISOString(),
    raw: {},
    ...overrides,
  };
}

test("Gateway sends approval prompts to all configured admin conversations", async () => {
  const { gateway, codex, store, imessageAdapter, telegramAdapter } = createGatewayHarness();

  await gateway.start();
  await codex.approvalHandler?.({
    requestId: "req-1",
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    summary: "Run tests",
    payload: {},
  } satisfies ApprovalRequest);

  assert.equal(imessageAdapter.sentMessages.length, 1);
  assert.equal(telegramAdapter.sentMessages.length, 1);
  assert.match(imessageAdapter.sentMessages[0]!.text, /CodexClaw approval APPR_1/);
  assert.match(telegramAdapter.sentMessages[0]!.text, /Reply with: APPROVE APPR_1/);
  assert.equal(store.approvals.length, 1);
});

test("Gateway declines approvals cleanly when interactive approval delivery fails everywhere", async () => {
  const { gateway, codex, telegramAdapter, config } = createGatewayHarness();
  config.admins = [{
    transportId: "primary-telegram",
    conversationId: "123456",
    allowedSenderIds: ["123456"],
    commandFormat: "strict",
  }];
  telegramAdapter.features = {
    approvalTextCommands: false,
    approvalInteractive: true,
  };
  telegramAdapter.approvalPromptError = new Error("Bad Request: BUTTON_DATA_INVALID");

  await gateway.start();
  await codex.approvalHandler?.({
    requestId: "req-telegram",
    kind: "command",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    summary: "Run tests",
    payload: {},
  } satisfies ApprovalRequest);

  assert.deepEqual(codex.resolvedApprovals, [{ requestId: "req-telegram", decision: "decline" }]);
});

test("Gateway allows Telegram direct messages when transport trigger is none", async () => {
  const { gateway, store, telegramAdapter } = createGatewayHarness();
  await gateway.start();

  await telegramAdapter.emit(inboundMessage({
    text: "hello from telegram dm",
  }));

  assert.equal(store.enqueuedMessages.length, 1);
});

test("Gateway requires addressed Telegram group messages when transport trigger is addressed", async () => {
  const { gateway, store, telegramAdapter } = createGatewayHarness();
  await gateway.start();

  await telegramAdapter.emit(inboundMessage({
    conversationId: "-100123",
    conversationType: "group",
    text: "hello group",
    addressedToBot: false,
  }));
  await telegramAdapter.emit(inboundMessage({
    messageId: "2",
    conversationId: "-100123",
    conversationType: "group",
    text: "hello group",
    addressedToBot: true,
  }));

  assert.equal(store.enqueuedMessages.length, 1);
  assert.equal(store.enqueuedMessages[0]?.messageId, "2");
});

test("Gateway keeps Telegram shared user/admin chats on the user path because admin actions use buttons, not text commands", async () => {
  const { gateway, store, telegramAdapter, config } = createGatewayHarness();
  config.allow.push({
    kind: "conversation",
    transportId: "primary-telegram",
    conversationId: "123456",
    label: "my Telegram DM",
  });

  await gateway.start();

  await telegramAdapter.emit(inboundMessage({
    conversationId: "123456",
    senderId: "123456",
    text: "hello",
  }));
  await telegramAdapter.emit(inboundMessage({
    messageId: "admin-2",
    conversationId: "123456",
    senderId: "123456",
    text: "APPROVE APPR_1",
  }));

  assert.equal(store.enqueuedMessages.length, 2);
  const firstPayload = JSON.parse(store.enqueuedPayloads[0] ?? "{}") as { context?: { kind?: string }, message?: { text?: string } };
  const secondPayload = JSON.parse(store.enqueuedPayloads[1] ?? "{}") as { context?: { kind?: string }, message?: { text?: string } };

  assert.equal(firstPayload.message?.text, "hello");
  assert.equal(firstPayload.context?.kind, "user");
  assert.equal(secondPayload.message?.text, "APPROVE APPR_1");
  assert.equal(secondPayload.context?.kind, "user");
});

test("Gateway requires explicit @alias addressing on iMessage direct messages when trigger is addressed", async () => {
  const { gateway, store, imessageAdapter } = createGatewayHarness();
  await gateway.start();

  await imessageAdapter.emit(inboundMessage({
    adapterId: "primary-imessage",
    channel: "imessage",
    conversationId: "any;-;+10000000000",
    text: "hello from imessage",
    addressedToBot: false,
  }));
  await imessageAdapter.emit(inboundMessage({
    adapterId: "primary-imessage",
    channel: "imessage",
    messageId: "4",
    conversationId: "any;-;+10000000000",
    text: "hello @yanny from imessage",
    addressedToBot: true,
  }));

  assert.equal(store.enqueuedMessages.length, 1);
  assert.equal(store.enqueuedMessages[0]?.messageId, "4");
});

test("Gateway requires addressed iMessage group messages", async () => {
  const { gateway, store, imessageAdapter } = createGatewayHarness();
  await gateway.start();

  await imessageAdapter.emit(inboundMessage({
    adapterId: "primary-imessage",
    channel: "imessage",
    conversationId: "any;+;chat123",
    conversationType: "group",
    text: "is it still named yanny not yaddy?",
    addressedToBot: false,
  }));
  await imessageAdapter.emit(inboundMessage({
    adapterId: "primary-imessage",
    channel: "imessage",
    messageId: "group-2",
    conversationId: "any;+;chat123",
    conversationType: "group",
    text: "hello team @yanny are you there",
    addressedToBot: true,
  }));

  assert.equal(store.enqueuedMessages.length, 1);
  assert.equal(store.enqueuedMessages[0]?.messageId, "group-2");
});

test("Gateway ignores self-authored iMessage group messages even when self messages are allowed", async () => {
  const { gateway, store, imessageAdapter, config } = createGatewayHarness();
  config.bot.allowSelfMessages = true;

  await gateway.start();

  await imessageAdapter.emit(inboundMessage({
    adapterId: "primary-imessage",
    channel: "imessage",
    messageId: "group-self-1",
    conversationId: "any;+;chat123",
    conversationType: "group",
    senderId: "self",
    isFromSelf: true,
    text: "yanny please answer this",
    addressedToBot: true,
  }));

  assert.equal(store.enqueuedMessages.length, 0);
});
