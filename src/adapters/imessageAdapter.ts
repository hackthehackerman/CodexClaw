import type { IMessageAdapterConfig } from "../config/schema";
import type { Logger } from "../logger";
import type { ChannelAdapter, MessageHandler, OutboundMessage } from "./base";
import { BlueBubblesIMessageAdapter } from "./imessage/blueBubblesAdapter";

export class IMessageAdapter implements ChannelAdapter {
  private readonly delegate: ChannelAdapter;

  constructor(
    config: IMessageAdapterConfig,
    logger: Logger,
  ) {
    switch (config.provider) {
      case "bluebubbles":
        this.delegate = new BlueBubblesIMessageAdapter(config, logger);
        break;
      default:
        throw new Error(`Unsupported iMessage provider: ${config.provider}`);
    }
  }

  get id(): string {
    return this.delegate.id;
  }

  get channel(): "imessage" {
    return "imessage";
  }

  async start(handler: MessageHandler): Promise<void> {
    await this.delegate.start(handler);
  }

  async stop(): Promise<void> {
    await this.delegate.stop();
  }

  async sendMessage(message: OutboundMessage): Promise<void> {
    await this.delegate.sendMessage(message);
  }
}
