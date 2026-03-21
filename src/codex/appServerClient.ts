import { promises as fs } from "fs";
import path from "path";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import readline from "readline";
import type { Logger } from "../logger";

export interface ThreadInitContext {
  workspaceCwd: string;
  developerInstructionsPath: string;
  avatarPath?: string;
}

export interface TurnRequest {
  threadId: string;
  messageText: string;
  workspaceCwd: string;
  senderName: string;
}

export interface TurnResult {
  turnId: string;
  finalResponse: string;
}

export interface ApprovalRequest {
  requestId: string;
  kind: "command" | "fileChange" | "permissions";
  threadId: string;
  turnId: string;
  itemId: string;
  summary: string;
  payload: unknown;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type ApprovalRequestHandler = (request: ApprovalRequest) => Promise<void>;

export interface AppServerClientOptions {
  command: string[];
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  model?: string;
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary: string;
}

type JsonRpcId = number | string;

interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcResponse<T = unknown> {
  id: JsonRpcId;
  result?: T;
  error?: JsonRpcError;
}

interface PendingRequest<T = unknown> {
  method: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface ActiveTurnState {
  turnId: string;
  itemTexts: Map<string, string>;
  latestItemId?: string;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
}

interface PendingApprovalState {
  id: JsonRpcId;
  kind: ApprovalRequest["kind"];
  payload: Record<string, unknown>;
}

interface InitializeResult {
  userAgent: string;
  platformFamily: string;
  platformOs: string;
}

interface ThreadStartResult {
  thread: { id: string };
}

interface TurnStartResult {
  turn: { id: string; status: string };
}

export class AppServerClient {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly pendingApprovals = new Map<string, PendingApprovalState>();
  private readonly pendingAvatarByThreadId = new Map<string, string>();

  private child?: ChildProcessWithoutNullStreams;
  private approvalHandler?: ApprovalRequestHandler;
  private startPromise?: Promise<void>;
  private nextRequestId = 1;

  constructor(
    private readonly logger: Logger,
    private readonly options: AppServerClientOptions,
  ) {}

  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.startInternal();
    }

    await this.startPromise;
  }

  setApprovalRequestHandler(handler: ApprovalRequestHandler): void {
    this.approvalHandler = handler;
  }

  async createThread(context: ThreadInitContext): Promise<string> {
    await this.start();

    const developerInstructions = await fs.readFile(context.developerInstructionsPath, "utf8");
    const result = await this.sendRequest<ThreadStartResult>("thread/start", {
      cwd: context.workspaceCwd,
      approvalPolicy: this.options.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: this.options.sandbox,
      model: this.options.model,
      developerInstructions,
      personality: "none",
      serviceName: "codexclaw",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });

    const threadId = result.thread.id;

    if (context.avatarPath && await fileExists(context.avatarPath)) {
      this.pendingAvatarByThreadId.set(threadId, context.avatarPath);
    } else if (context.avatarPath) {
      this.logger.warn("Avatar path is configured but missing; skipping seed image", {
        avatarPath: context.avatarPath,
      });
    }

    this.logger.info("Created Codex thread", {
      threadId,
      workspaceCwd: context.workspaceCwd,
    });

    return threadId;
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    await this.start();

    const input: Array<Record<string, unknown>> = [];
    const avatarPath = this.pendingAvatarByThreadId.get(request.threadId);

    if (avatarPath) {
      input.push({
        type: "text",
        text: "Reference image: this is what CodexClaw looks like. Use it as the bot's visual identity reference.",
        text_elements: [],
      });
      input.push({
        type: "localImage",
        path: avatarPath,
      });
      this.pendingAvatarByThreadId.delete(request.threadId);
    }

    input.push({
      type: "text",
      text: `From ${request.senderName}: ${request.messageText}`,
      text_elements: [],
    });

    const started = await this.sendRequest<TurnStartResult>("turn/start", {
      threadId: request.threadId,
      input,
      cwd: request.workspaceCwd,
      model: this.options.model,
      effort: this.options.effort,
      summary: this.options.summary,
      personality: "none",
    });

    const turnId = started.turn.id;

    return await new Promise<TurnResult>((resolve, reject) => {
      this.activeTurns.set(turnId, {
        turnId,
        itemTexts: new Map<string, string>(),
        resolve,
        reject,
      });
    });
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const pendingApproval = this.pendingApprovals.get(requestId);

    if (!pendingApproval) {
      throw new Error(`Unknown approval request id: ${requestId}`);
    }

    const result = buildApprovalResponse(pendingApproval.kind, decision, pendingApproval.payload);
    this.sendResponse(pendingApproval.id, result);
    this.pendingApprovals.delete(requestId);
  }

