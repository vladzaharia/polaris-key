/// <reference types="@cloudflare/workers-types" />

// Hardware-fingerprint matching. The device id (`X-PKey-Device`) stays the stable primary key
// every existing row and signed doc is bound to; the fingerprint is a separate, server-verified
// signal layered on top, so enabling it can never orphan an existing device.
//
// Components arrive already hashed on-device, so this module never sees a raw serial. It is
// pure apart from `computeHwid`, which needs WebCrypto — matching is deliberately synchronous
// and I/O-free so the whole decision table is unit-testable without a DB or an Env.

import {
  FINGERPRINT_ANCHOR,
  FINGERPRINT_COMPONENTS,
  FINGERPRINT_COMPONENT_LENGTH,
  FINGERPRINT_HASH_PREFIX,
  FINGERPRINT_HWID_LENGTH,
  FINGERPRINT_TOLERANCE,
  type FingerprintComponent,
  type FingerprintMode,
} from "@polaris-key/protocol";
import { sha256B64url } from "./crypto.js";

export type ComponentMap = Partial<Record<FingerprintComponent, string>>;

/** A fingerprint as stored in `device_fingerprints`. */
export interface StoredFingerprint {
  hwid: string;
  components: ComponentMap;
  anchorHash: string | null;
  status: "verified" | "unverified";
}

/** A fingerprint as presented by a client, after validation. The client's own `hwid` is
 *  deliberately discarded — see `parseFingerprint`. */
export interface PresentedFingerprint {
  components: ComponentMap;
}

export type FingerprintMatch =
  | { kind: "exact" }
  | { kind: "drift"; drift: number; changed: FingerprintComponent[] }
  | { kind: "mismatch"; drift: number; changed: FingerprintComponent[] };

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const COMPONENT_SET = new Set<string>(FINGERPRINT_COMPONENTS);

/** Valid modes, mirroring the `FingerprintMode` union at runtime. */
export function isFingerprintMode(value: unknown): value is FingerprintMode {
  return (
    value === "off" ||
    value === "lenient" ||
    value === "normal" ||
    value === "strict"
  );
}

/**
 * Validate a client-submitted fingerprint. Returns null for anything malformed so callers can
 * treat "no usable fingerprint" as one case regardless of why.
 *
 * The client's `hwid` is intentionally IGNORED here and recomputed by the server from the
 * components. A forged hwid would otherwise let a caller collide with another device's dedupe
 * key; recomputing removes that surface entirely, and leaves the client's own value as a purely
 * local convenience that the conformance vectors (not production) are responsible for pinning.
 */
export function parseFingerprint(input: unknown): PresentedFingerprint | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = (input as { components?: unknown }).components;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const components: ComponentMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Unknown component names are dropped rather than rejected, so a newer SDK reporting a
    // component this Worker doesn't know about still activates.
    if (!COMPONENT_SET.has(key)) continue;
    if (typeof value !== "string") return null;
    if (value.length !== FINGERPRINT_COMPONENT_LENGTH) return null;
    if (!B64URL_RE.test(value)) return null;
    components[key as FingerprintComponent] = value;
  }
  if (Object.keys(components).length === 0) return null;
  return { components };
}

/** The composite dedupe key: the present components, in canonical order, hashed as one. */
export async function computeHwid(components: ComponentMap): Promise<string> {
  const parts: string[] = [];
  for (const component of FINGERPRINT_COMPONENTS) {
    const value = components[component];
    if (value !== undefined) parts.push(`${component}=${value}`);
  }
  return sha256B64url(parts.join("\n"), FINGERPRINT_HWID_LENGTH);
}

/** The per-component digest, exposed so tests and the conformance generator share one formula. */
export async function computeComponentHash(
  product: string,
  component: FingerprintComponent,
  rawValue: string,
): Promise<string> {
  return sha256B64url(
    `${FINGERPRINT_HASH_PREFIX}:${product}:${component}:${rawValue}`,
    FINGERPRINT_COMPONENT_LENGTH,
  );
}

/**
 * Compare a presented fingerprint against the stored one.
 *
 * Drift is counted asymmetrically, and that asymmetry is the security-relevant part:
 *
 * - A component that was stored and is now **missing or different** counts as drift. Without
 *   this, a caller could simply omit every component that doesn't match and pass at tolerance 0.
 * - A component that is **newly present** does not count. An SDK upgrade that learns to read
 *   two more components must not look like a two-component hardware change to every device that
 *   updates.
 *
 * The anchor (`machineUuid`) widens tolerance by one when it still matches — a machine whose
 * platform UUID is intact is very likely the same machine that had a disk and a NIC replaced.
 * The bonus only ever WIDENS an existing tolerance; it never creates one, so `strict` really
 * does mean zero drift rather than quietly becoming "one".
 */
export function matchFingerprint(
  stored: StoredFingerprint,
  presented: PresentedFingerprint,
  mode: FingerprintMode,
): FingerprintMatch {
  const changed: FingerprintComponent[] = [];
  for (const component of FINGERPRINT_COMPONENTS) {
    const before = stored.components[component];
    if (before === undefined) continue;
    if (presented.components[component] !== before) changed.push(component);
  }

  if (changed.length === 0) return { kind: "exact" };

  const base = FINGERPRINT_TOLERANCE[mode];
  const anchorHeld =
    stored.anchorHash !== null &&
    presented.components[FINGERPRINT_ANCHOR] === stored.anchorHash;
  const tolerance = base + (base > 0 && anchorHeld ? 1 : 0);

  return changed.length <= tolerance
    ? { kind: "drift", drift: changed.length, changed }
    : { kind: "mismatch", drift: changed.length, changed };
}

