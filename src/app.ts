import { createAdapters } from "./adapters";
import { AppServerClient } from "./codex/appServerClient";
import type { CodexClawConfig } from "./config/schema";
import type { Logger } from "./logger";
import { PerThreadQueue } from "./queue/perThreadQueue";
import { SessionRouter } from "./router/sessionRouter";
import { InMemoryStateStore } from "./storage/stateStore";
import { Gateway } from "./runtime/gateway";

export function createApp(config: CodexClawConfig, logger: Logger): Gateway {
  const store = new InMemoryStateStore();
  const adapters = createAdapters(config.adapters, logger);
  const codex = new AppServerClient(logger.child("codex"), {
    command: config.codex.command,
    approvalPolicy: config.codex.approvalPolicy,
    sandbox: config.codex.sandbox,
    model: config.codex.model,
    effort: config.codex.effort,
    summary: config.codex.summary,
  });
  const router = new SessionRouter(config.routes, config.workspaces, store, logger.child("router"));
  const queue = new PerThreadQueue();

  return new Gateway(
    config,
    adapters,
    router,
    queue,
    codex,
    store,
    logger.child("gateway"),
  );
}
