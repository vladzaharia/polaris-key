/**
 * `pkey release revoke <packId>@<version> [--replacement <version>] --reason <text> [--dry-run]`
 * (P4-13; plans/P4-13.md §2.3, §6.5, decisions 3, 5 and 18).
 *
 * A revocation is a `pkey-release+jws` record with `kind: "revocation"`, signed in CI by the same
 * release key `pkey release publish` uses (`PKEY_RELEASE_KEY`): the Worker cannot sign one, so it
 * can withhold content but never condemn or substitute it. The record names exactly what it
 * revokes: `deliverable`, `version` and `seq` are the TARGET's, `revokes` is the target record's
 * hash, and the optional `replacement` is a stored release of the same pack. Both records are
 * resolved through the uploads preflight (`seqs[].recordSha256`), as `--pin` is.
 *
 * Revocations are permanent. Running `revoke` again for the same target with a different
 * `--replacement` (or reason) signs a newer revocation that supersedes the earlier one (the newest
 * `issuedAt` wins on the Worker and on devices); there is no un-revoke.
 *
 * The CLI self-checks the signed record with `releaseRecordClaims` and `revocationOf` before it
 * submits it on `POST /<p>/release/publish/submit` as `{record}` (no ticket, no descriptor). It
 * refuses against a Worker whose discovery does not advertise `release.revocations`.
 */

import { verifyJws } from "@polaris-key/jws";
import { REVOCATION_REASON_MAX_BYTES } from "@polaris-key/protocol/core";
import type {
  ReleaseRecordDoc,
  RevocationRecordDoc,
} from "@polaris-key/protocol/release";
import {
  releaseRecordClaims,
  revocationOf,
} from "@polaris-key/client-core/record";
import { ciClient, type CiClient, type Out, type Sleep } from "./ci.js";
import { parsePinFlag, resolvePins } from "./contentStamp.js";
import { loadManifest, validateLoadedManifest } from "./manifest.js";
import { resolveCiToken, type CiEnv } from "./oidc.js";
import { packContext } from "./packManifest.js";
import { sha256Hex } from "./packArtifacts.js";
import { RELEASE_KEY_ENV, recordSigner } from "./releaseKeys.js";

export const REVOKE_USAGE =
  "Usage: pkey release revoke <packId>@<version> --reason <text> --product <slug> " +
  "[--replacement <version>] [--release-key-file pem] [--base-url <url>] [--dry-run]";

export interface RevokeOptions {
  cwd: string;
  product: string;
  /** `<packId>@<version>`: the pack release to revoke. */
  target: string;
  /** The replacement's version (same pack). */
  replacement?: string;
  reason: string;
  dryRun?: boolean;
  releaseKeyPem?: string;
  /** Epoch seconds for `issuedAt` (tests); defaults to now. */
  now?: () => number;
  /** A signer seam (tests); defaults to `recordSigner` over the release key. */
  signRecord?: (record: ReleaseRecordDoc) => Promise<string>;
  baseUrl?: string;
  env: CiEnv;
  stdout: Out;
  stderr: Out;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
}

export interface RevokeResult {
  record: RevocationRecordDoc;
  jws: string;
  sha256: string;
  server: Record<string, unknown> | null;
}

/** Discovery must advertise `release.revocations` (plans/P4-13.md §6.3 "Discovery"). */
export async function requireRevocationsDiscovery(
  client: CiClient,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = client.url(".well-known/polaris.json");
  let body: { services?: { release?: { revocations?: unknown } } } = {};
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
    });
    if (res.ok) body = (await res.json()) as typeof body;
  } catch {
    // An unreachable discovery document reads as "no revocations".
  }
  if (body.services?.release?.revocations !== true)
    throw new Error(
      `${url} does not advertise release.revocations: this Polaris Key does not ingest revocation records yet (it predates P4-13). Nothing was signed or submitted.`,
    );
}

/** The reason: a string of 1–`REVOCATION_REASON_MAX_BYTES` UTF-8 bytes (display only). */
export function checkReason(reason: string): void {
  const bytes = new TextEncoder().encode(reason).byteLength;
  if (bytes < 1 || bytes > REVOCATION_REASON_MAX_BYTES)
    throw new Error(
      `--reason must be 1–${REVOCATION_REASON_MAX_BYTES} bytes (got ${bytes}).`,
    );
}

/** Build the unsigned revocation body (plans/P4-13.md §2.3). */
export function revocationRecord(o: {
  product: string;
  pack: string;
  target: { sha256: string; seq: number; version: string };
  replacement?: { sha256: string; seq: number; version: string };
  reason: string;
  issuedAt: number;
}): RevocationRecordDoc {
  if (o.replacement && o.replacement.sha256 === o.target.sha256)
    throw new Error(
      "--replacement names the revoked release itself; a replacement is another release.",
    );
  return {
    schemaVersion: 1,
    aud: o.product,
    deliverable: o.pack,
    kind: "revocation",
    version: o.target.version,
    seq: o.target.seq,
    issuedAt: o.issuedAt,
    revokes: o.target.sha256,
    ...(o.replacement
      ? {
          replacement: {
            sha256: o.replacement.sha256,
            seq: o.replacement.seq,
            version: o.replacement.version,
          },
        }
      : {}),
    reason: o.reason,
  };
}

