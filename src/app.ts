import { createAdapters } from "./adapters";
import { AppServerClient } from "./codex/appServerClient";
import { ConfigManager } from "./config/configManager";
import type { CodexClawConfig } from "./config/schema";
import type { Logger } from "./logger";
import { PerThreadQueue } from "./queue/perThreadQueue";
import { SessionRouter } from "./router/sessionRouter";
import { AppRuntime } from "./runtime/appRuntime";
import { SqliteStateStore } from "./storage/stateStore";
import { Gateway } from "./runtime/gateway";
import { ControlServer } from "./web/controlServer";

export function createApp(config: CodexClawConfig, logger: Logger, configPath: string): AppRuntime {
  const store = new SqliteStateStore(config.storage.dbPath, logger.child("storage"));
  const adapters = createAdapters(config.transports, config.bot.aliases, logger);
  const codex = new AppServerClient(logger.child("codex"), {
    command: config.codex.command,
    approvalPolicy: config.codex.approvalPolicy,
    sandbox: config.codex.sandbox,
    networkAccess: config.codex.networkAccess,
    model: config.codex.model,
    effort: config.codex.effort,
    summary: config.codex.summary,
  });
  const router = new SessionRouter({
    workspaceId: config.bot.workspaceId,
    policyDefault: config.policy.default,
    allowRules: config.allow,
    denyRules: config.deny,
    admins: config.admins,
  }, config.workspaces, store, logger.child("router"));
  const queue = new PerThreadQueue();
  const gateway = new Gateway(
    config,
    adapters,
    router,
    queue,
    codex,
    store,
    logger.child("gateway"),
  );
  const configManager = new ConfigManager(configPath, config, logger.child("config-manager"), (nextConfig) => {
    codex.applyRuntimeConfig(nextConfig.codex);
  });
  const controlServer = new ControlServer(config.web, configManager, store, logger.child("control"));

  return new AppRuntime(gateway, controlServer);
}
