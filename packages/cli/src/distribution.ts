/**
 * `pkey distribution report|rollout|pause|resume|halt|complete` (P2b-03): the CI side of
 * Distribution, on P2-06's token plumbing (`resolveCiToken`, `ciClient`).
 *
 *   report availability  POST /<p>/distribution/report  {type: "availability", …}  distribution:report
 *   report submission    POST /<p>/distribution/report  {type: "submission", …}    distribution:report
 *   report key           POST /<p>/distribution/report  {type: "key", purpose, sha256, outlet?}
 *   rollout              POST /<p>/distribution/rollouts/<outlet>/<channel>        distribution:rollout
 *                        {releaseId, bp, deliverable?}
 *   pause|resume|halt|complete
 *                        POST /<p>/distribution/rollouts/<outlet>/<channel>/<verb>  distribution:rollout
 *                        {releaseId?, deliverable?}
 *
 * `distribution:report` is in the default CI grant, so the job's exchanged OIDC token can report.
 * `distribution:rollout` is opt-in: an operator grants it (a static token, or the product's
 * publisher policy), and a token without it is refused 403 `missing_scope`.
 *
 * A key report whose fingerprint is not in the product's key inventory is FLAGGED by the Worker
 * (the inventory is unchanged); the command then exits non-zero, so the job that signed with an
 * unexpected key fails visibly.
 */

import { ciClient, type CiClient, type Out, type Sleep } from "./ci.js";
import { resolveCiToken, type CiEnv } from "./oidc.js";

export const DISTRIBUTION_CI_USAGE =
  "Usage: pkey distribution report availability --product <slug> --outlet <id> (--release <id> | --version <v> [--deliverable id])\n" +
  "              [--build <id>] --state <state> [--since <epoch>] [--platform-ref <json>] [--detail <json>]\n" +
  "       pkey distribution report submission --product <slug> --outlet <id> (--release <id> | --version <v> [--deliverable id])\n" +
  "              --state <state> [--since <epoch>] [--detail <json>]\n" +
  "       pkey distribution report key --product <slug> --purpose <purpose> --sha256 <hex> [--outlet <id>]\n" +
  "       pkey distribution rollout --product <slug> --outlet <id> --channel <c> --release <id> --bp <0-10000> [--deliverable id]\n" +
  "       pkey distribution pause|resume|halt|complete --product <slug> --outlet <id> --channel <c> [--release <id>] [--deliverable id]";

export type ReportType = "availability" | "submission" | "key";
export type RolloutCommand =
  | "rollout"
  | "pause"
  | "resume"
  | "halt"
  | "complete";
export const ROLLOUT_COMMANDS: readonly RolloutCommand[] = [
  "rollout",
  "pause",
  "resume",
  "halt",
  "complete",
];

export interface DistributionCommandOptions {
  product: string;
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

async function clientFor(opts: DistributionCommandOptions): Promise<CiClient> {
  const token = await resolveCiToken({
    baseUrl: opts.baseUrl,
    product: opts.product,
    env: opts.env,
    out: opts.stdout,
    log: opts.stderr,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  return ciClient({
    baseUrl: opts.baseUrl,
    product: opts.product,
    token,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    log: opts.stderr,
  });
}

/**
 * A fingerprint as tools print it (`AA:BB:…` from keytool and apksigner, spaces, upper case) in
 * the Worker's form: 64 lower-case hex characters.
 */
export function normalizeFingerprint(raw: string): string {
  const hex = raw.replace(/[\s:]/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex))
    throw new Error(
      `--sha256 must be a SHA-256 fingerprint: 64 hex characters, colons allowed (got ${JSON.stringify(raw)}).`,
    );
  return hex;
}

function jsonObjectFlag(name: string, raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error(`--${name} must be a JSON object (got ${raw}).`);
  }
  if (v !== null && (typeof v !== "object" || Array.isArray(v)))
    throw new Error(`--${name} must be a JSON object (got ${raw}).`);
  return v;
}

function epochFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new Error(`--since must be epoch seconds (got ${raw}).`);
  return n;
}

export interface ReportOptions extends DistributionCommandOptions {
  type: ReportType;
  outlet?: string;
  releaseId?: string;
  version?: string;
  deliverable?: string;
  buildId?: string;
  state?: string;
  since?: string;
  platformRef?: string;
  detail?: string;
  purpose?: string;
  sha256?: string;
}