  private async startInternal(): Promise<void> {
    const [command, ...args] = this.options.command;

    if (!command) {
      throw new Error("Codex command is empty");
    }

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildEnv(command),
    });

    this.child = child;
    this.attachReaders(child);

    child.once("error", (error) => {
      this.failOutstandingWork(new Error(`Failed to start codex app-server: ${error.message}`));
    });

    child.once("exit", (code, signal) => {
      this.failOutstandingWork(
        new Error(`codex app-server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`),
      );
    });

    const initializeResult = await this.sendRequest<InitializeResult>("initialize", {
      clientInfo: {
        name: "codexclaw",
        title: "CodexClaw",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.sendNotification("initialized", {});

    this.logger.info("Connected to Codex app-server", {
      command: this.options.command,
      userAgent: initializeResult.userAgent,
      platformFamily: initializeResult.platformFamily,
      platformOs: initializeResult.platformOs,
    });
  }

  private attachReaders(child: ChildProcessWithoutNullStreams): void {
    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      void this.handleStdoutLine(line);
    });

    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      if (line.trim().length > 0) {
        this.logger.debug("codex app-server stderr", { line });
      }
    });
  }

  private async handleStdoutLine(line: string): Promise<void> {
    if (line.trim().length === 0) {
      return;
    }

    let message: Record<string, unknown>;

    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn("Ignoring non-JSON stdout line from codex app-server", {
        line,
        error,
      });
      return;
    }

    if ("result" in message || "error" in message) {
      this.handleResponse(message as unknown as JsonRpcResponse);
      return;
    }

    if ("method" in message && "id" in message) {
      await this.handleServerRequest(
        message.method as string,
        message.id as JsonRpcId,
        (message.params ?? {}) as Record<string, unknown>,
      );
      return;
    }

    if ("method" in message) {
      this.handleNotification(message.method as string, (message.params ?? {}) as Record<string, unknown>);
      return;
    }

    this.logger.debug("Ignoring unknown app-server message", { message });
  }

  private handleResponse(message: JsonRpcResponse): void {
    const key = jsonRpcIdKey(message.id);
    const pending = this.pendingRequests.get(key);

    if (!pending) {
      this.logger.warn("Received response for unknown request id", { id: message.id });
      return;
    }

    this.pendingRequests.delete(key);

    if (message.error) {
      pending.reject(formatJsonRpcError(pending.method, message.error));
      return;
    }

    pending.resolve(message.result);
  }

  private async handleServerRequest(
    method: string,
    id: JsonRpcId,
    params: Record<string, unknown>,
  ): Promise<void> {
    const requestId = jsonRpcIdKey(id);

    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        const approval = toApprovalRequest(method, requestId, params);
        this.pendingApprovals.set(requestId, {
          id,
          kind: approval.kind,
          payload: params,
        });

        if (!this.approvalHandler) {
          this.logger.warn("No approval handler is registered; auto-canceling request", {
            requestId,
            method,
          });
          this.sendResponse(id, buildApprovalResponse(approval.kind, "cancel", params));
          this.pendingApprovals.delete(requestId);
          return;
        }

        await this.approvalHandler(approval);
        return;
      }
      default:
        this.logger.warn("Received unsupported server request", { method, id, params });
        this.sendError(id, -32601, `Unsupported server request: ${method}`);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "thread/started":
        this.logger.info("Codex thread started", { threadId: extractThreadId(params) });
        return;
      case "turn/started":
        this.logger.info("Codex turn started", {
          turnId: extractNestedString(params, "turn", "id"),
          threadId: params.threadId,
        });
        return;
      case "item/agentMessage/delta":
        this.handleAgentMessageDelta(params);
        return;
      case "item/completed":
        this.handleItemCompleted(params);
        return;
      case "turn/completed":
        this.handleTurnCompleted(params);
        return;
      case "serverRequest/resolved":
        this.pendingApprovals.delete(jsonRpcIdKey(params.requestId as JsonRpcId));
        return;
      case "error":
        this.logger.error("Codex turn error notification", params);
        return;
      default:
        this.logger.debug("Codex notification", { method, params });
    }
  }

  private handleAgentMessageDelta(params: Record<string, unknown>): void {
    const turnId = asString(params.turnId);
    const itemId = asString(params.itemId);
    const delta = asString(params.delta);

    if (!turnId || !itemId || delta === undefined) {
      return;
    }

    const turn = this.activeTurns.get(turnId);

    if (!turn) {
      return;
    }

    const previous = turn.itemTexts.get(itemId) ?? "";
    turn.itemTexts.set(itemId, `${previous}${delta}`);
    turn.latestItemId = itemId;
  }

  private handleItemCompleted(params: Record<string, unknown>): void {
    const turnId = asString(params.turnId);
    const item = params.item as Record<string, unknown> | undefined;

    if (!turnId || !item || item.type !== "agentMessage") {
      return;
    }

    const itemId = asString(item.id);
    const text = asString(item.text);

    if (!itemId || text === undefined) {
      return;
    }

    const turn = this.activeTurns.get(turnId);

    if (!turn) {
      return;
    }

    turn.itemTexts.set(itemId, text);
    turn.latestItemId = itemId;
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = params.turn as Record<string, unknown> | undefined;
    if (!turn) {
      return;
    }

    const turnId = asString(turn.id);

    if (!turnId) {
      return;
    }

    const activeTurn = this.activeTurns.get(turnId);

    if (!activeTurn) {
      return;
    }

    this.activeTurns.delete(turnId);

    const status = asString(turn.status);

    if (status === "completed") {
      activeTurn.resolve({
        turnId,
        finalResponse: this.collectFinalResponse(activeTurn),
      });
      return;
    }

    const errorMessage = extractNestedString(turn, "error", "message");

    if (status === "failed") {
      activeTurn.reject(new Error(errorMessage ?? `Codex turn ${turnId} failed`));
      return;
    }

    activeTurn.reject(new Error(errorMessage ?? `Codex turn ${turnId} ${status ?? "ended unexpectedly"}`));
  }

  private collectFinalResponse(turn: ActiveTurnState): string {
    if (turn.latestItemId) {
      return (turn.itemTexts.get(turn.latestItemId) ?? "").trim();
    }

    return Array.from(turn.itemTexts.values()).join("\n").trim();
  }

  private async sendRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextRequestId++;
    const key = jsonRpcIdKey(id);

    const response = new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(key, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });

    this.writeMessage({ id, method, params });
    return await response;
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    this.writeMessage(params ? { method, params } : { method });
  }

  private sendResponse(id: JsonRpcId, result: Record<string, unknown>): void {
    this.writeMessage({ id, result });
  }

  private sendError(id: JsonRpcId, code: number, message: string): void {
    this.writeMessage({
      id,
      error: { code, message },
    });
  }

  private writeMessage(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) {
      throw new Error("codex app-server stdin is not writable");
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failOutstandingWork(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const turn of this.activeTurns.values()) {
      turn.reject(error);
    }
    this.activeTurns.clear();

    this.pendingApprovals.clear();
    this.startPromise = undefined;

    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }
}

