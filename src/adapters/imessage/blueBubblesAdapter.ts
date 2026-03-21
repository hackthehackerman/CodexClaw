import http from "http";
import https from "https";
import os from "os";
import path from "path";
import { URL } from "url";
import { promises as fs } from "fs";
import { z } from "zod";
import type { BlueBubblesIMessageAdapterConfig } from "../../config/schema";
import type { Logger } from "../../logger";
import type { Attachment, ChannelAdapter, InboundMessage, MessageHandler, OutboundMessage } from "../base";

const blueBubblesWebhookEnvelopeSchema = z.object({
  type: z.string().min(1),
  data: z.object({
    guid: z.string().optional(),
    text: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    dateCreated: z.number().nullable().optional(),
    isFromMe: z.boolean().optional(),
    handle: z.object({
      address: z.string().nullable().optional(),
    }).nullable().optional(),
    chats: z.array(z.object({
      guid: z.string().min(1),
      displayName: z.string().nullable().optional(),
    })).optional(),
    attachments: z.array(z.object({
      guid: z.string().nullable().optional(),
      uti: z.string().nullable().optional(),
      mimeType: z.string().nullable().optional(),
      transferName: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
    })).optional(),
  }),
});

type BlueBubblesWebhookEnvelope = z.infer<typeof blueBubblesWebhookEnvelopeSchema>;

interface BlueBubblesSuccessResponse<T> {
  status: number;
  message: string;
  data?: T;
  metadata?: unknown;
}

interface BlueBubblesWebhookRegistration {
  id?: number;
  url?: string;
  events?: string[];
}

interface RecentOutgoingMessage {
  conversationId: string;
  text: string;
  attachmentNames: string[];
  sentAt: number;
}

export class BlueBubblesIMessageAdapter implements ChannelAdapter {
  readonly channel = "imessage" as const;
  readonly id: string;

  private handler?: MessageHandler;
  private server?: http.Server;
  private nextTempGuid = 1;
  private readonly recentOutgoingMessages: RecentOutgoingMessage[] = [];

  constructor(
    private readonly config: BlueBubblesIMessageAdapterConfig,
    private readonly logger: Logger,
  ) {
    this.id = config.id;
  }

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler;
    await this.startWebhookServer();

    if (this.config.config.autoRegisterWebhook) {
      await this.registerWebhook();
    } else {
      this.logger.info("BlueBubbles webhook auto-registration disabled", {
        adapterId: this.id,
        webhookUrl: this.registrationUrl(),
      });
    }