/** Resolve the effective mode: the tier's policy, else the product default, else `normal`. */
export function resolveFingerprintMode(
  tierPolicy: string | null | undefined,
  productDefault: string | null | undefined,
): FingerprintMode {
  if (isFingerprintMode(tierPolicy)) return tierPolicy;
  if (isFingerprintMode(productDefault)) return productDefault;
  return "normal";
}

/** A product-declared companion-application check the client answers present/absent. */
export interface ProbeDeclaration {
  id: string;
  label: string;
  /** Per-platform lookup hint (a bundle id, a registry key, a package name). */
  macos?: string;
  windows?: string;
  linux?: string;
}

export interface FingerprintPolicy {
  /** Per-product opt-out. When false, clients are told not to collect hardware components. */
  enabled: boolean;
  defaultMode: FingerprintMode;
  probes: ProbeDeclaration[];
}

/** On by default at `normal`: a product with no policy row still gets drift-tolerant binding,
 *  and clients that predate fingerprinting are recorded as `unverified` rather than refused. */
export const DEFAULT_FINGERPRINT_POLICY: FingerprintPolicy = {
  enabled: true,
  defaultMode: "normal",
  probes: [],
};

function parseProbes(input: unknown): ProbeDeclaration[] {
  if (!Array.isArray(input)) return [];
  const probes: ProbeDeclaration[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id) continue;
    probes.push({
      id: entry.id,
      label: typeof entry.label === "string" ? entry.label : entry.id,
      ...(typeof entry.macos === "string" ? { macos: entry.macos } : {}),
      ...(typeof entry.windows === "string" ? { windows: entry.windows } : {}),
      ...(typeof entry.linux === "string" ? { linux: entry.linux } : {}),
    });
  }
  return probes;
}

/** Parse `products.fingerprint_policy_json`, falling back to the default on absent or
 *  unparseable JSON — a malformed policy must never take a product's licensing offline. */
export function parseFingerprintPolicy(
  json: string | null | undefined,
): FingerprintPolicy {
  if (!json) return DEFAULT_FINGERPRINT_POLICY;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return DEFAULT_FINGERPRINT_POLICY;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_FINGERPRINT_POLICY;
  }
  const entry = raw as Record<string, unknown>;
  return {
    enabled: entry.enabled === false ? false : true,
    defaultMode: isFingerprintMode(entry.defaultMode)
      ? entry.defaultMode
      : DEFAULT_FINGERPRINT_POLICY.defaultMode,
    probes: parseProbes(entry.probes),
  };
}

// ── Auto-issue policy ────────────────────────────────────────────────────────
// Lives here rather than in its own module because it shares the same manifest-vs-admin
// ownership machinery and is read on the same activation path.

/** Which keyless paths a product's auto-issue policy opens. */
export type AutoIssueMode = "anonymous" | "oidcDefault" | "both";

export interface AutoIssuePolicy {
  enabled: boolean;
  /** The tier an auto-issued license lands on. Required when enabled. */
  tierId: string | null;
  mode: AutoIssueMode;
  /** Per-IP enrolment ceiling. 0 disables the limit. */
  rateLimitPerHour: number;
}

/** Off unless a product opts in — auto-issuing licenses is never a silent default. */
export const DEFAULT_AUTO_ISSUE: AutoIssuePolicy = {
  enabled: false,
  tierId: null,
  mode: "anonymous",
  rateLimitPerHour: 10,
};

export function isAutoIssueMode(value: unknown): value is AutoIssueMode {
  return value === "anonymous" || value === "oidcDefault" || value === "both";
}

/** Parse `products.auto_issue_json`, falling back to "off" on absent or unparseable JSON —
 *  a malformed policy must fail CLOSED (issue nothing), never open. */
export function parseAutoIssue(
  json: string | null | undefined,
): AutoIssuePolicy {
  if (!json) return DEFAULT_AUTO_ISSUE;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return DEFAULT_AUTO_ISSUE;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_AUTO_ISSUE;
  }
  const entry = raw as Record<string, unknown>;
  const tierId =
    typeof entry.tierId === "string" && entry.tierId ? entry.tierId : null;
  return {
    // A policy with no tier can't issue anything coherent, so it is treated as disabled
    // rather than quietly minting tier-less licenses.
    enabled: entry.enabled === true && tierId !== null,
    tierId,
    mode: isAutoIssueMode(entry.mode) ? entry.mode : DEFAULT_AUTO_ISSUE.mode,
    rateLimitPerHour:
      typeof entry.rateLimitPerHour === "number" &&
      Number.isFinite(entry.rateLimitPerHour) &&
      entry.rateLimitPerHour >= 0
        ? Math.trunc(entry.rateLimitPerHour)
        : DEFAULT_AUTO_ISSUE.rateLimitPerHour,
  };
}

/** Whether the policy opens the keyless `POST /<product>/enroll` path. */
export function allowsAnonymousEnroll(policy: AutoIssuePolicy): boolean {
  return (
    policy.enabled && (policy.mode === "anonymous" || policy.mode === "both")
  );
}

/** Whether an authenticated user matching no IdP group should fall back to the free tier. */
export function allowsOidcDefault(policy: AutoIssuePolicy): boolean {
  return (
    policy.enabled && (policy.mode === "oidcDefault" || policy.mode === "both")
  );
}
