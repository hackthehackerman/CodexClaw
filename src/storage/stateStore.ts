import { mkdirSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import type { InboundMessage } from "../adapters/base";
import type { Logger } from "../logger";

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
  codexRequestJson?: string;
  codexResponseJson?: string;
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

export interface QueuedInboundMessage {
  id: string;
  adapterId: string;
  messageId?: string;
  conversationId: string;
  payloadJson: string;
  status: "queued" | "processing" | "completed" | "failed";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  errorText?: string;
}

export interface SessionActivitySummary {
  session: ChatSession;
  runCount: number;
  pendingApprovals: number;
  latestRun?: RunRecord;
}

export interface RunHistoryRecord {
  run: RunRecord;
  session: ChatSession;
}

export interface ApprovalHistoryRecord {
  approval: ApprovalRecord;
  session?: ChatSession;
  runStatus?: RunRecord["status"];
}

export interface EnqueueInboundMessageInput {
  message: InboundMessage;
  payloadJson: string;
}

export interface StateStore {
  getChatSession(adapterId: string, externalChatId: string): Promise<ChatSession | undefined>;
  saveChatSession(session: ChatSession): Promise<void>;
  createRun(input: Omit<RunRecord, "id">): Promise<RunRecord>;
  updateRun(runId: string, patch: Partial<RunRecord>): Promise<void>;
  createApproval(input: Omit<ApprovalRecord, "id">): Promise<ApprovalRecord>;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  updateApproval(approvalId: string, patch: Partial<ApprovalRecord>): Promise<void>;
  listSessionActivity(limit: number): Promise<SessionActivitySummary[]>;
  listRecentRuns(limit: number): Promise<RunHistoryRecord[]>;
  listRecentApprovals(limit: number): Promise<ApprovalHistoryRecord[]>;
  enqueueInboundMessage(input: EnqueueInboundMessageInput): Promise<boolean>;
  claimNextQueuedInboundMessage(): Promise<QueuedInboundMessage | undefined>;
  hasQueuedInboundMessages(): Promise<boolean>;
  completeInboundMessage(id: string): Promise<void>;
  failInboundMessage(id: string, errorText: string): Promise<void>;
  requeueProcessingInboundMessages(): Promise<number>;
}

interface ChatSessionRow {
  id: string;
  adapter_id: string;
  channel: string;
  external_chat_id: string;
  display_name: string;
  codex_thread_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRecordRow {
  id: string;
  chat_session_id: string;
  codex_turn_id: string | null;
  status: RunRecord["status"];
  started_at: string;
  completed_at: string | null;
  error_text: string | null;
  codex_request_json: string | null;
  codex_response_json: string | null;
}

interface ApprovalRecordRow {
  id: string;
  run_id: string;
  request_id: string;
  kind: ApprovalRecord["kind"];
  thread_id: string;
  turn_id: string;
  item_id: string;
  payload_json: string;
  status: ApprovalRecord["status"];
  decided_at: string | null;
}

interface QueuedInboundMessageRow {
  id: string;
  adapter_id: string;
  external_message_id: string | null;
  conversation_id: string;
  payload_json: string;
  status: QueuedInboundMessage["status"];
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_text: string | null;
}

interface SessionActivityRow extends ChatSessionRow {
  run_count: number;
  pending_approvals: number;
  latest_run_id: string | null;
  latest_run_chat_session_id: string | null;
  latest_run_codex_turn_id: string | null;
  latest_run_status: RunRecord["status"] | null;
  latest_run_started_at: string | null;
  latest_run_completed_at: string | null;
  latest_run_error_text: string | null;
}

interface RunHistoryRow extends RunRecordRow {
  session_id: string;
  session_adapter_id: string;
  session_channel: string;
  session_external_chat_id: string;
  session_display_name: string;
  session_codex_thread_id: string | null;
  session_created_at: string;
  session_updated_at: string;
}

interface ApprovalHistoryRow extends ApprovalRecordRow {
  run_status: RunRecord["status"] | null;
  session_id: string | null;
  session_adapter_id: string | null;
  session_channel: string | null;
  session_external_chat_id: string | null;
  session_display_name: string | null;
  session_codex_thread_id: string | null;
  session_created_at: string | null;
  session_updated_at: string | null;
}

export class SqliteStateStore implements StateStore {
  private readonly db: Database.Database;

  constructor(dbPath: string, private readonly logger: Logger) {
    const absolutePath = path.resolve(dbPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });

    this.db = new Database(absolutePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.initSchema();

    this.logger.info("Initialized SQLite state store", { dbPath: absolutePath });
  }

  async getChatSession(adapterId: string, externalChatId: string): Promise<ChatSession | undefined> {
    const row = this.db
      .prepare<[string, string], ChatSessionRow>(
        `SELECT id, adapter_id, channel, external_chat_id, display_name, codex_thread_id, created_at, updated_at
         FROM chat_sessions
         WHERE adapter_id = ? AND external_chat_id = ?`,
      )
      .get(adapterId, externalChatId);

    return row ? mapChatSessionRow(row) : undefined;
  }

  async saveChatSession(session: ChatSession): Promise<void> {
    const id = session.id || `session_${randomUUID()}`;
    const now = session.updatedAt || new Date().toISOString();
    const createdAt = session.createdAt || now;

    this.db
      .prepare(
        `INSERT INTO chat_sessions (
           id, adapter_id, channel, external_chat_id, display_name, codex_thread_id, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(adapter_id, external_chat_id) DO UPDATE SET
           channel = excluded.channel,
           display_name = excluded.display_name,
           codex_thread_id = excluded.codex_thread_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        session.adapterId,
        session.channel,
        session.externalChatId,
        session.displayName,
        session.codexThreadId ?? null,
        createdAt,
        now,
      );
  }

  async createRun(input: Omit<RunRecord, "id">): Promise<RunRecord> {
    const record: RunRecord = {
      ...input,
      id: `run_${randomUUID()}`,
    };

    this.db
      .prepare(
        `INSERT INTO runs (
           id, chat_session_id, codex_turn_id, status, started_at, completed_at, error_text, codex_request_json, codex_response_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.chatSessionId,
        record.codexTurnId ?? null,
        record.status,
        record.startedAt,
        record.completedAt ?? null,
        record.errorText ?? null,
        record.codexRequestJson ?? null,
        record.codexResponseJson ?? null,
      );

    return record;
  }

  async updateRun(runId: string, patch: Partial<RunRecord>): Promise<void> {
    if (Object.keys(patch).length === 0) {
      return;
    }

    const assignments: string[] = [];
    const values: Array<string | null> = [];

    if (patch.chatSessionId !== undefined) {
      assignments.push("chat_session_id = ?");
      values.push(patch.chatSessionId);
    }

    if (patch.codexTurnId !== undefined) {
      assignments.push("codex_turn_id = ?");
      values.push(patch.codexTurnId ?? null);
    }

    if (patch.status !== undefined) {
      assignments.push("status = ?");
      values.push(patch.status);
    }

    if (patch.startedAt !== undefined) {
      assignments.push("started_at = ?");
      values.push(patch.startedAt);
    }

    if (patch.completedAt !== undefined) {
      assignments.push("completed_at = ?");
      values.push(patch.completedAt ?? null);
    }

    if (patch.errorText !== undefined) {
      assignments.push("error_text = ?");
      values.push(patch.errorText ?? null);
    }

    if (patch.codexRequestJson !== undefined) {
      assignments.push("codex_request_json = ?");
      values.push(patch.codexRequestJson ?? null);
    }

    if (patch.codexResponseJson !== undefined) {
      assignments.push("codex_response_json = ?");
      values.push(patch.codexResponseJson ?? null);
    }

    values.push(runId);

    const result = this.db
      .prepare(`UPDATE runs SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...values);

    if (result.changes === 0) {
      throw new Error(`Unknown run id: ${runId}`);
    }
  }

  async createApproval(input: Omit<ApprovalRecord, "id">): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      ...input,
      id: `APPR_${randomUUID()}`,
    };

    this.db
      .prepare(
        `INSERT INTO approvals (
           id, run_id, request_id, kind, thread_id, turn_id, item_id, payload_json, status, decided_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.requestId,
        record.kind,
        record.threadId,
        record.turnId,
        record.itemId,
        record.payloadJson,
        record.status,
        record.decidedAt ?? null,
      );

    return record;
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const row = this.db
      .prepare<[string], ApprovalRecordRow>(
        `SELECT id, run_id, request_id, kind, thread_id, turn_id, item_id, payload_json, status, decided_at
         FROM approvals
         WHERE id = ?`,
      )
      .get(approvalId);

    return row ? mapApprovalRecordRow(row) : undefined;
  }

  async updateApproval(approvalId: string, patch: Partial<ApprovalRecord>): Promise<void> {
    if (Object.keys(patch).length === 0) {
      return;
    }

    const assignments: string[] = [];
    const values: Array<string | null> = [];

    if (patch.runId !== undefined) {
      assignments.push("run_id = ?");
      values.push(patch.runId);
    }

    if (patch.requestId !== undefined) {
      assignments.push("request_id = ?");
      values.push(patch.requestId);
    }

    if (patch.kind !== undefined) {
      assignments.push("kind = ?");
      values.push(patch.kind);
    }

    if (patch.threadId !== undefined) {
      assignments.push("thread_id = ?");
      values.push(patch.threadId);
    }

    if (patch.turnId !== undefined) {
      assignments.push("turn_id = ?");
      values.push(patch.turnId);
    }

    if (patch.itemId !== undefined) {
      assignments.push("item_id = ?");
      values.push(patch.itemId);
    }

    if (patch.payloadJson !== undefined) {
      assignments.push("payload_json = ?");
      values.push(patch.payloadJson);
    }

    if (patch.status !== undefined) {
      assignments.push("status = ?");
      values.push(patch.status);
    }

    if (patch.decidedAt !== undefined) {
      assignments.push("decided_at = ?");
      values.push(patch.decidedAt ?? null);
    }

    values.push(approvalId);

    const result = this.db
      .prepare(`UPDATE approvals SET ${assignments.join(", ")} WHERE id = ?`)
      .run(...values);

    if (result.changes === 0) {
      throw new Error(`Unknown approval id: ${approvalId}`);
    }
  }

  async listSessionActivity(limit: number): Promise<SessionActivitySummary[]> {
    const rows = this.db
      .prepare<[number], SessionActivityRow>(
        `SELECT
           cs.id,
           cs.adapter_id,
           cs.channel,
           cs.external_chat_id,
           cs.display_name,
           cs.codex_thread_id,
           cs.created_at,
           cs.updated_at,
           COALESCE(run_stats.run_count, 0) AS run_count,
           COALESCE(pending_stats.pending_approvals, 0) AS pending_approvals,
           lr.id AS latest_run_id,
           lr.chat_session_id AS latest_run_chat_session_id,
           lr.codex_turn_id AS latest_run_codex_turn_id,
           lr.status AS latest_run_status,
           lr.started_at AS latest_run_started_at,
           lr.completed_at AS latest_run_completed_at,
           lr.error_text AS latest_run_error_text
         FROM chat_sessions cs
         LEFT JOIN (
           SELECT chat_session_id, COUNT(*) AS run_count
           FROM runs
           GROUP BY chat_session_id
         ) run_stats
           ON run_stats.chat_session_id = cs.id
         LEFT JOIN runs lr
           ON lr.id = (
             SELECT r2.id
             FROM runs r2
             WHERE r2.chat_session_id = cs.id
             ORDER BY r2.started_at DESC, r2.id DESC
             LIMIT 1
           )
         LEFT JOIN (
           SELECT r.chat_session_id, COUNT(*) AS pending_approvals
           FROM approvals a
           JOIN runs r ON r.id = a.run_id
           WHERE a.status = 'pending'
           GROUP BY r.chat_session_id
         ) pending_stats
           ON pending_stats.chat_session_id = cs.id
         ORDER BY COALESCE(lr.started_at, cs.updated_at) DESC, cs.updated_at DESC
         LIMIT ?`,
      )
      .all(limit);

    return rows.map((row) => ({
      session: mapChatSessionRow(row),
      runCount: row.run_count,
      pendingApprovals: row.pending_approvals,
      latestRun: mapLatestRunFromSessionActivityRow(row),
    }));
  }

  async listRecentRuns(limit: number): Promise<RunHistoryRecord[]> {
    const rows = this.db
      .prepare<[number], RunHistoryRow>(
        `SELECT
           r.id,
           r.chat_session_id,
           r.codex_turn_id,
           r.status,
           r.started_at,
           r.completed_at,
           r.error_text,
           r.codex_request_json,
           r.codex_response_json,
           cs.id AS session_id,
           cs.adapter_id AS session_adapter_id,
           cs.channel AS session_channel,
           cs.external_chat_id AS session_external_chat_id,
           cs.display_name AS session_display_name,
           cs.codex_thread_id AS session_codex_thread_id,
           cs.created_at AS session_created_at,
           cs.updated_at AS session_updated_at
         FROM runs r
         JOIN chat_sessions cs ON cs.id = r.chat_session_id
         ORDER BY r.started_at DESC, r.id DESC
         LIMIT ?`,
      )
      .all(limit);

    return rows.map((row) => ({
      run: mapRunRecordRow(row),
      session: mapSessionFromJoinedRow(row),
    }));
  }

  async listRecentApprovals(limit: number): Promise<ApprovalHistoryRecord[]> {
    const rows = this.db
      .prepare<[number], ApprovalHistoryRow>(
        `SELECT
           a.id,
           a.run_id,
           a.request_id,
           a.kind,
           a.thread_id,
           a.turn_id,
           a.item_id,
           a.payload_json,
           a.status,
           a.decided_at,
           r.status AS run_status,
           cs.id AS session_id,
           cs.adapter_id AS session_adapter_id,
           cs.channel AS session_channel,
           cs.external_chat_id AS session_external_chat_id,
           cs.display_name AS session_display_name,
           cs.codex_thread_id AS session_codex_thread_id,
           cs.created_at AS session_created_at,
           cs.updated_at AS session_updated_at
         FROM approvals a
         LEFT JOIN runs r ON r.id = a.run_id
         LEFT JOIN chat_sessions cs ON cs.id = r.chat_session_id
         ORDER BY CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END, a.decided_at DESC, a.id DESC
         LIMIT ?`,
      )
      .all(limit);

    return rows.map((row) => ({
      approval: mapApprovalRecordRow(row),
      session: mapOptionalSessionFromJoinedRow(row),
      runStatus: row.run_status ?? undefined,
    }));
  }

  async enqueueInboundMessage(input: EnqueueInboundMessageInput): Promise<boolean> {
    const id = `in_${randomUUID()}`;
    const result = this.db
      .prepare(
        `INSERT INTO inbound_messages (
           id, adapter_id, external_message_id, conversation_id, payload_json, status, created_at
         )
         VALUES (?, ?, ?, ?, ?, 'queued', ?)
         ON CONFLICT(adapter_id, external_message_id) DO NOTHING`,
      )
      .run(
        id,
        input.message.adapterId,
        input.message.messageId ?? null,
        input.message.conversationId,
        input.payloadJson,
        new Date().toISOString(),
      );

    return result.changes > 0;
  }

  async claimNextQueuedInboundMessage(): Promise<QueuedInboundMessage | undefined> {
    const row = this.db.transaction((): QueuedInboundMessageRow | undefined => {
      const nextRow = this.db
        .prepare<[], QueuedInboundMessageRow>(
          `SELECT id, adapter_id, external_message_id, conversation_id, payload_json, status, created_at, started_at, completed_at, error_text
           FROM inbound_messages
           WHERE status = 'queued'
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get();

      if (!nextRow) {
        return undefined;
      }

      const now = new Date().toISOString();
      const claimed = this.db
        .prepare(`UPDATE inbound_messages SET status = 'processing', started_at = ?, error_text = NULL WHERE id = ? AND status = 'queued'`)
        .run(now, nextRow.id);

      if (claimed.changes === 0) {
        return undefined;
      }

      return {
        ...nextRow,
        status: "processing",
        started_at: now,
        error_text: null,
      };
    })();

    return row ? mapQueuedInboundRow(row) : undefined;
  }

  async completeInboundMessage(id: string): Promise<void> {
    this.db
      .prepare(`UPDATE inbound_messages SET status = 'completed', completed_at = ?, error_text = NULL WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  async hasQueuedInboundMessages(): Promise<boolean> {
    const row = this.db
      .prepare<[], { value: number }>(`SELECT 1 AS value FROM inbound_messages WHERE status = 'queued' LIMIT 1`)
      .get();

    return row !== undefined;
  }

  async failInboundMessage(id: string, errorText: string): Promise<void> {
    this.db
      .prepare(`UPDATE inbound_messages SET status = 'failed', completed_at = ?, error_text = ? WHERE id = ?`)
      .run(new Date().toISOString(), errorText, id);
  }

  async requeueProcessingInboundMessages(): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE inbound_messages
         SET status = 'queued', started_at = NULL, completed_at = NULL, error_text = NULL
         WHERE status = 'processing'`,
      )
      .run();

    return result.changes;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        adapter_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        external_chat_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        codex_thread_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(adapter_id, external_chat_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        chat_session_id TEXT NOT NULL,
        codex_turn_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error_text TEXT,
        codex_request_json TEXT,
        codex_response_json TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS inbound_messages (
        id TEXT PRIMARY KEY,
        adapter_id TEXT NOT NULL,
        external_message_id TEXT,
        conversation_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error_text TEXT,
        UNIQUE(adapter_id, external_message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_chat_session_started
      ON runs(chat_session_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_inbound_messages_status_created
      ON inbound_messages(status, created_at);
    `);

    this.ensureNullableColumn("runs", "codex_request_json", "TEXT");
    this.ensureNullableColumn("runs", "codex_response_json", "TEXT");
  }

  private ensureNullableColumn(tableName: string, columnName: string, columnType: string): void {
    const columns = this.db
      .prepare<[], { name: string }>(`PRAGMA table_info(${tableName})`)
      .all();

    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
}

function mapChatSessionRow(row: ChatSessionRow): ChatSession {
  return {
    id: row.id,
    adapterId: row.adapter_id,
    channel: row.channel,
    externalChatId: row.external_chat_id,
    displayName: row.display_name,
    codexThreadId: row.codex_thread_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRunRecordRow(row: RunRecordRow): RunRecord {
  return {
    id: row.id,
    chatSessionId: row.chat_session_id,
    codexTurnId: row.codex_turn_id ?? undefined,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    errorText: row.error_text ?? undefined,
    codexRequestJson: row.codex_request_json ?? undefined,
    codexResponseJson: row.codex_response_json ?? undefined,
  };
}

function mapApprovalRecordRow(row: ApprovalRecordRow): ApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    requestId: row.request_id,
    kind: row.kind,
    threadId: row.thread_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    payloadJson: row.payload_json,
    status: row.status,
    decidedAt: row.decided_at ?? undefined,
  };
}

function mapLatestRunFromSessionActivityRow(row: SessionActivityRow): RunRecord | undefined {
  if (!row.latest_run_id || !row.latest_run_chat_session_id || !row.latest_run_status || !row.latest_run_started_at) {
    return undefined;
  }

  return {
    id: row.latest_run_id,
    chatSessionId: row.latest_run_chat_session_id,
    codexTurnId: row.latest_run_codex_turn_id ?? undefined,
    status: row.latest_run_status,
    startedAt: row.latest_run_started_at,
    completedAt: row.latest_run_completed_at ?? undefined,
    errorText: row.latest_run_error_text ?? undefined,
  };
}

function mapSessionFromJoinedRow(row: RunHistoryRow): ChatSession {
  return {
    id: row.session_id,
    adapterId: row.session_adapter_id,
    channel: row.session_channel,
    externalChatId: row.session_external_chat_id,
    displayName: row.session_display_name,
    codexThreadId: row.session_codex_thread_id ?? undefined,
    createdAt: row.session_created_at,
    updatedAt: row.session_updated_at,
  };
}

function mapOptionalSessionFromJoinedRow(row: ApprovalHistoryRow): ChatSession | undefined {
  if (
    !row.session_id
    || !row.session_adapter_id
    || !row.session_channel
    || !row.session_external_chat_id
    || !row.session_display_name
    || !row.session_created_at
    || !row.session_updated_at
  ) {
    return undefined;
  }

  return {
    id: row.session_id,
    adapterId: row.session_adapter_id,
    channel: row.session_channel,
    externalChatId: row.session_external_chat_id,
    displayName: row.session_display_name,
    codexThreadId: row.session_codex_thread_id ?? undefined,
    createdAt: row.session_created_at,
    updatedAt: row.session_updated_at,
  };
}

function mapQueuedInboundRow(row: QueuedInboundMessageRow): QueuedInboundMessage {
  return {
    id: row.id,
    adapterId: row.adapter_id,
    messageId: row.external_message_id ?? undefined,
    conversationId: row.conversation_id,
    payloadJson: row.payload_json,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    errorText: row.error_text ?? undefined,
  };
}
