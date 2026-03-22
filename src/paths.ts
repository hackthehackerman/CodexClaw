import os from "os";
import path from "path";

export function resolveCodexClawHome(): string {
  const configured = process.env.CODEXCLAW_HOME;
  return configured
    ? path.resolve(configured)
    : path.join(os.homedir(), ".codexclaw");
}

export function resolveDefaultConfigPath(): string {
  const configured = process.env.CODEXCLAW_CONFIG_PATH;
  return configured
    ? path.resolve(configured)
    : path.join(resolveCodexClawHome(), "codexclaw.toml");
}

export function resolveDefaultStateDir(baseDir?: string): string {
  const configured = process.env.CODEXCLAW_STATE_DIR;
  return configured
    ? path.resolve(configured)
    : path.join(baseDir ?? resolveCodexClawHome(), "state");
}

export function resolveDefaultStateDbPath(baseDir?: string): string {
  return path.join(resolveDefaultStateDir(baseDir), "codexclaw.db");
}

export function resolveRuntimeConfigPath(explicit?: string): string {
  if (explicit) {
    return path.resolve(explicit);
  }

  if (process.env.CODEXCLAW_CONFIG_PATH) {
    return path.resolve(process.env.CODEXCLAW_CONFIG_PATH);
  }

  return resolveDefaultConfigPath();
}
