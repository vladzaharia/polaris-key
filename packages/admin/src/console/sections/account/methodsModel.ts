/**
 * The words and groups of Sign-in methods (ST-30c.4). Pure, so the page and its tests share one
 * wording: a method that opens the console says so in these words everywhere.
 */

import type { ConsoleMethod } from "../../../api.js";
import { errorCopy } from "../../../lib/errorCopy.js";
import { kindLabel, passkeyName } from "../../../lib/methodNames.js";
import { PasskeyError } from "../../../lib/webauthn.js";

/** What "opens the console" is called, wherever the page says it. */
export const OPENS = "Opens the console";
export const LOCKER_ONLY = "Polaris Locker only";

/** A row's title: the passkey's name, the address, or the kind in words. */
export function baseTitle(m: ConsoleMethod): string {
  if (m.kind === "passkey") return passkeyName(m);
  return m.name ?? kindLabel(m.kind);
}

/**
 * Every row's title, with an ordinal on titles that two rows share ("Chrome on macOS (1)"), so no
 * two rows look alike or share an accessible name.
 */
export function titles(methods: readonly ConsoleMethod[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const m of methods)
    count.set(baseTitle(m), (count.get(baseTitle(m)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const m of methods) {
    const t = baseTitle(m);
    if ((count.get(t) ?? 0) < 2) {
      out.set(m.id, t);
      continue;
    }
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    out.set(m.id, `${t} (${n})`);
  }
  return out;
}

/** The two groups: what opens the console, and what stays in the Locker. */
export function grouped(methods: readonly ConsoleMethod[]): {
  opens: ConsoleMethod[];
  locker: ConsoleMethod[];
} {
  return {
    opens: methods.filter((m) => m.strong),
    locker: methods.filter((m) => !m.strong),
  };
}

/** Why Add a passkey is off (soft-disabled), or null when it is on. */
export function addOffReason(input: {
  supported: boolean;
  canAdd: boolean | undefined;
  reason: "limit" | "email_unverified" | null | undefined;
  passkeys: number;
}): string | null {
  if (!input.supported) return "This browser can't create passkeys.";
  if (input.canAdd !== false) return null;
  if (input.reason === "limit")
    return `You have ${input.passkeys} passkeys. Remove one in Polaris Locker to add another.`;
  if (input.reason === "email_unverified")
    return "Confirm your email in Polaris Locker to add a passkey.";
  return "A passkey can't be added right now.";
}

/** What a refused write says, keyed off the Worker's `reason` or `code`, never its sentence. */
export function refusal(error: unknown): {
  title: string;
  description?: string;
} {
  const e = error as { reason?: string; code?: string; status?: number } | null;
  const key = e?.reason ?? e?.code;
  switch (key) {
    case "limit":
      return {
        title: "You have the most passkeys an account can hold",
        description: "Remove one in Polaris Locker to add another.",
      };
    case "email_unverified":
      return {
        title: "Confirm your email first",
        description: "Confirm it in Polaris Locker, then add a passkey.",
      };
    case "account_session_required":
      return {
        title: "Sign in again",
        description: "Sign out, then sign in with your account to do this.",
      };
    case "break_glass_session":
      return {
        title: "Emergency sign-in can't manage sign-in methods",
        description: "Sign in with your account to manage them.",
      };
    case "link_conflict":
      return {
        title: "This passkey is already on an account",
        description: "Use another device or security key.",
      };
    case "signin_expired":
      return { title: "That took too long", description: "Try again." };
    case "not_eligible":
      return { title: "This passkey can't open the console" };
    case "already_strong":
      return { title: "This passkey already opens the console" };
  }
  if (error instanceof PasskeyError)
    return { title: "Couldn't add the passkey", description: "Try again." };
  return errorCopy(error, { thing: "sign-in methods" });
}
