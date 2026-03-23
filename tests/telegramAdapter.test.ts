import { strict as assert } from "assert";
import http from "http";
import os from "os";
import path from "path";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import type { AddressInfo } from "net";
import { TelegramAdapter } from "../src/adapters/telegramAdapter";
import type { TelegramTransportConfig } from "../src/config/schema";
import type { InboundMessage } from "../src/adapters/base";
import { test } from "./helpers/harness";
import { TestLogger } from "./helpers/testLogger";

interface RecordedRequest {
  method: string;
  pathname: string;
  headers: http.IncomingHttpHeaders;
  json?: unknown;
  body: Buffer;
}

async function createTelegramApiServer(options?: {
  getUpdates?: (call: number, body: Record<string, unknown>) => unknown[];
  files?: Record<string, { bytes: Buffer; contentType?: string }>;
  botMethodHandlers?: Record<
    string,
    (
      call: number,
      record: RecordedRequest,
      response: http.ServerResponse,
      request: http.IncomingMessage,
    ) => void | Promise<void>
  >;
}) {
  const requests: RecordedRequest[] = [];
  const methodCalls = new Map<string, number>();
  const token = "test-token";

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const body = await readRequestBody(request);
    const record: RecordedRequest = {
      method: request.method ?? "GET",
      pathname: url.pathname,
      headers: request.headers,
      body,
    };

    if (body.length > 0 && request.headers["content-type"]?.includes("application/json")) {
      record.json = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    }

    requests.push(record);

    const botMethod = url.pathname.startsWith(`/bot${token}/`)
      ? url.pathname.slice(`/bot${token}/`.length)
      : undefined;
    const botMethodCall = botMethod
      ? (methodCalls.get(botMethod) ?? 0) + 1
      : 0;
    if (botMethod) {
      methodCalls.set(botMethod, botMethodCall);
      const handler = options?.botMethodHandlers?.[botMethod];
      if (handler) {
        await handler(botMethodCall, record, response, request);
        return;
      }
    }

    if (url.pathname === `/bot${token}/getMe`) {
      return respondJson(response, {
        ok: true,
        result: {
          id: 9001,
          is_bot: true,
          first_name: "Yanny",
          username: "YannyBot",
        },
      });
    }

    if (url.pathname === `/bot${token}/getUpdates`) {
      return respondJson(response, {
        ok: true,
        result: options?.getUpdates?.(botMethodCall, (record.json ?? {}) as Record<string, unknown>) ?? [],
      });
    }

    if (url.pathname === `/bot${token}/getFile`) {
      const fileId = String((record.json as Record<string, unknown>).file_id);
      return respondJson(response, {
        ok: true,
        result: {
          file_id: fileId,
          file_path: `files/${fileId}`,
        },
      });
    }

    if (url.pathname.startsWith(`/file/bot${token}/`)) {
      const key = url.pathname.slice(`/file/bot${token}/`.length);
      const file = options?.files?.[key];
      if (!file) {
        response.statusCode = 404;
        response.end("missing");
        return;
      }

      response.statusCode = 200;
      if (file.contentType) {
        response.setHeader("Content-Type", file.contentType);
      }
      response.end(file.bytes);
      return;
    }

    if (
      url.pathname === `/bot${token}/sendMessage`
      || url.pathname === `/bot${token}/editMessageText`
      || url.pathname === `/bot${token}/answerCallbackQuery`
      || url.pathname === `/bot${token}/sendPhoto`
      || url.pathname === `/bot${token}/sendDocument`
    ) {
      return respondJson(response, { ok: true, result: { message_id: 1 } });
    }

    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    token,
    requests,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function createAdapter(botToken: string, logger = new TestLogger()): TelegramAdapter {
  const config: TelegramTransportConfig = {
    id: "primary-telegram",
    channel: "telegram",
    provider: "bot-api",
    enabled: true,
    triggers: {
      direct: "none",
      group: "addressed",
    },
    config: {
      botToken,
      mode: "polling",
      pollTimeoutSeconds: 1,
      allowedUpdates: ["message"],
    },
  };

  return new TelegramAdapter(config, ["yanny"], logger);
}

test("TelegramAdapter normalizes private slash commands and group mentions into addressed messages", async () => {
  const api = await createTelegramApiServer({
    getUpdates(call) {
      if (call > 1) {
        return [];
      }

      return [
        {
          update_id: 101,
          message: {
            message_id: 7,
            date: 1_700_000_000,
            chat: { id: 42, type: "private", first_name: "Demo" },
            from: { id: 111, is_bot: false, first_name: "Demo", username: "demo_user" },
            text: "/yanny@YannyBot hello there",
          },
        },
        {
          update_id: 102,
          message: {
            message_id: 8,
            date: 1_700_000_010,
            chat: { id: -100123, type: "supergroup", title: "group chat" },
            from: { id: 222, is_bot: false, first_name: "GroupUser" },
            caption: "@YannyBot look at this",
            photo: [
              { file_id: "small", file_unique_id: "a", width: 100, height: 100, file_size: 1000 },
              { file_id: "big", file_unique_id: "b", width: 500, height: 500, file_size: 5000 },
            ],
          },
        },
      ];
    },
  });

  const previousBaseUrl = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL;
  process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = api.baseUrl;

  const adapter = createAdapter(api.token);
  const messages: InboundMessage[] = [];

  try {
    const done = new Promise<void>((resolve) => {
      void adapter.start({
        onMessage: async (message) => {
          messages.push(message);
          if (messages.length === 2) {
            resolve();
          }
        },
      });
    });

    await done;
    await adapter.stop();

    assert.equal(messages[0]?.conversationType, "direct");
    assert.equal(messages[0]?.text, "hello there");
    assert.equal(messages[0]?.addressedToBot, true);
    assert.equal(messages[0]?.messageId, "42:7");

    assert.equal(messages[1]?.conversationType, "group");
    assert.equal(messages[1]?.text, "look at this");
    assert.equal(messages[1]?.addressedToBot, true);
    assert.equal(messages[1]?.attachments[0]?.type, "image");
    assert.equal(messages[1]?.attachments[0]?.id, "big");
  } finally {
    process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = previousBaseUrl;
    await api.close();
  }
});

test("TelegramAdapter retries the same update until the handler succeeds", async () => {
  const api = await createTelegramApiServer({
    getUpdates(_call, body) {
      if (body.offset === 202) {
        return [];
      }

      return [
        {
          update_id: 201,
          message: {
            message_id: 5,
            date: 1_700_000_100,
            chat: { id: 99, type: "private", first_name: "Retry" },
            from: { id: 123, is_bot: false, first_name: "Retry" },
            text: "/yanny retry me",
          },
        },
      ];
    },
  });

  const previousBaseUrl = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL;
  process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = api.baseUrl;

  const adapter = createAdapter(api.token);
  let attempts = 0;

  try {
    const done = new Promise<void>((resolve) => {
      void adapter.start({
        onMessage: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("try again");
          }
          resolve();
        },
      });
    });

    await done;
    await adapter.stop();

    assert.equal(attempts, 2);
    const getUpdatesBodies = api.requests
      .filter((request) => request.pathname.endsWith("/getUpdates"))
      .map((request) => request.json as Record<string, unknown>);
    assert.equal(getUpdatesBodies[0]?.offset, undefined);
    assert.equal(getUpdatesBodies[1]?.offset, undefined);
  } finally {
    process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = previousBaseUrl;
    await api.close();
  }
});

