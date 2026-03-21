export interface ChatSession {
  id: string;
  adapterId: string;
  channel: string;
  externalChatId: string;
  displayName: string;
  codexThreadId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  chatSessionId: string;
  codexTurnId?: string;
  status: "queued" | "in_progress" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  errorText?: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  requestId: string;
  kind: "command" | "fileChange" | "permissions";
  threadId: string;
  turnId: string;
  itemId: string;
  payloadJson: string;
  status: "pending" | "approved" | "denied" | "canceled";
  decidedAt?: string;
}

export interface StateStore {
  getChatSession(adapterId: string, externalChatId: string): Promise<ChatSession | undefined>;
  saveChatSession(session: ChatSession): Promise<void>;
  createRun(input: Omit<RunRecord, "id">): Promise<RunRecord>;
  updateRun(runId: string, patch: Partial<RunRecord>): Promise<void>;
  createApproval(input: Omit<ApprovalRecord, "id">): Promise<ApprovalRecord>;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  updateApproval(approvalId: string, patch: Partial<ApprovalRecord>): Promise<void>;
}

export class InMemoryStateStore implements StateStore {
  private readonly chatSessions = new Map<string, ChatSession>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private nextRun = 1;
  private nextSession = 1;
  private nextApproval = 1;

  async getChatSession(adapterId: string, externalChatId: string): Promise<ChatSession | undefined> {
    return this.chatSessions.get(this.sessionKey(adapterId, externalChatId));
  }

  async saveChatSession(session: ChatSession): Promise<void> {
    const value = session.id
      ? session
      : {
          ...session,
          id: this.generateSessionId(),
        };

    this.chatSessions.set(this.sessionKey(session.adapterId, session.externalChatId), value);
  }

  async createRun(input: Omit<RunRecord, "id">): Promise<RunRecord> {
    const record: RunRecord = {
      ...input,
      id: this.generateRunId(),
    };
    this.runs.set(record.id, record);
    return record;
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const existing = this.runs.get(runId);

    if (!existing) {
      throw new Error(`Unknown run id: ${runId}`);
    }

    this.runs.set(runId, { ...existing, ...patch });
  }

  async createApproval(input: Omit<ApprovalRecord, "id">): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      ...input,
      id: this.generateApprovalId(),
    };
    this.approvals.set(record.id, record);
    return record;
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    return this.approvals.get(approvalId);
  }

  async updateApproval(approvalId: string, patch: Partial<ApprovalRecord>): Promise<void> {
    const existing = this.approvals.get(approvalId);

    if (!existing) {
      throw new Error(`Unknown approval id: ${approvalId}`);
    }

    this.approvals.set(approvalId, { ...existing, ...patch });
  }

  generateSessionId(): string {
    return `session_${this.nextSession++}`;
  }

  private sessionKey(adapterId: string, externalChatId: string): string {
    return `${adapterId}:${externalChatId}`;
  }

  private generateRunId(): string {
    return `run_${this.nextRun++}`;
  }

  private generateApprovalId(): string {
    return `APPR_${this.nextApproval++}`;
  }
}