function buildChildEnv(command: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (command.includes(path.sep)) {
    const currentPath = env.PATH ?? "";
    const commandDir = path.dirname(command);
    const nextPath = currentPath.length > 0
      ? `${commandDir}${path.delimiter}${currentPath}`
      : commandDir;

    env.PATH = nextPath;
  }

  return env;
}

function formatJsonRpcError(method: string, error: JsonRpcError): Error {
  const parts = [
    `Codex app-server request failed for ${method}`,
    error.message ? `message=${error.message}` : undefined,
    error.code !== undefined ? `code=${error.code}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return new Error(parts.join(" "));
}

function toApprovalRequest(
  method: string,
  requestId: string,
  params: Record<string, unknown>,
): ApprovalRequest {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return {
        requestId,
        kind: "command",
        threadId: asRequiredString(params.threadId, "threadId"),
        turnId: asRequiredString(params.turnId, "turnId"),
        itemId: asRequiredString(params.itemId, "itemId"),
        summary: buildCommandApprovalSummary(params),
        payload: params,
      };
    case "item/fileChange/requestApproval":
      return {
        requestId,
        kind: "fileChange",
        threadId: asRequiredString(params.threadId, "threadId"),
        turnId: asRequiredString(params.turnId, "turnId"),
        itemId: asRequiredString(params.itemId, "itemId"),
        summary: asString(params.reason) ?? "Approve file changes",
        payload: params,
      };
    case "item/permissions/requestApproval":
      return {
        requestId,
        kind: "permissions",
        threadId: asRequiredString(params.threadId, "threadId"),
        turnId: asRequiredString(params.turnId, "turnId"),
        itemId: asRequiredString(params.itemId, "itemId"),
        summary: asString(params.reason) ?? "Grant requested permissions",
        payload: params,
      };
    default:
      throw new Error(`Unsupported approval request method: ${method}`);
  }
}

function buildCommandApprovalSummary(params: Record<string, unknown>): string {
  const reason = asString(params.reason);
  const command = asString(params.command);
  const cwd = asString(params.cwd);

  if (command && cwd && reason) {
    return `${reason} (${command} in ${cwd})`;
  }

  if (command && cwd) {
    return `${command} in ${cwd}`;
  }

  return reason ?? "Approve command execution";
}

function buildApprovalResponse(
  kind: ApprovalRequest["kind"],
  decision: ApprovalDecision,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (kind === "permissions") {
    const permissions = decision === "accept" || decision === "acceptForSession"
      ? ((payload.permissions as Record<string, unknown> | undefined) ?? {})
      : {};

    return {
      permissions,
      scope: decision === "acceptForSession" ? "session" : "turn",
    };
  }

  return {
    decision: decision === "decline" ? "decline" : decision,
  };
}

function extractThreadId(params: Record<string, unknown>): string | undefined {
  const thread = params.thread as Record<string, unknown> | undefined;
  return thread ? asString(thread.id) : undefined;
}

function extractNestedString(
  root: Record<string, unknown>,
  parentKey: string,
  childKey: string,
): string | undefined {
  const parent = root[parentKey] as Record<string, unknown> | undefined;
  if (!parent) {
    return undefined;
  }

  return asString(parent[childKey]);
}

function asRequiredString(value: unknown, fieldName: string): string {
  const parsed = asString(value);

  if (!parsed) {
    throw new Error(`Expected string field ${fieldName}`);
  }

  return parsed;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function jsonRpcIdKey(value: JsonRpcId): string {
  return String(value);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
