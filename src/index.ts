import { createApp } from "./app";
import { loadConfig } from "./config/loadConfig";
import { createLogger } from "./logger";
import { resolveRuntimeConfigPath } from "./paths";

export async function startApp(explicitConfigPath?: string): Promise<void> {
  const logger = createLogger();
  const configPath = resolveConfigPath(explicitConfigPath);
  const config = await loadConfig(configPath, logger.child("config"));
  const app = createApp(config, logger, configPath);
  await app.start();
}

export function resolveConfigPath(explicit?: string): string {
  return resolveRuntimeConfigPath(explicit);
}

if (require.main === module) {
  startApp(process.argv[2]).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
