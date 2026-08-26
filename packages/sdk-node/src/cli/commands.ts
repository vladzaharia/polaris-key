// Framework-agnostic CLI command core. Each command takes plain arguments + a
// `PolarisKeyClient` and returns a `CommandResult` (an outcome flag + a human-readable
// message + optional structured data). The commander / yargs adapters are thin shells over
// these, so the behavior lives in exactly one place and is testable with no console /
// process side-effects. Mirrors sdks/python/src/polaris_key/cli/core.py.

import type { TrustSet } from "@polaris-key/jws";
import type { JSONValue } from "@polaris-key/protocol";
import type { PolarisKeyClient } from "../client.js";
import type { ActivationResult } from "../endpoints.js";

/** A command's outcome: a success flag, a human-readable line, and optional structured
 *  data (e.g. the resolved gate status or a config value) for callers that want JSON. */
export interface CommandResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

/** The parsed-flag shape an adapter hands to a `ClientFactory` to build a client. Mirrors
 *  the subset of `PolarisKeyOptions` a CLI front end typically exposes as flags. */
export interface ClientFactoryOptions {
  productSlug: string;
  version: string;
  /** Pinned trust set (kid -> raw Ed25519 pubkey base64url). */
  pinnedKeys: TrustSet;
  baseUrl?: string;
  configDir?: string;
}

/** Builds (and initializes) a `PolarisKeyClient` from parsed flags. A consumer wires this
 *  once with its product slug + pinned trust, and the adapters call it per-invocation. */
export type ClientFactory = (
  opts: ClientFactoryOptions,
) => Promise<PolarisKeyClient>;

/** Render a non-ok activation outcome. Shared by `activate` and `enroll` so the two can't
 *  drift into describing the same server response differently. */
function describeFailure(
  r: Exclude<ActivationResult, { kind: "ok" }>,
  verb: string,
): CommandResult {
  const fail = (message: string): CommandResult => ({
    ok: false,
    message: `${verb} failed: ${message}`,
    data: r,
  });
  switch (r.kind) {
    case "device-limit": {
      const detail =
        r.limit !== undefined
          ? ` (${r.deviceCount ?? "?"}/${r.limit} devices in use)`
          : "";
      return fail(`device limit reached${detail}.`);
    }
    case "unauthorized":
      return fail("invalid or revoked credential.");
    case "fingerprint-required":
      return fail(
        "a hardware fingerprint is required but could not be collected on this host.",
      );
    case "hardware-mismatch": {
      const changed = r.changed?.length ? ` (${r.changed.join(", ")})` : "";
      return fail(
        `this machine's hardware changed${changed}. ` +
          "The previous authorization was released — run the command again to re-bind.",
      );
    }
    case "enroll-disabled":
      return fail("this product does not offer keyless enrollment.");
    case "error":
      return fail(r.message || "unknown error.");
  }
}

/** Activate this device with a license `key` and pull the first config doc. */
export async function activate(
  client: PolarisKeyClient,
  key: string,
): Promise<CommandResult> {
  const r = await client.activateWithKey(key);
  if (r.kind === "ok") {
    const st = client.status();
    return { ok: true, message: `Activated. Status: ${st.status}`, data: st };
  }
  return describeFailure(r, "Activation");
}

/** Obtain a license with no key and no sign-in, when the product offers a free tier. */
export async function enroll(client: PolarisKeyClient): Promise<CommandResult> {
  const r = await client.enroll();
  if (r.kind === "ok") {
    const st = client.status();
    return { ok: true, message: `Enrolled. Status: ${st.status}`, data: st };
  }
  return describeFailure(r, "Enrollment");
}

/** Deauthorize this device and wipe the local token + cache. */
export async function deactivate(
  client: PolarisKeyClient,
): Promise<CommandResult> {
  await client.deactivate();
  return { ok: true, message: "Deactivated. Local credentials wiped." };
}

/** Report the current gate status + a short profile/grace summary. `ok` reflects whether
 *  the gate currently permits running (so an adapter can map it to a process exit code). */
export function status(client: PolarisKeyClient): CommandResult {
  const st = client.status();
  const lines = [`Status: ${st.status}`];
  if (st.graceUntil !== undefined)
    lines.push(`Grace until (epoch): ${st.graceUntil}`);
  if (st.allowedRange !== undefined) {
    const ar = st.allowedRange;
    lines.push(
      `Allowed version range: min=${ar.min ?? "-"} max=${ar.max ?? "-"}`,
    );
  }
  const profile = client.getProfile();
  if (profile !== null)
    lines.push(`Licensed to: ${profile.name} <${profile.email}>`);
  const usable = client.isLicensed();
  lines.push(`Usable: ${usable}`);
  return { ok: usable, message: lines.join("\n"), data: st };
}

/** Resolve the effective value for a config `key` (honoring management state + override
 *  layers), reporting its provenance. Returns `ok: false` only when nothing matched and no
 *  `fallback` was provided. */
export function getConfig(
  client: PolarisKeyClient,
  key: string,
  fallback?: JSONValue,
): CommandResult {
  const sentinel = Symbol("unset");
  const value = client.getConfig<JSONValue | typeof sentinel>(key, sentinel);
  if (value === sentinel) {
    if (fallback === undefined) {
      return {
        ok: false,
        message: `${key} is not set (no value and no fallback).`,
      };
    }
    return {
      ok: true,
      message: `${key} = ${JSON.stringify(fallback)} (fallback)`,
      data: { key, value: fallback, source: "fallback" as const },
    };
  }
  const source = client.getConfigSource(key);
  return {
    ok: true,
    message: `${key} = ${JSON.stringify(value)} (${source})`,
    data: { key, value, source },
  };
}