/** The request body a report sends, validated locally where the CLI can (the Worker decides). */
export function reportBody(opts: ReportOptions): Record<string, unknown> {
  if (opts.type === "key") {
    if (!opts.purpose || !opts.sha256)
      throw new Error(
        `pkey distribution report key needs --purpose and --sha256.\n${DISTRIBUTION_CI_USAGE}`,
      );
    return {
      type: "key",
      purpose: opts.purpose,
      sha256: normalizeFingerprint(opts.sha256),
      ...(opts.outlet ? { outlet: opts.outlet } : {}),
    };
  }
  if (!opts.outlet || !opts.state)
    throw new Error(
      `pkey distribution report ${opts.type} needs --outlet and --state.\n${DISTRIBUTION_CI_USAGE}`,
    );
  if (Boolean(opts.releaseId) === Boolean(opts.version))
    throw new Error(
      `Give exactly one of --release or --version.\n${DISTRIBUTION_CI_USAGE}`,
    );
  if (opts.releaseId && opts.deliverable)
    throw new Error("--deliverable goes with --version, not --release.");
  if (opts.type === "submission" && (opts.buildId || opts.platformRef))
    throw new Error(
      "A submission report takes no --build or --platform-ref (a submission is per release).",
    );
  const since = epochFlag(opts.since);
  const platformRef = jsonObjectFlag("platform-ref", opts.platformRef);
  const detail = jsonObjectFlag("detail", opts.detail);
  return {
    type: opts.type,
    outlet: opts.outlet,
    ...(opts.releaseId ? { releaseId: opts.releaseId } : {}),
    ...(opts.version ? { version: opts.version } : {}),
    ...(opts.deliverable ? { deliverable: opts.deliverable } : {}),
    ...(opts.buildId ? { buildId: opts.buildId } : {}),
    state: opts.state,
    ...(since !== undefined ? { since } : {}),
    ...(platformRef !== undefined ? { platformRef } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}

export interface ReportResult {
  body: Record<string, unknown>;
  /** False only for a key report the inventory does not hold (flagged by the Worker). */
  ok: boolean;
}

/** `pkey distribution report <type>`. */
export async function reportDistribution(
  opts: ReportOptions,
): Promise<ReportResult> {
  const payload = reportBody(opts);
  const client = await clientFor(opts);
  const what =
    opts.type === "key"
      ? `Reporting the ${String(payload.purpose)} key`
      : `Reporting ${opts.type} on ${opts.outlet}`;
  const body = await client.postJson("distribution/report", {
    what,
    body: payload,
  });

  if (opts.type === "key") {
    const key = (body.key ?? {}) as Record<string, unknown>;
    if (key.match === true) {
      opts.stdout.write(
        `The ${String(key.purpose)} key ${String(key.sha256)} is in the key inventory.\n`,
      );
      return { body, ok: true };
    }
    opts.stderr.write(
      `The ${String(key.purpose)} key ${String(key.sha256)} is NOT in the product's key inventory. ` +
        "Polaris Key flagged it for an operator; the inventory is unchanged. If the key was " +
        "rotated on purpose, an operator adopts it in the console (Distribution → Keys).\n",
    );
    return { body, ok: false };
  }

  const rec = (body[opts.type] ?? {}) as Record<string, unknown>;
  const target = `${String(rec.releaseId)}${rec.buildId ? `/${String(rec.buildId)}` : ""}`;
  opts.stdout.write(
    `Reported ${opts.type} of ${target} on ${String(rec.outletId)}: ${String(rec.state)}\n`,
  );
  return { body, ok: true };
}

export interface RolloutOptions extends DistributionCommandOptions {
  command: RolloutCommand;
  outlet: string;
  channel: string;
  releaseId?: string;
  deliverable?: string;
  bp?: string;
}

/** `pkey distribution rollout|pause|resume|halt|complete` over P2b-04's CI rollout routes. */
export async function driveRollout(
  opts: RolloutOptions,
): Promise<Record<string, unknown>> {
  if (!opts.outlet || !opts.channel)
    throw new Error(
      `--outlet and --channel are required.\n${DISTRIBUTION_CI_USAGE}`,
    );
  let bp: number | undefined;
  if (opts.command === "rollout") {
    if (!opts.releaseId || opts.bp === undefined)
      throw new Error(
        `pkey distribution rollout needs --release and --bp.\n${DISTRIBUTION_CI_USAGE}`,
      );
    bp = Number(opts.bp);
    if (!Number.isInteger(bp) || bp < 0 || bp > 10000)
      throw new Error(
        `--bp must be an integer from 0 to 10000 (basis points; 2500 = 25%), got ${opts.bp}.`,
      );
  }
  const client = await clientFor(opts);
  const base = `distribution/rollouts/${encodeURIComponent(opts.outlet)}/${encodeURIComponent(opts.channel)}`;
  const path = opts.command === "rollout" ? base : `${base}/${opts.command}`;
  const body = await client.postJson(path, {
    what:
      opts.command === "rollout"
        ? `Rolling out ${opts.releaseId} on ${opts.outlet}/${opts.channel}`
        : `${opts.command[0]!.toUpperCase()}${opts.command.slice(1)} on ${opts.outlet}/${opts.channel}`,
    body: {
      ...(opts.releaseId ? { releaseId: opts.releaseId } : {}),
      ...(opts.deliverable ? { deliverable: opts.deliverable } : {}),
      ...(bp !== undefined ? { bp } : {}),
    },
  });
  const r = (body.rollout ?? {}) as Record<string, unknown>;
  opts.stdout.write(
    `${String(r.deliverableId)} ${String(r.releaseId)} on ${String(r.outletId)}/${String(r.channel)}: ` +
      `${String(r.state)} at ${Number(r.rolloutBp) / 100}%\n`,
  );
  if (opts.command === "halt")
    opts.stderr.write(
      "Note: until the signed feed carries halts, legacy feeds keep serving; yank or pin to stop downloads now.\n",
    );
  return body;
}
