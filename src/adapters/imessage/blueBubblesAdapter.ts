import http from "http";
import https from "https";
import { URL } from "url";
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

export class BlueBubblesIMessageAdapter implements ChannelAdapter {
  readonly channel = "imessage" as const;
  readonly id: string;

  private handler?: MessageHandler;
  private server?: http.Server;
  private nextTempGuid = 1;

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
    if (message.attachments && message.attachments.length > 0) {
      throw new Error("BlueBubbles text send is implemented first; attachments are not supported yet.");
    }

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

    return {
      adapterId: this.id,
      channel: this.channel,
      conversationId: chat.guid,
      senderId,
      senderName,
      text: envelope.data.text ?? envelope.data.subject ?? "",
      attachments: this.normalizeAttachments(envelope.data.attachments ?? []),
      isFromSelf: envelope.data.isFromMe ?? false,
      receivedAt: toIsoTimestamp(envelope.data.dateCreated),
      raw: envelope,
    };
  }

  private normalizeAttachments(
    attachments: Array<{ mimeType?: string | null; transferName?: string | null; name?: string | null }>,
  ): Attachment[] {
    return attachments.map((attachment) => ({
      type: attachment.mimeType?.startsWith("image/") ? "image" : "file",
      mimeType: attachment.mimeType ?? undefined,
      url: attachment.transferName ?? attachment.name ?? undefined,
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

  private generateTempGuid(): string {
    return `codexclaw-${Date.now()}-${this.nextTempGuid++}`;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function toIsoTimestamp(dateCreated?: number | null): string {
  return dateCreated ? new Date(dateCreated).toISOString() : new Date().toISOString();
}
