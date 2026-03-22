import type { Logger } from "../logger";
import type { AdapterEventHandlers, AdapterFeatures, Attachment, ChannelAdapter, OutboundMessage } from "./base";

export class WhatsAppAdapter implements ChannelAdapter {
  readonly channel = "whatsapp" as const;
  private handlers?: AdapterEventHandlers;

  constructor(
    readonly id: string,
    private readonly logger: Logger,
    private readonly provider: string,
  ) {}

  async start(handlers: AdapterEventHandlers): Promise<void> {
    this.handlers = handlers;
    this.logger.info("Started WhatsApp adapter", { adapterId: this.id, provider: this.provider });
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
    this.logger.info("Stopped WhatsApp adapter", { adapterId: this.id });
  }

  getFeatures(): AdapterFeatures {
    return {
      approvalTextCommands: false,
      approvalInteractive: false,
    };
  }

  async sendMessage(message: OutboundMessage): Promise<void> {
    this.logger.info("Sending WhatsApp message", {
      adapterId: this.id,
      conversationId: message.conversationId,
      text: message.text,
    });
  }

  async materializeAttachment(attachment: Attachment): Promise<Attachment> {
    return attachment;
  }
}
