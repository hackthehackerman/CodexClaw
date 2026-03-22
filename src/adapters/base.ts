export type ChannelName = "imessage" | "telegram" | "whatsapp";

export interface Attachment {
  id?: string;
  type: "image" | "audio" | "file";
  name?: string;
  localPath?: string;
  mimeType?: string;
}

export interface InboundMessage {
  adapterId: string;
  channel: ChannelName;
  messageId?: string;
  conversationId: string;
  conversationName?: string;
  conversationType: "direct" | "group";
  senderId: string;
  senderName: string;
  isKnownContact?: boolean;
  text: string;
  attachments: Attachment[];
  replyToId?: string;
  addressedToBot?: boolean;
  isFromSelf: boolean;
  isBotEcho?: boolean;
  receivedAt: string;
  raw: unknown;
}

export interface OutboundMessage {
  conversationId: string;
  text: string;
  replyToId?: string;
  attachments?: Attachment[];
}

export type MessageHandler = (message: InboundMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly id: string;
  readonly channel: ChannelName;
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
  sendMessage(message: OutboundMessage): Promise<void>;
  materializeAttachment(attachment: Attachment): Promise<Attachment>;
}
