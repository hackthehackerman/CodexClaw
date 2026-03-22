import type { IMessageTransportConfig } from "../config/schema";
import type { Logger } from "../logger";
import type {
  AdapterEventHandlers,
  AdapterFeatures,
  ApprovalPrompt,
  ApprovalPromptUpdate,
  Attachment,
  ChannelAdapter,
  OutboundMessage,
} from "./base";
import { BlueBubblesIMessageAdapter } from "./imessage/blueBubblesAdapter";

export class IMessageAdapter implements ChannelAdapter {
  private readonly delegate: ChannelAdapter;

  constructor(
    config: IMessageTransportConfig,
    botAliases: string[],
    logger: Logger,
  ) {
    switch (config.provider) {
      case "bluebubbles":
        this.delegate = new BlueBubblesIMessageAdapter(config, botAliases, logger);
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

  async start(handlers: AdapterEventHandlers): Promise<void> {
    await this.delegate.start(handlers);
  }

  async stop(): Promise<void> {
    await this.delegate.stop();
  }

  async sendMessage(message: OutboundMessage): Promise<void> {
    await this.delegate.sendMessage(message);
  }

  async materializeAttachment(attachment: Attachment): Promise<Attachment> {
    return await this.delegate.materializeAttachment(attachment);
  }

  getFeatures(): AdapterFeatures {
    return this.delegate.getFeatures();
  }

  async sendApprovalPrompt(prompt: ApprovalPrompt): Promise<void> {
    if (!this.delegate.sendApprovalPrompt) {
      throw new Error("Delegate does not support approval prompts");
    }

    await this.delegate.sendApprovalPrompt(prompt);
  }

  async finalizeApprovalPrompt(update: ApprovalPromptUpdate): Promise<void> {
    if (!this.delegate.finalizeApprovalPrompt) {
      return;
    }

    await this.delegate.finalizeApprovalPrompt(update);
  }
}
