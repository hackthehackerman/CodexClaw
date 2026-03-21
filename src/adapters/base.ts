export type ChannelName = "imessage" | "whatsapp";

export interface Attachment {
  type: "image" | "file";
  url?: string;
  localPath?: string;
  mimeType?: string;
}

export interface InboundMessage {
  adapterId: string;
  channel: ChannelName;
  conversationId: string;
  senderId: string;
  senderName: string;
  text: string;
  attachments: Attachment[];
  replyToId?: string;
  isFromSelf: boolean;
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
}

