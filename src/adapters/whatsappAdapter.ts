import type { Logger } from "../logger";
import type { ChannelAdapter, MessageHandler, OutboundMessage } from "./base";

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = "whatsapp" as const;
  private handler?: MessageHandler;

  constructor(
    readonly id: string,
    private readonly logger: Logger,
    private readonly provider: string,
  ) {}

  async start(handler: MessageHandler): Promise<void> {
    this.handler = handler;
    this.logger.info("Started WhatsApp adapter", { adapterId: this.id, provider: this.provider });
  }

  async stop(): Promise<void> {
    this.handler = undefined;
    this.logger.info("Stopped WhatsApp adapter", { adapterId: this.id });
  }

  async sendMessage(message: OutboundMessage): Promise<void> {
    this.logger.info("Sending WhatsApp message", {
      adapterId: this.id,
      conversationId: message.conversationId,
      text: message.text,
    });
  }
}