test("TelegramAdapter classifies voice and audio documents as audio attachments", async () => {
  const api = await createTelegramApiServer({
    getUpdates(call) {
      if (call > 1) {
        return [];
      }

      return [
        {
          update_id: 301,
          message: {
            message_id: 1,
            date: 1_700_000_200,
            chat: { id: 77, type: "private", first_name: "Audio" },
            from: { id: 333, is_bot: false, first_name: "Audio" },
            text: "/yanny transcribe this",
            voice: {
              file_id: "voice-file",
              file_unique_id: "voice-unique",
              mime_type: "audio/ogg",
            },
          },
        },
        {
          update_id: 302,
          message: {
            message_id: 2,
            date: 1_700_000_201,
            chat: { id: 78, type: "private", first_name: "AudioDoc" },
            from: { id: 334, is_bot: false, first_name: "AudioDoc" },
            text: "/yanny use this doc",
            document: {
              file_id: "document-file",
              file_unique_id: "document-unique",
              file_name: "note.m4a",
              mime_type: "audio/mp4",
            },
          },
        },
      ];
    },
    files: {
      "files/voice-file": { bytes: Buffer.from("voice-bytes"), contentType: "audio/ogg" },
      "files/document-file": { bytes: Buffer.from("document-bytes"), contentType: "audio/mp4" },
    },
  });

  const previousBaseUrl = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL;
  process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = api.baseUrl;

  const adapter = createAdapter(api.token);
  const messages: InboundMessage[] = [];

  try {
    const done = new Promise<void>((resolve) => {
      void adapter.start({
        onMessage: async (message) => {
          messages.push(message);
          if (messages.length === 2) {
            resolve();
          }
        },
      });
    });

    await done;

    assert.equal(messages[0]?.attachments[0]?.type, "audio");
    assert.equal(messages[1]?.attachments[0]?.type, "audio");

    const materialized = await adapter.materializeAttachment(messages[0]!.attachments[0]!);
    assert.ok(materialized.localPath);
    assert.equal(await readFile(materialized.localPath!, "utf8"), "voice-bytes");

    await adapter.stop();
  } finally {
    process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = previousBaseUrl;
    await api.close();
  }
});

