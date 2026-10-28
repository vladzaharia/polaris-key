// The account verbs' shared edges (identity.account, identity.attach): the typed refusals both
// adapters give, and opening the portal page. The call itself is each transport's.

import { Feature } from "../constants.generated.js";
import { UnsupportedError } from "./caps.js";
import { isSecureTransportUrl } from "./types.js";

/** The identity endpoints an account call reads off discovery's identity fragment
 *  (`identity.endpoints`, WIRE-CONTRACT-V4 §12.6). Anything absent is unavailable. */
export interface AccountEndpoints {
  subject?: string;
  signout?: string;
  attach?: string;
  accountPortal?: string;
}

/** The named string endpoints of a discovery document's identity fragment, or `null` when the
 *  service is off or has no endpoint table. An absent or empty one is left out. */
export function identityEndpointsOf<K extends string>(
  discovery: Record<string, unknown> | null | undefined,
  keys: readonly K[],
): Partial<Record<K, string>> | null {
  const services = discovery?.services as
    | Record<string, { enabled?: unknown; endpoints?: unknown } | undefined>
    | undefined;
  const identity = services?.identity;
  if (identity?.enabled !== true) return null;
  const e = identity.endpoints;
  if (e === null || typeof e !== "object") return null;
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    const v = (e as Record<string, unknown>)[k];
    if (typeof v === "string" && v !== "") out[k] = v;
  }
  return out;
}

/** The identity fragment's account endpoints from a discovery document, or `null`. */
export function accountEndpointsOf(
  discovery: Record<string, unknown> | null | undefined,
): AccountEndpoints | null {
  return identityEndpointsOf(discovery, [
    "subject",
    "signout",
    "attach",
    "accountPortal",
  ]);
}

/** The typed refusal of an account verb the product's discovery does not offer. */
export function accountUnavailable(
  feature: string,
  endpoint: string,
): UnsupportedError {
  return new UnsupportedError({
    supported: false,
    feature,
    reason: "product",
    detail: `This product's discovery names no identity ${endpoint} endpoint.`,
  });
}

/** `identity.account` / `identity.attach` feature ids, for the typed refusals. */
export const AccountFeature = {
  account: Feature.identityAccount,
  attach: Feature.identityAttach,
} as const;

/** Open the portal page in a new tab. Only an https link (or loopback http) opens. */
export function openPortal(url: string): void {
  if (!isSecureTransportUrl(url)) return;
  if (typeof window !== "undefined" && typeof window.open === "function")
    window.open(url, "_blank", "noopener,noreferrer");
}

/** The functions `signOut()` awaits before it signs out (Cloud Sync's flush registers one, D-4). */
export class BeforeSignOutHooks {
  private readonly hooks: Array<() => Promise<void> | void> = [];

  /** Register a hook; returns its remover. */
  add(hook: () => Promise<void> | void): () => void {
    this.hooks.push(hook);
    return () => {
      const i = this.hooks.indexOf(hook);
      if (i !== -1) this.hooks.splice(i, 1);
    };
  }

  /** Await every hook, in registration order. */
  async run(): Promise<void> {
    for (const hook of [...this.hooks]) await hook();
  }
}
