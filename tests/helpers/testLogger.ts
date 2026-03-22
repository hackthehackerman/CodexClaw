import type { Logger } from "../../src/logger";

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
  details?: unknown;
}

export class TestLogger implements Logger {
  readonly entries: LogEntry[];

  constructor(private readonly scope = "test", entries?: LogEntry[]) {
    this.entries = entries ?? [];
  }

  child(scope: string): Logger {
    return new TestLogger(`${this.scope}:${scope}`, this.entries);
  }

  debug(message: string, details?: unknown): void {
    this.entries.push({ level: "debug", scope: this.scope, message, details });
  }

  info(message: string, details?: unknown): void {
    this.entries.push({ level: "info", scope: this.scope, message, details });
  }

  warn(message: string, details?: unknown): void {
    this.entries.push({ level: "warn", scope: this.scope, message, details });
  }

  error(message: string, details?: unknown): void {
    this.entries.push({ level: "error", scope: this.scope, message, details });
  }
}
