import type { AdapterConfig } from "../config/schema";
import type { Logger } from "../logger";
import type { ChannelAdapter } from "./base";
import { IMessageAdapter } from "./imessageAdapter";
import { WhatsAppAdapter } from "./whatsappAdapter";

export function createAdapters(configs: AdapterConfig[], logger: Logger): ChannelAdapter[] {
  return configs
    .filter((config) => config.enabled)
    .map((config) => {
      const adapterLogger = logger.child(`adapter:${config.id}`);

      switch (config.type) {
        case "imessage":
          return new IMessageAdapter(config, adapterLogger);
        case "whatsapp":
          return new WhatsAppAdapter(config.id, adapterLogger, config.provider);
      }
    });
}