    this.logger.info("Started BlueBubbles iMessage adapter", {
      adapterId: this.id,
      serverUrl: this.config.config.serverUrl,
      webhookUrl: this.registrationUrl(),
    });
  }

  async stop(): Promise<void> {
    this.handler = undefined;

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      this.server = undefined;
    }

    this.logger.info("Stopped BlueBubbles iMessage adapter", { adapterId: this.id });
  }

  async sendMessage(message: OutboundMessage): Promise<void> {
    const attachments = message.attachments ?? [];

    if (message.text.trim().length > 0) {
      this.rememberOutgoingMessage({
        conversationId: message.conversationId,
        text: message.text,
        attachmentNames: [],
      });

      const response = await this.requestJson<BlueBubblesWebhookRegistration>(
        "POST",
        "/api/v1/message/text",
        {
          chatGuid: message.conversationId,
          message: message.text,
          method: "apple-script",
          tempGuid: this.generateTempGuid(),
        },
      );

      this.logger.info("Sent BlueBubbles iMessage", {
        adapterId: this.id,
        conversationId: message.conversationId,
        responseMessage: response.message,
      });
    }

    for (const attachment of attachments) {
      if (!attachment.localPath) {
        throw new Error(`Attachment is missing localPath: ${attachment.name ?? attachment.id ?? "unknown"}`);
      }

      this.rememberOutgoingMessage({
        conversationId: message.conversationId,
        text: "",
        attachmentNames: [attachment.name ?? path.basename(attachment.localPath)],
      });

      const response = await this.requestMultipartJson<BlueBubblesWebhookRegistration>(
        "/api/v1/message/attachment",
        {
          chatGuid: message.conversationId,
          tempGuid: this.generateTempGuid(),
          method: "apple-script",
          name: attachment.name ?? path.basename(attachment.localPath),
          isAudioMessage: isAudioAttachment(attachment) ? "true" : "false",
        },
        attachment.localPath,
        attachment.name ?? path.basename(attachment.localPath),
        attachment.mimeType,
      );

      this.logger.info("Sent BlueBubbles attachment", {
        adapterId: this.id,
        conversationId: message.conversationId,
        localPath: attachment.localPath,
        responseMessage: response.message,
      });
    }
  }

  async materializeAttachment(attachment: Attachment): Promise<Attachment> {
    if (attachment.localPath) {
      return attachment;
    }

    if (!attachment.id) {
      throw new Error("BlueBubbles attachment is missing guid");
    }

    const download = await this.requestBinary("GET", `/api/v1/attachment/${encodeURIComponent(attachment.id)}/download`);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codexclaw-bluebubbles-"));
    const contentType = download.contentType ?? attachment.mimeType;
    const fileName = attachment.name ?? `${attachment.id}${extensionForAttachment(contentType, attachment.type)}`;
    const localPath = path.join(tempDir, sanitizeFileName(fileName));

    await fs.writeFile(localPath, download.body);

    return {
      ...attachment,
      name: attachment.name ?? path.basename(localPath),
      mimeType: contentType,
      localPath,
    };
  }

  private async startWebhookServer(): Promise<void> {
    const { webhookListenHost, webhookListenPort } = this.config.config;

    this.server = http.createServer((request, response) => {
      void this.handleWebhookRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(webhookListenPort, webhookListenHost, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });

    this.logger.info("Listening for BlueBubbles webhooks", {
      adapterId: this.id,
      host: webhookListenHost,
      port: webhookListenPort,
      path: this.normalizedWebhookPath(),
    });
  }

  private async handleWebhookRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

      if (request.method !== "POST" || requestUrl.pathname !== this.normalizedWebhookPath()) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      if (!this.isWebhookTokenValid(requestUrl)) {
        response.statusCode = 401;
        response.end("Unauthorized");
        return;
      }

      const body = await this.readRequestBody(request);
      const envelope = blueBubblesWebhookEnvelopeSchema.parse(JSON.parse(body || "{}"));

      await this.handleWebhookEnvelope(envelope);

      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    } catch (error) {
      this.logger.error("Failed to process BlueBubbles webhook", { error });
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: false }));
    }
  }

  private async handleWebhookEnvelope(envelope: BlueBubblesWebhookEnvelope): Promise<void> {
    if (envelope.type !== "new-message" && envelope.type !== "updated-message") {
      this.logger.debug("Ignoring BlueBubbles webhook event", {
        adapterId: this.id,
        eventType: envelope.type,
      });
      return;
    }

    if (!this.handler) {
      this.logger.warn("Received BlueBubbles webhook before adapter handler was ready", {
        adapterId: this.id,
        eventType: envelope.type,
      });
      return;
    }

    const message = this.normalizeInboundMessage(envelope);
    if (!message) {
      return;
    }

    await this.handler(message);
  }

  private normalizeInboundMessage(envelope: BlueBubblesWebhookEnvelope): InboundMessage | null {
    const chat = envelope.data.chats?.[0];
    if (!chat?.guid) {
      this.logger.warn("Dropping BlueBubbles message without chat guid", {
        adapterId: this.id,
        eventType: envelope.type,
        messageGuid: envelope.data.guid,
      });
      return null;
    }

    const senderId = envelope.data.handle?.address ?? (envelope.data.isFromMe ? "self" : "unknown");
    const senderName = envelope.data.handle?.address ?? chat.displayName ?? senderId;
    const attachments = this.normalizeAttachments(envelope.data.attachments ?? []);
    const isBotEcho = Boolean(envelope.data.isFromMe) && this.matchesRecentOutgoingMessage({
      conversationId: chat.guid,
      text: envelope.data.text ?? envelope.data.subject ?? "",
      attachmentNames: attachments.map((attachment) => attachment.name ?? ""),
    });

    return {
      adapterId: this.id,
      channel: this.channel,
      conversationId: chat.guid,
      senderId,
      senderName,
      text: envelope.data.text ?? envelope.data.subject ?? "",
      attachments,
      isFromSelf: envelope.data.isFromMe ?? false,
      isBotEcho,
      receivedAt: toIsoTimestamp(envelope.data.dateCreated),
      raw: envelope,
    };
  }

  private normalizeAttachments(
    attachments: Array<{
      guid?: string | null;
      uti?: string | null;
      mimeType?: string | null;
      transferName?: string | null;
      name?: string | null;
    }>,
  ): Attachment[] {
    return attachments.map((attachment) => ({
      id: attachment.guid ?? undefined,
      type: classifyAttachmentType(attachment.mimeType, attachment.uti, attachment.transferName, attachment.name),
      name: attachment.transferName ?? attachment.name ?? undefined,
      mimeType: attachment.mimeType ?? undefined,
    }));
  }

  private async registerWebhook(): Promise<void> {
    const response = await this.requestJson<BlueBubblesWebhookRegistration>(
      "POST",
      "/api/v1/webhook",
      {
        url: this.registrationUrl(),
        events: this.config.config.webhookEvents,
      },
    );

    this.logger.info("Registered BlueBubbles webhook", {
      adapterId: this.id,
      webhookId: response.data?.id,
      events: response.data?.events ?? this.config.config.webhookEvents,
    });
  }

  private registrationUrl(): string {
    const configured = this.config.config.webhookPublicUrl;
    const baseUrl = configured
      ? new URL(configured)
      : new URL(
          `http://127.0.0.1:${this.config.config.webhookListenPort}${this.normalizedWebhookPath()}`,
        );

    if (!configured) {
      baseUrl.pathname = this.normalizedWebhookPath();
    }

    if (this.config.config.webhookToken) {
      baseUrl.searchParams.set("token", this.config.config.webhookToken);
    }

    return baseUrl.toString();
  }

  private normalizedWebhookPath(): string {
    return this.config.config.webhookPath.startsWith("/")
      ? this.config.config.webhookPath
      : `/${this.config.config.webhookPath}`;
  }

  private isWebhookTokenValid(requestUrl: URL): boolean {
    const expectedToken = this.config.config.webhookToken;
    if (!expectedToken) {
      return true;
    }

    return requestUrl.searchParams.get("token") === expectedToken;
  }

  private async readRequestBody(request: http.IncomingMessage): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];

      request.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      request.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });

      request.on("error", reject);
    });
  }

  private async requestJson<T>(
    method: "POST" | "GET",
    endpointPath: string,
    body?: Record<string, unknown>,
  ): Promise<BlueBubblesSuccessResponse<T>> {
    const url = new URL(endpointPath, normalizeBaseUrl(this.config.config.serverUrl));
    url.searchParams.set("password", this.config.config.password);

    const requestBody = body ? JSON.stringify(body) : undefined;
    const transport = url.protocol === "https:" ? https : http;

    return await new Promise<BlueBubblesSuccessResponse<T>>((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(requestBody ? { "Content-Length": String(Buffer.byteLength(requestBody)) } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on("end", () => {
            const rawText = Buffer.concat(chunks).toString("utf8");
            const parsed = rawText.length > 0
              ? (JSON.parse(rawText) as BlueBubblesSuccessResponse<T>)
              : { status: response.statusCode ?? 0, message: "" };

            if ((response.statusCode ?? 500) >= 400) {
              reject(
                new Error(
                  `BlueBubbles request failed (${response.statusCode ?? "unknown"}): ${
                    parsed.message || rawText || "Unknown error"
                  }`,
                ),
              );
              return;
            }

            resolve(parsed);
          });

          response.on("error", reject);
        },
      );

      request.on("error", reject);

      if (requestBody) {
        request.write(requestBody);
      }

      request.end();
    });
  }

  private async requestBinary(
    method: "GET",
    endpointPath: string,
  ): Promise<{ body: Buffer; contentType?: string }> {
    const url = new URL(endpointPath, normalizeBaseUrl(this.config.config.serverUrl));
    url.searchParams.set("password", this.config.config.password);
    const transport = url.protocol === "https:" ? https : http;

    return await new Promise<{ body: Buffer; contentType?: string }>((resolve, reject) => {
      const request = transport.request(
        url,
        { method },
        (response) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on("end", () => {
            const body = Buffer.concat(chunks);

            if ((response.statusCode ?? 500) >= 400) {
              reject(new Error(`BlueBubbles request failed (${response.statusCode ?? "unknown"})`));
              return;
            }

            resolve({
              body,
              contentType: response.headers["content-type"],
            });
          });

          response.on("error", reject);
        },
      );

      request.on("error", reject);
      request.end();
    });
  }

  private async requestMultipartJson<T>(
    endpointPath: string,
    fields: Record<string, string>,
    filePath: string,
    fileName: string,
    mimeType?: string,
  ): Promise<BlueBubblesSuccessResponse<T>> {
    const url = new URL(endpointPath, normalizeBaseUrl(this.config.config.serverUrl));
    url.searchParams.set("password", this.config.config.password);
    const boundary = `----codexclaw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileContents = await fs.readFile(filePath);
    const parts: Buffer[] = [];

    for (const [key, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
        "utf8",
      ));
    }

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="${escapeHeaderValue(fileName)}"\r\nContent-Type: ${mimeType ?? "application/octet-stream"}\r\n\r\n`,
      "utf8",
    ));
    parts.push(fileContents);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));

    const requestBody = Buffer.concat(parts);
    const transport = url.protocol === "https:" ? https : http;

    return await new Promise<BlueBubblesSuccessResponse<T>>((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(requestBody.byteLength),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on("end", () => {
            const rawText = Buffer.concat(chunks).toString("utf8");
            const parsed = rawText.length > 0
              ? (JSON.parse(rawText) as BlueBubblesSuccessResponse<T>)
              : { status: response.statusCode ?? 0, message: "" };

            if ((response.statusCode ?? 500) >= 400) {
              reject(
                new Error(
                  `BlueBubbles multipart request failed (${response.statusCode ?? "unknown"}): ${
                    parsed.message || rawText || "Unknown error"
                  }`,
                ),
              );
              return;
            }

            resolve(parsed);
          });

          response.on("error", reject);
        },
      );

      request.on("error", reject);
      request.write(requestBody);
      request.end();
    });
  }

  private generateTempGuid(): string {
    return `codexclaw-${Date.now()}-${this.nextTempGuid++}`;
  }

  private rememberOutgoingMessage(message: Omit<RecentOutgoingMessage, "sentAt">): void {
    this.recentOutgoingMessages.push({
      ...message,
      sentAt: Date.now(),
    });
    this.pruneRecentOutgoingMessages();
  }

  private matchesRecentOutgoingMessage(candidate: Pick<RecentOutgoingMessage, "conversationId" | "text" | "attachmentNames">): boolean {
    this.pruneRecentOutgoingMessages();

    const normalizedText = normalizeMessageText(candidate.text);
    const normalizedAttachmentNames = normalizeAttachmentNames(candidate.attachmentNames);

    const index = this.recentOutgoingMessages.findIndex((message) =>
      message.conversationId === candidate.conversationId
      && normalizeMessageText(message.text) === normalizedText
      && arraysEqual(normalizeAttachmentNames(message.attachmentNames), normalizedAttachmentNames),
    );

    if (index === -1) {
      return false;
    }

    this.recentOutgoingMessages.splice(index, 1);
    return true;
  }

  private pruneRecentOutgoingMessages(): void {
    const cutoff = Date.now() - 2 * 60 * 1000;
    while (this.recentOutgoingMessages.length > 0 && this.recentOutgoingMessages[0].sentAt < cutoff) {
      this.recentOutgoingMessages.shift();
    }
  }
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function toIsoTimestamp(dateCreated?: number | null): string {
  return dateCreated ? new Date(dateCreated).toISOString() : new Date().toISOString();
}

