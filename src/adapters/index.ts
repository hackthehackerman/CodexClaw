import type { TransportConfig } from "../config/schema";
import type { Logger } from "../logger";
import type { ChannelAdapter } from "./base";
import { IMessageAdapter } from "./imessageAdapter";
import { TelegramAdapter } from "./telegramAdapter";
import { WhatsAppAdapter } from "./whatsappAdapter";

export function createAdapters(configs: TransportConfig[], botAliases: string[], logger: Logger): ChannelAdapter[] {
  return configs
    .filter((config) => config.enabled)
    .map((config) => {
      const adapterLogger = logger.child(`adapter:${config.id}`);

      switch (config.channel) {
        case "imessage":
          return new IMessageAdapter(config, botAliases, adapterLogger);
        case "telegram":
          return new TelegramAdapter(config, botAliases, adapterLogger);
        case "whatsapp":
          return new WhatsAppAdapter(config.id, adapterLogger, config.provider);
      }
    });
}
