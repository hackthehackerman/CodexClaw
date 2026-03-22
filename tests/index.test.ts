import { strict as assert } from "assert";
import os from "os";
import path from "path";
import { test } from "./helpers/harness";

test("resolveConfigPath defaults to ~/.codexclaw/codexclaw.toml", async () => {
  const { resolveConfigPath } = await import("../src/index");
  const previousConfigPath = process.env.CODEXCLAW_CONFIG_PATH;
  const previousHome = process.env.CODEXCLAW_HOME;

  try {
    delete process.env.CODEXCLAW_CONFIG_PATH;
    delete process.env.CODEXCLAW_HOME;
    const expected = path.join(os.homedir(), ".codexclaw", "codexclaw.toml");
    assert.equal(resolveConfigPath(), expected);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.CODEXCLAW_CONFIG_PATH;
    } else {
      process.env.CODEXCLAW_CONFIG_PATH = previousConfigPath;
    }
    if (previousHome === undefined) {
      delete process.env.CODEXCLAW_HOME;
    } else {
      process.env.CODEXCLAW_HOME = previousHome;
    }
  }
});

test("resolveConfigPath ignores process argv subcommands and honors explicit paths", async () => {
  const { resolveConfigPath } = await import("../src/index");
  const previousArgv = process.argv;
  const previousConfigPath = process.env.CODEXCLAW_CONFIG_PATH;
  const previousHome = process.env.CODEXCLAW_HOME;

  try {
    delete process.env.CODEXCLAW_CONFIG_PATH;
    delete process.env.CODEXCLAW_HOME;
    process.argv = ["node", "dist/cli.js", "start"];
    assert.equal(resolveConfigPath(), path.join(os.homedir(), ".codexclaw", "codexclaw.toml"));
    assert.equal(resolveConfigPath("custom.toml"), path.resolve(process.cwd(), "custom.toml"));
  } finally {
    process.argv = previousArgv;
    if (previousConfigPath === undefined) {
      delete process.env.CODEXCLAW_CONFIG_PATH;
    } else {
      process.env.CODEXCLAW_CONFIG_PATH = previousConfigPath;
    }
    if (previousHome === undefined) {
      delete process.env.CODEXCLAW_HOME;
    } else {
      process.env.CODEXCLAW_HOME = previousHome;
    }
  }
});

test("resolveConfigPath honors CODEXCLAW_CONFIG_PATH", async () => {
  const { resolveConfigPath } = await import("../src/index");
  const previousConfigPath = process.env.CODEXCLAW_CONFIG_PATH;

  try {
    process.env.CODEXCLAW_CONFIG_PATH = "/tmp/codexclaw-from-env.toml";
    assert.equal(resolveConfigPath(), "/tmp/codexclaw-from-env.toml");
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.CODEXCLAW_CONFIG_PATH;
    } else {
      process.env.CODEXCLAW_CONFIG_PATH = previousConfigPath;
    }
  }
});