/** The CLI's own check: the JWS verifies under a declared release key, passes the record claims
 *  and `revocationOf`, and is the record that was meant to be signed. */
async function checkSignedRevocation(
  jws: string,
  record: RevocationRecordDoc,
  trust: Record<string, string>,
): Promise<void> {
  const v = await verifyJws(jws, trust, { typ: "pkey-release+jws" });
  if (!v)
    throw new Error(
      "The signed revocation does not verify against .pkey/release's releaseKeys; nothing was submitted.",
    );
  if (
    !releaseRecordClaims(v.payload, {
      expectedAud: record.aud,
      nonWire: v.nonWireIntegers,
    })
  )
    throw new Error(
      "The revocation fails the v4 record claims (WIRE-CONTRACT-V4 §2.4); nothing was submitted.",
    );
  const body = revocationOf(v.payload, v.nonWireIntegers);
  if (
    body === null ||
    body.target !== record.revokes ||
    JSON.stringify(v.payload) !== JSON.stringify(record)
  )
    throw new Error(
      "The signed revocation is not a usable revocation body (plans/P4-13.md §2.3); nothing was submitted.",
    );
}

export async function revokePackRelease(
  opts: RevokeOptions,
): Promise<RevokeResult> {
  const out = opts.stdout;
  const { pack, version } = parsePinFlag(opts.target, "revoke");
  if (opts.replacement !== undefined)
    parsePinFlag(`${pack}@${opts.replacement}`, "--replacement");
  if (opts.replacement === version)
    throw new Error(
      "--replacement names the revoked release itself; a replacement is another release.",
    );
  checkReason(opts.reason);

  const loaded = await loadManifest(opts.cwd);
  const validation = validateLoadedManifest(loaded);
  if (!validation.ok)
    throw new Error(
      `.pkey/ is invalid; run pkey validate:\n${validation.errors
        .map((e) => `  ${e.file}${e.path}: ${e.message}`)
        .join("\n")}`,
    );
  const ctx = packContext(loaded);
  if (ctx.slug !== opts.product)
    throw new Error(
      `--product ${opts.product} does not match .pkey/product's slug ${ctx.slug}.`,
    );
  if (!ctx.packs.some((p) => p.id === pack))
    throw new Error(
      `${pack} is not a pack .pkey/release declares; only a pack release can be revoked (an app build is retired by License's compatibility window).`,
    );

  // The signer first: nothing reaches the network without the release key (a dry run signs too,
  // so it can print the exact record and hash).
  const pem = opts.releaseKeyPem ?? opts.env[RELEASE_KEY_ENV] ?? undefined;
  const sign =
    opts.signRecord ?? (pem ? recordSigner(pem, ctx.releaseKeys) : null);
  if (!sign)
    throw new Error(
      `A revocation is a signed release record: set ${RELEASE_KEY_ENV} (the release key pkey release publish uses) or --release-key-file.`,
    );

  const token = await resolveCiToken({
    baseUrl: opts.baseUrl,
    product: opts.product,
    env: opts.env,
    out,
    log: opts.stderr,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
  });
  const client = ciClient({
    baseUrl: opts.baseUrl,
    product: opts.product,
    token,
    fetchImpl: opts.fetchImpl,
    sleep: opts.sleep,
    log: opts.stderr,
  });
  await requireRevocationsDiscovery(client, opts.fetchImpl);

  const flags = [`${pack}@${version}`];
  if (opts.replacement !== undefined) flags.push(`${pack}@${opts.replacement}`);
  const [target, replacement] = await resolvePins(client, flags, "revoke");
  const record = revocationRecord({
    product: opts.product,
    pack,
    target: target!.release,
    ...(replacement ? { replacement: replacement.release } : {}),
    reason: opts.reason,
    issuedAt: opts.now ? opts.now() : Math.floor(Date.now() / 1000),
  });

  const jws = await sign(record as unknown as ReleaseRecordDoc);
  const trust: Record<string, string> = {};
  for (const k of ctx.releaseKeys) trust[k.kid] = k.publicKey;
  if (!opts.signRecord) await checkSignedRevocation(jws, record, trust);
  const sha256 = sha256Hex(jws);
  out.write(
    `Revocation of ${pack}@${version} (seq ${record.seq}, record ${record.revokes.slice(0, 12)}…)` +
      `${record.replacement ? `, replacement ${record.replacement.version} (seq ${record.replacement.seq})` : ", no replacement"}\n` +
      `Signed the revocation record (sha256 ${sha256})\n`,
  );
  if (opts.dryRun) {
    out.write(
      `\nRevocation record:\n${JSON.stringify(record, null, 2)}\n${jws}\n`,
    );
    out.write("Dry run: nothing submitted.\n");
    return { record, jws, sha256, server: null };
  }
  const server = await client.postJson<Record<string, unknown>>(
    "release/publish/submit",
    { what: "Submitting the revocation record", body: { record: jws } },
  );
  out.write(
    `Revoked ${pack}@${version} (${String(server.outcome ?? "submitted")})\n`,
  );
  return { record, jws, sha256, server };
}
