import { strict as assert } from "assert";
import { buildCaffeinateInvocation, shouldUseKeepAwake } from "../src/keepAwake";
import { test } from "./helpers/harness";

test("shouldUseKeepAwake enables caffeinate only on macOS when configured", () => {
  const enabled = shouldUseKeepAwake({
    host: { keepAwake: true },
  } as never, "darwin", {});
  const disabledPlatform = shouldUseKeepAwake({
    host: { keepAwake: true },
  } as never, "linux", {});
  const disabledConfig = shouldUseKeepAwake({
    host: { keepAwake: false },
  } as never, "darwin", {});
  const disabledMarker = shouldUseKeepAwake({
    host: { keepAwake: true },
  } as never, "darwin", { CODEXCLAW_UNDER_CAFFEINATE: "1" });

  assert.equal(enabled, true);
  assert.equal(disabledPlatform, false);
  assert.equal(disabledConfig, false);
  assert.equal(disabledMarker, false);
});

test("buildCaffeinateInvocation wraps codexclaw start with an explicit config path", () => {
  const invocation = buildCaffeinateInvocation(
    "/Users/example/lib/node_modules/codexclaw/dist/cli.js",
    "/Users/example/.codexclaw/codexclaw.toml",
    "/opt/homebrew/bin/node",
  );

  assert.equal(invocation.command, "caffeinate");
  assert.deepEqual(invocation.args, [
    "-dimsu",
    "/opt/homebrew/bin/node",
    "/Users/example/lib/node_modules/codexclaw/dist/cli.js",
    "start",
    "--config",
    "/Users/example/.codexclaw/codexclaw.toml",
  ]);
});