test("TelegramAdapter sends text, photos, and documents through Bot API methods", async () => {
  const api = await createTelegramApiServer();
  const previousBaseUrl = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL;
  process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = api.baseUrl;

  const adapter = createAdapter(api.token);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-telegram-send-"));

  try {
    await adapter.start({
      onMessage: async () => undefined,
    });

    const imagePath = path.join(tempDir, "image.png");
    const filePath = path.join(tempDir, "file.txt");
    await writeFile(imagePath, "image-bytes", "utf8");
    await writeFile(filePath, "file-bytes", "utf8");

    await adapter.sendMessage({
      conversationId: "12345",
      text: "hello telegram",
      attachments: [
        { type: "image", localPath: imagePath, name: "image.png", mimeType: "image/png" },
        { type: "file", localPath: filePath, name: "file.txt", mimeType: "text/plain" },
      ],
    });

    await adapter.stop();

    assert.ok(api.requests.some((request) => request.pathname.endsWith("/sendMessage")));
    assert.ok(api.requests.some((request) => request.pathname.endsWith("/sendPhoto")));
    assert.ok(api.requests.some((request) => request.pathname.endsWith("/sendDocument")));
  } finally {
    process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = previousBaseUrl;
    await rm(tempDir, { recursive: true, force: true });
    await api.close();
  }
});

test("TelegramAdapter sends a single image reply as sendPhoto with caption when the text fits", async () => {
  const api = await createTelegramApiServer();
  const previousBaseUrl = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL;
  process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = api.baseUrl;

  const adapter = createAdapter(api.token);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-telegram-caption-"));

  try {
    await adapter.start({
      onMessage: async () => undefined,
    });

    const imagePath = path.join(tempDir, "image.png");
    await writeFile(imagePath, "image-bytes", "utf8");

    await adapter.sendMessage({
      conversationId: "12345",
      text: "hello telegram",
      attachments: [
        { type: "image", localPath: imagePath, name: "image.png", mimeType: "image/png" },
      ],
    });

    await adapter.stop();

    const sendPhotoRequests = api.requests.filter((request) => request.pathname.endsWith("/sendPhoto"));
    assert.equal(sendPhotoRequests.length, 1);
    assert.equal(api.requests.some((request) => request.pathname.endsWith("/sendMessage")), false);
    assert.match(sendPhotoRequests[0]!.body.toString("utf8"), /name="caption"\r\n\r\nhello telegram\r\n/);
  } finally {
    process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = previousBaseUrl;
    await rm(tempDir, { recursive: true, force: true });
    await api.close();
  }
});

test("TelegramAdapter falls back to sendMessage before sendPhoto when the text is too long for a caption", async () => {
  const api = await createTelegramApiServer();
  const previousBaseUrl = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL;
  process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = api.baseUrl;

  const adapter = createAdapter(api.token);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-telegram-long-caption-"));

  try {
    await adapter.start({
      onMessage: async () => undefined,
    });

    const imagePath = path.join(tempDir, "image.png");
    await writeFile(imagePath, "image-bytes", "utf8");

    await adapter.sendMessage({
      conversationId: "12345",
      text: "x".repeat(1025),
      attachments: [
        { type: "image", localPath: imagePath, name: "image.png", mimeType: "image/png" },
      ],
    });

    await adapter.stop();

    assert.ok(api.requests.some((request) => request.pathname.endsWith("/sendMessage")));
    assert.ok(api.requests.some((request) => request.pathname.endsWith("/sendPhoto")));
  } finally {
    process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = previousBaseUrl;
    await rm(tempDir, { recursive: true, force: true });
    await api.close();
  }
});

test("TelegramAdapter retries transient sendPhoto connection resets", async () => {
  const api = await createTelegramApiServer({
    botMethodHandlers: {
      sendPhoto(call, _record, response, request) {
        if (call === 1) {
          request.socket.destroy();
          return;
        }

        respondJson(response, { ok: true, result: { message_id: 1 } });
      },
    },
  });
  const previousBaseUrl = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL;
  process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = api.baseUrl;

  const adapter = createAdapter(api.token);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-telegram-retry-"));

  try {
    await adapter.start({
      onMessage: async () => undefined,
    });

    const imagePath = path.join(tempDir, "image.png");
    await writeFile(imagePath, "image-bytes", "utf8");

    await adapter.sendMessage({
      conversationId: "12345",
      text: "hello telegram",
      attachments: [
        { type: "image", localPath: imagePath, name: "image.png", mimeType: "image/png" },
      ],
    });

    await adapter.stop();

    assert.equal(api.requests.filter((request) => request.pathname.endsWith("/sendPhoto")).length, 2);
  } finally {
    process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = previousBaseUrl;
    await rm(tempDir, { recursive: true, force: true });
    await api.close();
  }
});

