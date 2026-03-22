import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

run("npm", ["test"]);
run("npm", ["run", "typecheck"]);
run("npm", ["run", "build"]);
run("npm", ["pack", "--dry-run"]);

const telegramDir = mkdtempSync(path.join(tmpdir(), "codexclaw-v0-telegram-"));
const imessageDir = mkdtempSync(path.join(tmpdir(), "codexclaw-v0-imessage-"));

try {
  run(node, [
    "dist/cli.js",
    "init",
    "--config",
    path.join(telegramDir, "codexclaw.toml"),
    "--force",
    "--telegram-chat",
    "123456789",
    "--telegram-bot-token",
    "123456:verification-token",
  ]);

  run(node, [
    "dist/cli.js",
    "doctor",
    "--offline",
    "--config",
    path.join(telegramDir, "codexclaw.toml"),
  ]);

  run(node, [
    "dist/cli.js",
    "init",
    "--config",
    path.join(imessageDir, "codexclaw.toml"),
    "--force",
    "--imessage-chat",
    "any;-;+15555550123",
    "--bluebubbles-password",
    "verification-password",
    "--imessage-admin-sender",
    "+15555550123",
  ]);

  run(node, [
    "dist/cli.js",
    "doctor",
    "--offline",
    "--config",
    path.join(imessageDir, "codexclaw.toml"),
  ]);

  console.log("");
  console.log("v0 verification passed");
} finally {
  rmSync(telegramDir, { recursive: true, force: true });
  rmSync(imessageDir, { recursive: true, force: true });
}

function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}`);
  }
}
