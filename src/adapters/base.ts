export type ChannelName = "imessage" | "telegram" | "whatsapp";
export type ApprovalKind = "command" | "fileChange" | "permissions";
export type ApprovalAction = "approve_once" | "approve_session" | "deny" | "cancel";

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

export interface ApprovalActionEvent {
  adapterId: string;
  channel: ChannelName;
  conversationId: string;
  senderId: string;
  senderName: string;
  approvalId: string;
  action: ApprovalAction;
  messageId?: string;
  raw: unknown;
}

export interface AdapterEventHandlers {
  onMessage: (message: InboundMessage) => Promise<void>;
  onApprovalAction?: (action: ApprovalActionEvent) => Promise<void>;
}

export interface ApprovalPrompt {
  conversationId: string;
  approvalId: string;
  kind: ApprovalKind;
  summary: string;
  actions: ApprovalAction[];
}

export interface ApprovalPromptUpdate {
  approvalId: string;
  status: "approved" | "denied" | "canceled";
  action?: ApprovalAction;
  actorId?: string;
  actorName?: string;
  conversationId?: string;
  messageId?: string;
}

export interface AdapterFeatures {
  approvalTextCommands: boolean;
  approvalInteractive: boolean;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly channel: ChannelName;
  start(handlers: AdapterEventHandlers): Promise<void>;
  stop(): Promise<void>;
  getFeatures(): AdapterFeatures;
  sendMessage(message: OutboundMessage): Promise<void>;
  materializeAttachment(attachment: Attachment): Promise<Attachment>;
  sendApprovalPrompt?(prompt: ApprovalPrompt): Promise<void>;
  finalizeApprovalPrompt?(update: ApprovalPromptUpdate): Promise<void>;
}