test("TelegramAdapter includes the Telegram method name after delivery retries are exhausted", async () => {
  const api = await createTelegramApiServer({
    botMethodHandlers: {
      sendPhoto(_call, _record, response) {
        response.statusCode = 503;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: false,
          description: "temporary outage",
        }));
      },
    },
  });
  const previousBaseUrl = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL;
  process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = api.baseUrl;

  const adapter = createAdapter(api.token);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codexclaw-telegram-method-error-"));

  try {
    await adapter.start({
      onMessage: async () => undefined,
    });

    const imagePath = path.join(tempDir, "image.png");
    await writeFile(imagePath, "image-bytes", "utf8");

    await assert.rejects(
      adapter.sendMessage({
        conversationId: "12345",
        text: "hello telegram",
        attachments: [
          { type: "image", localPath: imagePath, name: "image.png", mimeType: "image/png" },
        ],
      }),
      /Telegram API sendPhoto failed: temporary outage/,
    );

    assert.equal(api.requests.filter((request) => request.pathname.endsWith("/sendPhoto")).length, 3);
    await adapter.stop();
  } finally {
    process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = previousBaseUrl;
    await rm(tempDir, { recursive: true, force: true });
    await api.close();
  }
});

test("TelegramAdapter sends approval prompts with inline buttons and handles callback queries", async () => {
  const api = await createTelegramApiServer({
    getUpdates(call) {
      if (call > 1) {
        return [];
      }

      return [
        {
          update_id: 401,
          callback_query: {
            id: "cbq-1",
            from: { id: 111, is_bot: false, first_name: "Demo" },
            data: "ca:APPR_1:o",
            message: {
              message_id: 99,
              date: 1_700_000_300,
              chat: { id: 42, type: "private", first_name: "Demo" },
              from: { id: 9001, is_bot: true, first_name: "YannyBot" },
              text: "approval prompt",
            },
          },
        },
      ];
    },
  });
  const previousBaseUrl = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL;
  process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = api.baseUrl;

  const adapter = createAdapter(api.token);
  const approvalActions: Array<{ approvalId: string; action: string }> = [];

  try {
    const done = new Promise<void>((resolve) => {
      void adapter.start({
        onMessage: async () => undefined,
        onApprovalAction: async (action) => {
          approvalActions.push({
            approvalId: action.approvalId,
            action: action.action,
          });
          resolve();
        },
      });
    });

    await adapter.sendApprovalPrompt({
      conversationId: "42",
      approvalId: "APPR_1",
      kind: "command",
      summary: "Run tests",
      actions: ["approve_once", "approve_session", "deny"],
    });

    await done;
    await adapter.finalizeApprovalPrompt({
      approvalId: "APPR_1",
      status: "approved",
      action: "approve_once",
      actorName: "Demo",
      conversationId: "42",
      messageId: "99",
    });
    await adapter.stop();

    assert.deepEqual(approvalActions, [{ approvalId: "APPR_1", action: "approve_once" }]);

    const sendMessageRequest = api.requests.find((request) => request.pathname.endsWith("/sendMessage"));
    assert.ok(sendMessageRequest);
    assert.deepEqual((sendMessageRequest?.json as Record<string, unknown>).reply_markup, {
      inline_keyboard: [[
        { text: "Approve once", callback_data: "ca:APPR_1:o" },
        { text: "Approve session", callback_data: "ca:APPR_1:s" },
        { text: "Deny", callback_data: "ca:APPR_1:d" },
      ]],
    });
    const buttons = (((sendMessageRequest?.json as Record<string, unknown>).reply_markup as {
      inline_keyboard: Array<Array<{ callback_data: string }>>;
    }).inline_keyboard[0] ?? []);
    for (const button of buttons) {
      assert.ok(button.callback_data.length <= 64);
    }
    assert.ok(api.requests.some((request) => request.pathname.endsWith("/answerCallbackQuery")));
    assert.ok(api.requests.some((request) => request.pathname.endsWith("/editMessageText")));
  } finally {
    process.env.CODEXCLAW_TELEGRAM_API_BASE_URL = previousBaseUrl;
    await api.close();
  }
});

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  return await new Promise<Buffer>((resolve, reject) => {
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function respondJson(response: http.ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}
