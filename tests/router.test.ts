import { strict as assert } from "assert";
import { SessionRouter } from "../src/router/sessionRouter";
import type { InboundMessage } from "../src/adapters/base";
import type { AccessRule, WorkspaceConfig } from "../src/config/schema";
import { test } from "./helpers/harness";
import { TestLogger } from "./helpers/testLogger";

const workspaces: WorkspaceConfig[] = [{ id: "main", cwd: "/tmp/workspace" }];

function createRouter(options?: {
  allowRules?: AccessRule[];
  denyRules?: AccessRule[];
  admins?: Array<{ transportId: string; conversationId: string; allowedSenderIds: string[] }>;
  policyDefault?: "allow" | "deny";
}): SessionRouter {
  return new SessionRouter(
    {
      workspaceId: "main",
      policyDefault: options?.policyDefault ?? "deny",
      allowRules: options?.allowRules ?? [],
      denyRules: options?.denyRules ?? [],
      admins: options?.admins ?? [],
    },
    workspaces,
    {} as never,
    new TestLogger(),
  );
}

function message(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    adapterId: "primary-telegram",
    channel: "telegram",
    messageId: "1:1",
    conversationId: "123",
    conversationName: "chat",
    conversationType: "direct",
    senderId: "111",
    senderName: "Test User",
    isKnownContact: undefined,
    text: "yanny ping",
    attachments: [],
    isFromSelf: false,
    receivedAt: new Date().toISOString(),
    raw: {},
    ...overrides,
  };
}

test("SessionRouter allows Telegram direct messages when contact scope is any", () => {
  const router = createRouter({
    allowRules: [
      {
        kind: "direct_messages",
        transportId: "primary-telegram",
        contactScope: "any",
      },
    ],
  });

  const result = router.match(message({}));
  assert.equal(result?.kind, "user");
});

test("SessionRouter does not match Telegram direct messages for known-contact scopes", () => {
  const router = createRouter({
    allowRules: [
      {
        kind: "direct_messages",
        transportId: "primary-telegram",
        contactScope: "known",
      },
    ],
  });

  const result = router.match(message({ isKnownContact: undefined }));
  assert.equal(result, undefined);
});

test("SessionRouter supports Telegram group allow and sender deny rules", () => {
  const router = createRouter({
    allowRules: [
      {
        kind: "conversation",
        transportId: "primary-telegram",
        conversationId: "-100123",
        label: "group",
      },
    ],
    denyRules: [
      {
        kind: "sender",
        transportId: "primary-telegram",
        senderId: "999",
      },
    ],
  });

  assert.equal(
    router.match(message({ conversationId: "-100123", conversationType: "group", senderId: "111" }))?.kind,
    "user",
  );
  assert.equal(
    router.match(message({ conversationId: "-100123", conversationType: "group", senderId: "999" })),
    undefined,
  );
});

test("SessionRouter recognizes Telegram admin conversations", () => {
  const router = createRouter({
    admins: [
      {
        transportId: "primary-telegram",
        conversationId: "555",
        allowedSenderIds: ["111"],
      },
    ],
  });

  const result = router.match(message({ conversationId: "555" }));
  assert.equal(result?.kind, "admin");
  assert.deepEqual(result?.allowedSenderIds, ["111"]);
});