function classifyAttachmentType(
  mimeType?: string | null,
  uti?: string | null,
  transferName?: string | null,
  name?: string | null,
): Attachment["type"] {
  const fileName = (transferName ?? name ?? "").toLowerCase();
  const lowerMime = mimeType?.toLowerCase();
  const lowerUti = uti?.toLowerCase();

  if (lowerMime?.startsWith("image/")) {
    return "image";
  }

  if (
    lowerMime?.startsWith("audio/")
    || lowerUti === "com.apple.coreaudio-format"
    || /\.(m4a|mp3|wav|caf|aac|flac|ogg)$/i.test(fileName)
  ) {
    return "audio";
  }

  return "file";
}

function extensionForAttachment(mimeType: string | undefined, type: Attachment["type"]): string {
  if (mimeType) {
    const normalized = mimeType.split(";")[0].trim().toLowerCase();
    const known = mimeToExtension(normalized);
    if (known) {
      return known;
    }
  }

  switch (type) {
    case "image":
      return ".png";
    case "audio":
      return ".m4a";
    default:
      return ".bin";
  }
}

function mimeToExtension(mimeType: string): string | undefined {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/heic":
      return ".heic";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/x-caf":
      return ".caf";
    case "audio/aac":
      return ".aac";
    default:
      return undefined;
  }
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:\0]/g, "_");
}

function escapeHeaderValue(value: string): string {
  return value.replace(/"/g, "_");
}

function isAudioAttachment(attachment: Attachment): boolean {
  return attachment.type === "audio" || attachment.mimeType?.startsWith("audio/") === true;
}

function normalizeMessageText(value: string): string {
  return value.trim();
}

function normalizeAttachmentNames(values: string[]): string[] {
  return values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
    .sort();
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}
