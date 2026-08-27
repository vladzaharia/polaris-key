// Framework-agnostic CLI command core. Each command takes plain arguments + a `PolarisKeyClient`
// and returns a `CommandResult` (an outcome flag + a human-readable message + optional
// structured data). The commander / yargs adapters are thin shells over these, so the behavior
// lives in exactly one place and is testable with no console / process side-effects.
//
// v3 groups the verbs by the service that owns them, which is the CLI's version of the same
// carve the SDK just went through:
//
//   license  activate · enroll · deactivate · status
//   devices  register
//   config   config <key>
//   core     import-bundle
//
// `register` is the new one and the reason the grouping matters: it is a DEVICES verb, not a
// licensing one. A config-only product (D-08) has no `activate` to run and its whole
// provisioning story is `pkey register` — which under a licence-shaped CLI would have had
// nowhere to live.

import type { JSONValue } from "@polaris-key/protocol/core";
import type { TrustSet } from "@polaris-key/jws";
import type { PolarisKeyClient } from "../client.js";
import type { ActivationResult } from "../license/endpoints.js";
import type { ServiceSlug } from "../discovery.js";

/** A command's outcome: a success flag, a human-readable line, and optional structured
 *  data (e.g. the resolved gate status or a config value) for callers that want JSON. */
export interface CommandResult {
  ok: boolean;
  message: string;
  data?: unknown;
}

/** The parsed-flag shape an adapter hands to a `ClientFactory`. Mirrors the subset of
 *  `PolarisKeyClientOptions` a CLI front end typically exposes as flags. */
export interface ClientFactoryOptions {
  productSlug: string;
  version: string;
  /** Pinned trust set (kid -> raw Ed25519 pubkey base64url). */
  pinnedKeys: TrustSet;
  baseUrl?: string;
  configDir?: string;
  /** The D-21 capability fallback, when the host build knows what it expects. */
  expectedServices?: ServiceSlug[];
}

/** Builds (and initializes) a `PolarisKeyClient` from parsed flags. A consumer wires this once
 *  with its product slug + pinned trust, and the adapters call it per-invocation. */
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

// ── license ────────────────────────────────────────────────────────────────────────────
/** Activate this device with a licence `key` and pull the first documents. */
export async function activate(
  client: PolarisKeyClient,
  key: string,
): Promise<CommandResult> {
  const r = await client.license.activateWithKey(key);
  if (r.kind === "ok") {
    const st = client.status();
    return { ok: true, message: `Activated. Status: ${st.status}`, data: st };
  }
  return describeFailure(r, "Activation");
}

/** Obtain a licence with no key and no sign-in, when the product offers a free tier. */
export async function enroll(client: PolarisKeyClient): Promise<CommandResult> {
  const r = await client.license.enroll();
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
  await client.license.deactivate();
  return { ok: true, message: "Deactivated. Local credentials wiped." };
}

/** Report the current gate status + a short profile/grace summary. `ok` reflects whether the
 *  gate currently permits running (so an adapter can map it to a process exit code) — which
 *  for a product with License disabled is TRUE on `not-applicable`, not a failure. */
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
  const profile = client.license.getProfile();
  if (profile !== null)
    lines.push(`Licensed to: ${profile.name} <${profile.email}>`);
  const usable = client.isLicensed();
  lines.push(`Usable: ${usable}`);
  return { ok: usable, message: lines.join("\n"), data: st };
}

// ── devices ────────────────────────────────────────────────────────────────────────────
/**
 * `POST /<p>/devices/register` — the keyless device mint (§6).
 *
 * The provisioning verb for a product whose registration policy is `open`, and the only one a
 * config-only product has. A `requires-license` product answers `registration_closed`, which
 * is reported as-is rather than being retried against `activate`: the two are different
 * operator intents and quietly substituting one would hide a misconfigured policy.
 */
export async function register(
  client: PolarisKeyClient,
): Promise<CommandResult> {
  const r = await client.devices.register();
  switch (r.kind) {
    case "ok": {
      await client.sync({ force: true });
      const st = client.status();
      return {
        ok: true,
        message: `Registered device ${r.deviceId}. Status: ${st.status}`,
        data: { deviceId: r.deviceId, status: st },
      };
    }
    case "registration-closed":
      return {
        ok: false,
        message:
          "Registration failed: this product does not accept keyless registration. " +
          "Activate with a licence key instead.",
        data: r,
      };
    case "rate-limited":
      return {
        ok: false,
        message: "Registration failed: too many attempts; try again shortly.",
        data: r,
      };
    case "not-configured":
      return {
        ok: false,
        message: "Registration failed: unknown product.",
        data: r,
      };
    case "error":
      return {
        ok: false,
        message: `Registration failed: ${r.message || "unknown error."}`,
        data: r,
      };
  }
}

// ── config ─────────────────────────────────────────────────────────────────────────────
/** Resolve the effective value for a config `key` (honouring management state + override
 *  layers), reporting its provenance. Returns `ok: false` only when nothing matched and no
 *  `fallback` was provided. */
export function getConfig(
  client: PolarisKeyClient,
  key: string,
  fallback?: JSONValue,
): CommandResult {
  const sentinel = Symbol("unset");
  const value = client.config.getConfig<JSONValue | typeof sentinel>(
    key,
    sentinel,
  );
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
  const source = client.config.getConfigSource(key);
  return {
    ok: true,
    message: `${key} = ${JSON.stringify(value)} (${source})`,
    data: { key, value, source },
  };
}

// ── core ───────────────────────────────────────────────────────────────────────────────
/** Import an offline activation bundle (§7). All-or-nothing: a rejection leaves the install
 *  exactly as it was, and the message names the step that refused. */
export async function importBundle(
  client: PolarisKeyClient,
  jws: string,
): Promise<CommandResult> {
  try {
    const r = await client.importBundle(jws);
    const st = client.status();
    return {
      ok: true,
      message: `Imported bundle ${r.bundleId} (${r.imported.join("+") || "nothing"}). Status: ${st.status}`,
      data: { ...r, status: st },
    };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      ok: false,
      message: `Bundle import failed: ${err.message ?? "unknown error."}`,
      data: { code: err.code },
    };
  }
}
