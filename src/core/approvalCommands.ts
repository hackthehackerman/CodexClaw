export type AdminCommand =
  | { action: "approve"; approvalId: string; scope: "turn" | "session" }
  | { action: "deny"; approvalId: string }
  | { action: "cancel"; approvalId: string };

const commandPattern = /^(APPROVE|DENY|CANCEL)\s+([A-Z0-9_-]+)(?:\s+(SESSION))?$/i;

export function parseAdminCommand(text: string): AdminCommand | null {
  const match = text.trim().match(commandPattern);

  if (!match) {
    return null;
  }

  const action = match[1].toUpperCase();
  const approvalId = match[2].toUpperCase();
  const sessionFlag = match[3]?.toUpperCase() === "SESSION";

  if (action === "APPROVE") {
    return {
      action: "approve",
      approvalId,
      scope: sessionFlag ? "session" : "turn",
    };
  }

  if (action === "DENY") {
    return { action: "deny", approvalId };
  }

  return { action: "cancel", approvalId };
}

