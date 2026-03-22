import { strict as assert } from "assert";
import { parseAdminCommand } from "../src/core/approvalCommands";
import { test } from "./helpers/harness";

test("parseAdminCommand preserves approval id case", () => {
  const command = parseAdminCommand("APPROVE APPR_019d16b4-617d-78d2-bbdd-d83f7b777901 SESSION");
  assert.deepEqual(command, {
    action: "approve",
    approvalId: "APPR_019d16b4-617d-78d2-bbdd-d83f7b777901",
    scope: "session",
  });
});
