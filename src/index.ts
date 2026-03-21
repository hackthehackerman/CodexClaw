import path from "path";
import { createApp } from "./app";
import { loadConfig } from "./config/loadConfig";
import { createLogger } from "./logger";

async function main(): Promise<void> {
  const logger = createLogger();
  const configPath = resolveConfigPath();
  const config = await loadConfig(configPath, logger.child("config"));
  const gateway = createApp(config, logger);
  await gateway.start();
}

function resolveConfigPath(): string {
  const explicit = process.env.CODEXCLAW_CONFIG ?? process.argv[2];
  return explicit ? path.resolve(explicit) : path.resolve(process.cwd(), "codexclaw.toml");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
