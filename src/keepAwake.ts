import path from "path";
import type { CodexClawConfig } from "./config/schema";

export const KEEP_AWAKE_ENV_VAR = "CODEXCLAW_UNDER_CAFFEINATE";

export function shouldUseKeepAwake(
  config: CodexClawConfig,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === "darwin"
    && config.host.keepAwake
    && env[KEEP_AWAKE_ENV_VAR] !== "1";
}

export function buildCaffeinateInvocation(
  scriptPath: string,
  configPath: string,
  nodePath = process.execPath,
): { command: string; args: string[] } {
  return {
    command: "caffeinate",
    args: [
      "-dimsu",
      nodePath,
      path.resolve(scriptPath),
      "start",
      "--config",
      path.resolve(configPath),
    ],
  };
}
