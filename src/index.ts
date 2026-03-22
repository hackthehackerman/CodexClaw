import path from "path";
import { createApp } from "./app";
import { loadConfig } from "./config/loadConfig";
import { createLogger } from "./logger";

export async function startApp(explicitConfigPath?: string): Promise<void> {
  const logger = createLogger();
  const configPath = resolveConfigPath(explicitConfigPath);
  const config = await loadConfig(configPath, logger.child("config"));
  const app = createApp(config, logger, configPath);
  await app.start();
}

export function resolveConfigPath(explicit?: string): string {
  const configured = explicit ?? process.env.CODEXCLAW_CONFIG ?? process.argv[2];
  return configured ? path.resolve(configured) : path.resolve(process.cwd(), "codexclaw.toml");
}

if (require.main === module) {
  startApp().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
