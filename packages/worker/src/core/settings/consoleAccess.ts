/**
 * The one writer of `console.access` (ST-28 plan §2.4, ST-32.2). Only a Superadmin writes rules,
 * with a step-up, an L2 confirm and a reason (`PRIVILEGE_GRANT_KEYS`, `rules.ts`). The generic
 * platform settings route does not serve a `json` key, so this is the only way in.
 *
 * Rule ids are the server's: a rule with no `id` gets one here, and a rule that names an `id`
 * must name one already stored. `writeSettings()` then re-checks the document, the operator
 * connections and the domains (`consoleAccessCheck.ts`), and refuses a non-Superadmin or a
 * session with no step-up on its own, so a caller that skips this function is refused too.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { isSteppedUp, type AdminSession } from "../console/session.js";
import { parseAccessRules } from "../rbac/claimMatcher.js";
import type { SettingsRegistry } from "./registry.js";
import { resolvePlatformSetting } from "./resolve.js";
import { CONSOLE_ACCESS_KEY } from "./consoleAccessCheck.js";
import { writeSetting, type WriteOutcome } from "./write.js";

export interface ConsoleAccessWrite {
  /** The whole document. `null`/absent `op: "reset"` empties it. */
  value?: unknown;
  op?: "set" | "reset";
  expectedVersion: unknown;
  reason?: unknown;
  /** The typed confirmation: the key itself. */
  confirm?: string;
}

/** A fresh rule id: `r_` plus 12 random hex characters (`claimMatcher.ts` takes 6 to 32). */
export function mintRuleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `r_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function writeConsoleAccess(
  ctx: { env: Env; db: Db; registry: SettingsRegistry },
  session: AdminSession,
  input: ConsoleAccessWrite,
  now: number,
): Promise<WriteOutcome> {
  const op = input.op ?? "set";
  let value: unknown;
  if (op === "set") {
    const stored = await resolvePlatformSetting(ctx, CONSOLE_ACCESS_KEY, {
      fresh: true,
    });
    const known = new Set<string>();
    const doc = stored.value as { rules?: Array<{ id?: unknown }> } | undefined;
    for (const r of doc?.rules ?? [])
      if (typeof r?.id === "string") known.add(r.id);
    const parsed = parseAccessRules(input.value, {
      mintId: mintRuleId,
      knownIds: known,
    });
    if (!parsed.ok)
      return {
        ok: false,
        status: 422,
        reason: "invalid_value",
        key: CONSOLE_ACCESS_KEY,
        message: parsed.reason,
      };
    value = parsed.doc;
  }
  return writeSetting(
    ctx,
    {
      key: CONSOLE_ACCESS_KEY,
      op,
      // ST-32.5: a rule write is an `rbac.*` row, like a grant, so Members' trail reads one family.
      audit: { action: "rbac.access_rules" },
      ...(op === "set" ? { value } : {}),
      expectedVersion:
        typeof input.expectedVersion === "number"
          ? input.expectedVersion
          : undefined,
      reason: input.reason as string | null | undefined,
    },
    {
      actor: {
        sub: session.sub,
        name: session.name ?? null,
        email: session.email ?? null,
      },
      origin: "console",
      principal: session.principal,
      steppedUp: isSteppedUp(session, now),
      now,
      ...(typeof input.confirm === "string" ? { confirm: input.confirm } : {}),
    },
  );
}
