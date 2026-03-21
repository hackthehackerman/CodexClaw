export interface Logger {
  child(scope: string): Logger;
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

class ConsoleLogger implements Logger {
  constructor(private readonly scope: string) {}

  child(scope: string): Logger {
    return new ConsoleLogger(`${this.scope}:${scope}`);
  }

  debug(message: string, details?: unknown): void {
    this.log("DEBUG", message, details);
  }

  info(message: string, details?: unknown): void {
    this.log("INFO", message, details);
  }

  warn(message: string, details?: unknown): void {
    this.log("WARN", message, details);
  }

  error(message: string, details?: unknown): void {
    this.log("ERROR", message, details);
  }

  private log(level: LogLevel, message: string, details?: unknown): void {
    const prefix = `${new Date().toISOString()} ${level} [${this.scope}]`;

    if (details === undefined) {
      console.log(`${prefix} ${message}`);
      return;
    }

    console.log(`${prefix} ${message}`, details);
  }
}

export function createLogger(scope = "codexclaw"): Logger {
  return new ConsoleLogger(scope);
}

