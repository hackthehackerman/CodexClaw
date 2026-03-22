import http, { type IncomingMessage, type ServerResponse } from "http";
import type { Logger } from "../logger";
import type { ConfigManager } from "../config/configManager";
import type { ApprovalHistoryRecord, RunHistoryRecord, SessionActivitySummary, StateStore } from "../storage/stateStore";
import { dashboardCss, dashboardJs, renderDashboardHtml } from "./dashboardDocument";

interface ControlServerOptions {
  enabled: boolean;
  host: string;
  port: number;
}

interface OverviewResponse {
  generatedAt: string;
  stats: {
    totalSessions: number;
    activeRuns: number;
    pendingApprovals: number;
  };
  sessions: SessionActivitySummary[];
  runs: RunHistoryRecord[];
  approvals: ApprovalHistoryRecord[];
  config: ReturnType<ConfigManager["getSnapshot"]>;
}

export class ControlServer {
  private server?: http.Server;
  private listeningUrl?: string;

  constructor(
    private readonly options: ControlServerOptions,
    private readonly configManager: ConfigManager,
    private readonly store: StateStore,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (!this.options.enabled) {
      this.logger.info("Control server disabled by config");
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("HTTP server not initialized"));
        return;
      }

      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    this.listeningUrl = `http://${this.options.host}:${port}`;

    this.logger.info("Control server listening", {
      url: this.listeningUrl,
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => error ? reject(error) : resolve());
    });
    this.server = undefined;
    this.listeningUrl = undefined;
  }

  getUrl(): string | undefined {
    return this.listeningUrl;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    try {
      if (method === "GET" && url.pathname === "/") {
        this.respondText(response, 200, renderDashboardHtml(), "text/html; charset=utf-8");
        return;
      }

      if (method === "GET" && url.pathname === "/app.css") {
        this.respondText(response, 200, dashboardCss, "text/css; charset=utf-8");
        return;
      }

      if (method === "GET" && url.pathname === "/app.js") {
        this.respondText(response, 200, dashboardJs, "text/javascript; charset=utf-8");
        return;
      }

      if (method === "GET" && url.pathname === "/api/overview") {
        this.respondJson(response, 200, await this.buildOverview());
        return;
      }

      if (method === "PUT" && url.pathname === "/api/config") {
        const payload = await readJsonBody(request);
        const snapshot = await this.configManager.updateEditableConfig(payload);
        this.respondJson(response, 200, { config: snapshot });
        return;
      }

      if (method === "GET" && url.pathname === "/favicon.ico") {
        response.statusCode = 204;
        response.end();
        return;
      }

      this.respondJson(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Control server request failed", {
        method,
        pathname: url.pathname,
        error: message,
      });
      this.respondJson(response, 500, { error: message });
    }
  }

  private async buildOverview(): Promise<OverviewResponse> {
    const [sessions, runs, approvals] = await Promise.all([
      this.store.listSessionActivity(20),
      this.store.listRecentRuns(40),
      this.store.listRecentApprovals(20),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      stats: {
        totalSessions: sessions.length,
        activeRuns: runs.filter((entry) => entry.run.status === "queued" || entry.run.status === "in_progress").length,
        pendingApprovals: approvals.filter((entry) => entry.approval.status === "pending").length,
      },
      sessions,
      runs,
      approvals,
      config: this.configManager.getSnapshot(),
    };
  }

  private respondJson(response: ServerResponse, statusCode: number, payload: unknown): void {
    this.respondText(response, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
  }

  private respondText(response: ServerResponse, statusCode: number, body: string, contentType: string): void {
    response.statusCode = statusCode;
    response.setHeader("content-type", contentType);
    response.end(body);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  if (!body) {
    return {};
  }

  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object payload");
  }

  return parsed as Record<string, unknown>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  return new Promise<string>((resolve, reject) => {
    request.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += buffer.length;
      if (totalBytes > 64 * 1024) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }

      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
