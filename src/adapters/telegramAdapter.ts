import http from "http";
import https from "https";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import type { TelegramTransportConfig } from "../config/schema";
import type { Logger } from "../logger";
import type { Attachment, ChannelAdapter, InboundMessage, MessageHandler, OutboundMessage } from "./base";

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramSenderChat {
  id: number;
  title?: string;
  username?: string;
  type: string;
}

interface TelegramFileDescriptor {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
}

interface TelegramPhotoSize extends TelegramFileDescriptor {
  width: number;
  height: number;
}

interface TelegramAudio extends TelegramFileDescriptor {
  file_name?: string;
  mime_type?: string;
}

interface TelegramVoice extends TelegramFileDescriptor {
  mime_type?: string;
}

interface TelegramDocument extends TelegramFileDescriptor {
  file_name?: string;
  mime_type?: string;
}

interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramSenderChat;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  document?: TelegramDocument;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramFile {
  file_id: string;
  file_path?: string;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channel = "telegram" as const;

  private handler?: MessageHandler;
  private stopped = false;
  private pollingPromise?: Promise<void>;
  private currentPollingRequest?: http.ClientRequest;
  private nextUpdateOffset?: number;
  private botUserId?: number;
  private botUsername?: string;

  constructor(
    private readonly config: TelegramTransportConfig,
    private readonly botAliases: string[],
    private readonly logger: Logger,
  ) {}

  get id(): string {
    return this.config.id;
  }

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler;
    this.stopped = false;

    const me = await this.requestJson<TelegramUser>("getMe", {});
    this.botUserId = me.id;
    this.botUsername = me.username?.toLowerCase();

    this.logger.info("Started Telegram adapter", {
      adapterId: this.id,
      botUserId: this.botUserId,
      botUsername: this.botUsername,
      mode: this.config.config.mode,
      allowedUpdates: this.config.config.allowedUpdates,
    });

    if (!this.pollingPromise) {
      this.pollingPromise = this.runPollingLoop().finally(() => {
        this.pollingPromise = undefined;
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.handler = undefined;
    this.currentPollingRequest?.destroy();
    await this.pollingPromise;
    this.pollingPromise = undefined;
    this.logger.info("Stopped Telegram adapter", { adapterId: this.id });
  }

  async sendMessage(message: OutboundMessage): Promise<void> {
    if (message.text.trim().length > 0) {
      await this.requestJson("sendMessage", {
        chat_id: normalizeChatId(message.conversationId),
        text: message.text,
      });

      this.logger.info("Sent Telegram message", {
        adapterId: this.id,
        conversationId: message.conversationId,
        textPreview: previewText(message.text),
      });
    }

    for (const attachment of message.attachments ?? []) {
      if (!attachment.localPath) {
        throw new Error(`Attachment is missing localPath: ${attachment.name ?? attachment.id ?? "unknown"}`);
      }

      if (attachment.type === "image") {
        await this.requestMultipart(
          "sendPhoto",
          {
            chat_id: normalizeChatId(message.conversationId),
          },
          "photo",
          attachment.localPath,
          attachment.name ?? path.basename(attachment.localPath),
          attachment.mimeType,
        );

        this.logger.info("Sent Telegram photo", {
          adapterId: this.id,
          conversationId: message.conversationId,
          localPath: attachment.localPath,
        });
        continue;
      }

      await this.requestMultipart(
        "sendDocument",
        {
          chat_id: normalizeChatId(message.conversationId),
        },
        "document",
        attachment.localPath,
        attachment.name ?? path.basename(attachment.localPath),
        attachment.mimeType,
      );

      this.logger.info("Sent Telegram document", {
        adapterId: this.id,
        conversationId: message.conversationId,
        localPath: attachment.localPath,
      });
    }
  }

  async materializeAttachment(attachment: Attachment): Promise<Attachment> {
    if (attachment.localPath) {
      return attachment;
    }

    if (!attachment.id) {
      throw new Error("Telegram attachment is missing file id");
    }

    const descriptor = await this.requestJson<TelegramFile>("getFile", {
      file_id: attachment.id,
    });

    if (!descriptor.file_path) {
      throw new Error(`Telegram file is missing file_path for ${attachment.id}`);
    }

    const fileContents = await this.requestFile(descriptor.file_path);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codexclaw-telegram-"));
    const fileName = attachment.name ?? path.basename(descriptor.file_path);
    const localPath = path.join(tempDir, sanitizeFileName(fileName));
    await fs.writeFile(localPath, fileContents.body);

    return {
      ...attachment,
      name: attachment.name ?? path.basename(localPath),
      mimeType: attachment.mimeType ?? fileContents.contentType,
      localPath,
    };
  }

  private async runPollingLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.requestJson<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: this.nextUpdateOffset,
            timeout: this.config.config.pollTimeoutSeconds,
            allowed_updates: this.config.config.allowedUpdates,
          },
          true,
        );

        for (const update of updates) {
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (this.stopped) {
          return;
        }

        this.logger.warn("Telegram polling iteration failed", {
          adapterId: this.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(1000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!update.message) {
      this.logger.debug("Ignoring unsupported Telegram update", {
        adapterId: this.id,
        updateId: update.update_id,
      });
      this.nextUpdateOffset = update.update_id + 1;
      return;
    }

    if (!this.handler) {
      this.logger.warn("Received Telegram update before adapter handler was ready", {
        adapterId: this.id,
        updateId: update.update_id,
      });
      return;
    }

    const message = this.normalizeInboundMessage(update.message);
    if (!message) {
      this.nextUpdateOffset = update.update_id + 1;
      return;
    }

    this.logger.info("Telegram inbound event received", {
      adapterId: this.id,
      updateId: update.update_id,
      messageId: message.messageId,
      conversationId: message.conversationId,
      conversationName: message.conversationName,
      conversationType: message.conversationType,
      senderId: message.senderId,
      senderName: message.senderName,
      receivedAt: message.receivedAt,
      eventAgeMs: diffMs(message.receivedAt),
      attachmentCount: message.attachments.length,
      textPreview: previewText(message.text),
    });

    await this.handler(message);
    this.nextUpdateOffset = update.update_id + 1;
  }

  private normalizeInboundMessage(message: TelegramMessage): InboundMessage | null {
    if (message.chat.type === "channel") {
      this.logger.debug("Ignoring Telegram channel post", {
        adapterId: this.id,
        chatId: message.chat.id,
        messageId: message.message_id,
      });
      return null;
    }

    const conversationType = message.chat.type === "private" ? "direct" : "group";
    const senderId = String(message.from?.id ?? message.sender_chat?.id ?? "unknown");
    const senderName = formatSenderName(message);
    const trigger = normalizeTelegramTriggerText(
      message.text ?? message.caption ?? "",
      this.botAliases,
      this.botUsername,
    );
    const attachments = normalizeTelegramAttachments(message);

    return {
      adapterId: this.id,
      channel: this.channel,
      messageId: `${message.chat.id}:${message.message_id}`,
      conversationId: String(message.chat.id),
      conversationName: formatConversationName(message.chat),
      conversationType,
      senderId,
      senderName,
      isKnownContact: undefined,
      text: trigger.text,
      attachments,
      addressedToBot: trigger.addressedToBot,
      isFromSelf: message.from?.id === this.botUserId,
      isBotEcho: message.from?.id === this.botUserId,
      receivedAt: new Date(message.date * 1000).toISOString(),
      raw: message,
    };
  }

  private async requestJson<T>(
    method: string,
    body: Record<string, unknown>,
    isPollingRequest = false,
  ): Promise<T> {
    const url = this.methodUrl(method);
    const transport = url.protocol === "http:" ? http : https;
    const payload = JSON.stringify(body);

    return await new Promise<T>((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(payload)),
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
              ? JSON.parse(rawText) as TelegramApiResponse<T>
              : { ok: false, result: undefined as T, description: "Empty response" };

            if ((response.statusCode ?? 500) >= 400 || !parsed.ok) {
              reject(new Error(parsed.description ?? `Telegram API request failed (${response.statusCode ?? "unknown"})`));
              return;
            }

            resolve(parsed.result);
          });

          response.on("error", reject);
        },
      );

      if (isPollingRequest) {
        this.currentPollingRequest = request;
      }

      request.on("error", reject);
      request.write(payload);
      request.end();
    }).finally(() => {
      if (isPollingRequest) {
        this.currentPollingRequest = undefined;
      }
    });
  }

  private async requestMultipart(
    method: string,
    fields: Record<string, string | number>,
    fileFieldName: string,
    filePath: string,
    fileName: string,
    mimeType?: string,
  ): Promise<void> {
    const url = this.methodUrl(method);
    const transport = url.protocol === "http:" ? http : https;
    const boundary = `----codexclaw-telegram-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const fileContents = await fs.readFile(filePath);
    const parts: Buffer[] = [];

    for (const [key, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${String(value)}\r\n`,
        "utf8",
      ));
    }

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${escapeHeaderValue(fileName)}"\r\nContent-Type: ${mimeType ?? "application/octet-stream"}\r\n\r\n`,
      "utf8",
    ));
    parts.push(fileContents);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));

    const body = Buffer.concat(parts);

    await new Promise<void>((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(body.byteLength),
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
              ? JSON.parse(rawText) as TelegramApiResponse<unknown>
              : { ok: false, result: undefined, description: "Empty response" };

            if ((response.statusCode ?? 500) >= 400 || !parsed.ok) {
              reject(new Error(parsed.description ?? `Telegram API request failed (${response.statusCode ?? "unknown"})`));
              return;
            }

            resolve();
          });

          response.on("error", reject);
        },
      );

      request.on("error", reject);
      request.write(body);
      request.end();
    });
  }

  private async requestFile(filePath: string): Promise<{ body: Buffer; contentType?: string }> {
    const url = this.fileUrl(filePath);
    const transport = url.protocol === "http:" ? http : https;

    return await new Promise<{ body: Buffer; contentType?: string }>((resolve, reject) => {
      const request = transport.request(
        url,
        { method: "GET" },
        (response) => {
          const chunks: Buffer[] = [];

          response.on("data", (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });

          response.on("end", () => {
            const body = Buffer.concat(chunks);

            if ((response.statusCode ?? 500) >= 400) {
              reject(new Error(`Telegram file download failed (${response.statusCode ?? "unknown"})`));
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

  private methodUrl(method: string): URL {
    return new URL(`/bot${this.config.config.botToken}/${method}`, telegramApiBaseUrl());
  }

  private fileUrl(filePath: string): URL {
    return new URL(`/file/bot${this.config.config.botToken}/${filePath}`, telegramApiBaseUrl());
  }
}

function telegramApiBaseUrl(): string {
  const override = process.env.CODEXCLAW_TELEGRAM_API_BASE_URL;
  const baseUrl = override && override.trim().length > 0 ? override : "https://api.telegram.org";
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function normalizeChatId(value: string): number | string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function formatConversationName(chat: TelegramChat): string | undefined {
  if (chat.title?.trim()) {
    return chat.title.trim();
  }

  const fullName = [chat.first_name, chat.last_name]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .trim();

  return fullName || chat.username || undefined;
}

function formatSenderName(message: TelegramMessage): string {
  if (message.from) {
    const fullName = [message.from.first_name, message.from.last_name]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .trim();

    return fullName || message.from.username || String(message.from.id);
  }

  if (message.sender_chat?.title?.trim()) {
    return message.sender_chat.title.trim();
  }

  return "unknown";
}

function normalizeTelegramAttachments(message: TelegramMessage): Attachment[] {
  const attachments: Attachment[] = [];

  const photo = selectLargestPhoto(message.photo ?? []);
  if (photo) {
    attachments.push({
      id: photo.file_id,
      type: "image",
      name: `photo-${photo.file_unique_id ?? photo.file_id}.jpg`,
      mimeType: "image/jpeg",
    });
  }

  if (message.audio) {
    attachments.push({
      id: message.audio.file_id,
      type: "audio",
      name: message.audio.file_name ?? `audio-${message.audio.file_unique_id ?? message.audio.file_id}${extensionForMimeType(message.audio.mime_type, ".m4a")}`,
      mimeType: message.audio.mime_type,
    });
  }

  if (message.voice) {
    attachments.push({
      id: message.voice.file_id,
      type: "audio",
      name: `voice-${message.voice.file_unique_id ?? message.voice.file_id}${extensionForMimeType(message.voice.mime_type, ".ogg")}`,
      mimeType: message.voice.mime_type,
    });
  }

  if (message.document) {
    attachments.push({
      id: message.document.file_id,
      type: classifyDocumentType(message.document),
      name: message.document.file_name ?? `document-${message.document.file_unique_id ?? message.document.file_id}`,
      mimeType: message.document.mime_type,
    });
  }

  return attachments;
}

function selectLargestPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  return photos
    .slice()
    .sort((left, right) => (right.file_size ?? right.width * right.height) - (left.file_size ?? left.width * left.height))[0];
}

function classifyDocumentType(document: TelegramDocument): Attachment["type"] {
  if (document.mime_type?.startsWith("image/")) {
    return "image";
  }

  if (document.mime_type?.startsWith("audio/")) {
    return "audio";
  }

  const lowerName = document.file_name?.toLowerCase() ?? "";
  if (/\.(m4a|mp3|wav|caf|aac|flac|ogg)$/i.test(lowerName)) {
    return "audio";
  }

  return "file";
}

function extensionForMimeType(mimeType: string | undefined, fallback: string): string {
  if (!mimeType) {
    return fallback;
  }

  switch (mimeType.toLowerCase()) {
    case "audio/ogg":
      return ".ogg";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    default:
      return fallback;
  }
}

function normalizeTelegramTriggerText(
  text: string,
  aliases: string[],
  botUsername?: string,
): { text: string; addressedToBot: boolean } {
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?([\s\S]*)$/);
  if (match) {
    const [, command, username, suffix] = match;
    const normalizedCommand = command.toLowerCase();
    const configuredAlias = aliases.find((alias) => normalizeAlias(alias) === normalizedCommand);
    if (!configuredAlias) {
      return { text, addressedToBot: false };
    }

    if (username && botUsername && username.toLowerCase() !== botUsername) {
      return { text, addressedToBot: false };
    }

    return {
      text: stripAddressingPrefix(suffix),
      addressedToBot: true,
    };
  }

  if (botUsername) {
    const mentionMatch = text.match(/^@([A-Za-z0-9_]+)([\s\S]*)$/);
    if (mentionMatch && mentionMatch[1].toLowerCase() === botUsername) {
      return {
        text: stripAddressingPrefix(mentionMatch[2]),
        addressedToBot: true,
      };
    }
  }

  return { text, addressedToBot: false };
}

function normalizeAlias(value: string): string {
  return value.replace(/^@+/, "").toLowerCase();
}

function stripAddressingPrefix(value: string): string {
  return value.replace(/^[\s:,.!?-]+/, "").trimStart();
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:\0]/g, "_");
}

function escapeHeaderValue(value: string): string {
  return value.replace(/"/g, "_");
}

function previewText(value: string, maxLength = 80): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function diffMs(start: string | undefined, end: number = Date.now()): number | undefined {
  if (!start) {
    return undefined;
  }

  const startTime = Date.parse(start);
  if (Number.isNaN(startTime)) {
    return undefined;
  }

  return Math.max(0, end - startTime);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
