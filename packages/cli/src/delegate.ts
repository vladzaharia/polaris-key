/**
 * Content-key delegation in CI (P4-19; plans/P4-19.md §2.2–§2.6, §6.4).
 *
 * A product's release key can delegate a CONTENT key that may sign pack release records only for
 * the data-only pack types (`DELEGABLE_PACK_TYPES`) and only under a pack-id scope, inside a
 * signing window. The grant is a `pkey-release+jws` record with `kind: "delegation"`, signed in CI
 * by the release key; the Worker cannot forge or widen one.
 *
 *   - `generateContentKey`: `pkey release keys generate --content --out <file>` makes an Ed25519
 *     key pair, writes the private half (PKCS#8 PEM, mode 0600, never over an existing file) and
 *     prints the public key. A content key has no declared kid: its kid is `pkd1-<delegation
 *     hash>`, derived from the delegation that names it.
 *   - `delegateContentKey`: `pkey release delegate --prefix <packId> --types <t,…> --public-key
 *     <b64url> [--expires-in <days>] [--notes <text>] [--dry-run]`. It asks Polaris Key for the
 *     scope's delegations (`POST …/release/publish/delegations`), refuses a key any delegation
 *     already names (whatever its origin or revocation: one key, one delegation) or a declared
 *     release key, takes `seq` from `nextSeq`, signs with `PKEY_RELEASE_KEY`, self-checks with
 *     `releaseRecordClaims` and `verifyDelegation`, and submits `{record}`. A submit that fails
 *     after signing keeps the signed delegation in `./pkey-delegation-<sha256>.jws` (public
 *     material only), so it can still be revoked (`pkey release revoke --delegation <file>`).
 *   - `contentSigner`: the content-key half of `pkey release publish --deliverable <packId>`
 *     (`packPublish.ts`): the delegation fetched by hash from the record route and verified
 *     against the manifest's declared release keys, the scope, type, binding and window checks,
 *     the data-only rule over every file, and signing under the derived kid.
 *
 * No private key is ever sent, logged or written anywhere but the file `--out` names.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { signJws, verifyJws } from "@polaris-key/jws";
import {
  MAX_DELEGATION_TTL_SECONDS,
  MAX_DELEGATION_TYPES,
  SECONDS_PER_DAY,
} from "@polaris-key/protocol/core";
import {
  DELEGABLE_PACK_TYPES,
  PACK_TYPE_PATTERN,
} from "@polaris-key/protocol/packs";
import type {
  DelegationRecordDoc,
  ReleaseRecordDoc,
} from "@polaris-key/protocol/release";
import {
  coversPack,
  delegatedKid,
  delegationOf,
  isPackId,
  releaseRecordClaims,
  verifyDelegation,
  verifyReleaseRecord,
  type VerifiedDelegation,
} from "@polaris-key/client-core/record";
import { dataOnlyFileRefusal } from "@polaris-key/client-core/packs";
import {
  canonicalDescriptorJson,
  type ManifestPackDeliverable,
  type ManifestReleaseKey,
} from "@polaris-key/manifest";
import {
  ciClient,
  CiRequestError,
  type CiClient,
  type Out,
  type Sleep,
} from "./ci.js";
import { loadManifest, validateLoadedManifest } from "./manifest.js";
import { resolveCiToken, type CiEnv } from "./oidc.js";
import { packContext } from "./packManifest.js";
import { provenanceFrom } from "./publish.js";
import {
  fingerprintOf,
  publicKeyOfPem,
  recordSigner,
  RELEASE_KEY_ENV,
} from "./releaseKeys.js";

/** The CI environment variable holding a content key's PKCS#8 PEM. */
export const CONTENT_KEY_ENV = "PKEY_CONTENT_KEY";

export const CONTENT_KEYS_USAGE =
  "Usage: pkey release keys generate --content --out <file>";

export const DELEGATE_USAGE =
  "Usage: pkey release delegate --product <slug> --prefix <packId> --types <type,…> " +
  "--public-key <base64url> [--expires-in <days>] [--notes <text>] " +
  "[--release-key-file pem] [--base-url <url>] [--dry-run]";

/** The default signing window, in days (plans/P4-19.md §6.4). */
export const DEFAULT_DELEGATION_DAYS = 180;
/** The longest window, in days: `MAX_DELEGATION_TTL_SECONDS` / one day (366). */
export const MAX_DELEGATION_DAYS = MAX_DELEGATION_TTL_SECONDS / SECONDS_PER_DAY;
/** A content-key publish warns when its delegation's window closes within this many days. */
export const WINDOW_WARN_DAYS = 14;

/** 32 raw bytes in strict base64url: 43 characters, no padding, zero trailing bits. */
const KEY_B64URL_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const sha256Hex = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

const iso = (t: number): string => new Date(t * 1000).toISOString();

// ── keys generate --content ──────────────────────────────────────────────────

export interface GeneratedContentKey {
  publicKey: string;
  fingerprint: string;
  out: string;
}

/** `pkey release keys generate --content`: a new Ed25519 content key, its private half at `out`. */
export async function generateContentKey(opts: {
  out: string;
}): Promise<GeneratedContentKey> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const raw = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  try {
    await writeFile(opts.out, pem, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `${opts.out} exists; a content key is never written over an existing file. Choose another --out.`,
      );
    throw e;
  }
  return { publicKey: raw, fingerprint: fingerprintOf(raw), out: opts.out };
}

/** What to print after generating a content key. */
export function generatedContentKeyText(g: GeneratedContentKey): string {
  return (
    `Wrote the private content key to ${g.out} (mode 0600). Store it as the GitHub Environment\n` +
    `secret ${CONTENT_KEY_ENV} of the content team's publishing environment, then delete the file.\n` +
    `Never commit it. It has no kid of its own (pkd1-<delegation sha256> is derived); delegate it\n` +
    `with the release key first:\n\n` +
    `  pkey release delegate --prefix <packId> --types <type,…> --public-key ${g.publicKey}\n\n` +
    `Public key: ${g.publicKey}\n` +
    `Fingerprint (sha256 of the raw key): ${g.fingerprint}\n`
  );
}

// ── Discovery and the delegations read route ────────────────────────────────

/** Discovery must advertise `release.delegations` (plans/P4-19.md §6.3 "Discovery"). */
export async function requireDelegationsDiscovery(
  client: CiClient,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = client.url(".well-known/polaris.json");
  let body: { services?: { release?: { delegations?: unknown } } } = {};
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
    });
    if (res.ok) body = (await res.json()) as typeof body;
  } catch {
    // An unreachable discovery document reads as "no delegations".
  }
  if (body.services?.release?.delegations !== true)
    throw new Error(
      `${url} does not advertise release.delegations: this Polaris Key does not ingest content-key delegations yet (it predates P4-19). Nothing was signed or submitted.`,
    );
}

/** One entry of `POST …/release/publish/delegations`'s answer (plans/P4-19.md §6.3). */
export interface ListedDelegation {
  sha256: string;
  deliverable: string;
  seq: number;
  keyFingerprint: string;
  issuedAt: number;
  expiresAt: number;
  origin: "submit" | "revocation";
  revoked: boolean;
}

export async function listDelegations(
  client: CiClient,
  deliverable?: string,
): Promise<{ delegations: ListedDelegation[]; nextSeq?: number }> {
  const answer = await client.postJson<{
    delegations?: unknown;
    nextSeq?: unknown;
  }>("release/publish/delegations", {
    what: "Listing the product's delegations",
    body: deliverable !== undefined ? { deliverable } : {},
  });
  if (!Array.isArray(answer.delegations))
    throw new Error(
      `${client.url("release/publish/delegations")} answered without a delegations list.`,
    );
  const nextSeq =
    typeof answer.nextSeq === "number" &&
    Number.isSafeInteger(answer.nextSeq) &&
    answer.nextSeq >= 1
      ? answer.nextSeq
      : undefined;
  return {
    delegations: answer.delegations as ListedDelegation[],
    ...(nextSeq !== undefined ? { nextSeq } : {}),
  };
}

/** A record by hash from the record route (no credential: access rule (1) governs it). */
export async function fetchRecordByHash(
  client: CiClient,
  sha256: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const url = client.url(`release/records/${sha256}`);
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/jose" } });
  } catch (e) {
    throw new Error(`Fetching ${url}: ${(e as Error).message}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetching ${url} answered ${res.status}.`);
  return (await res.text()).trim();
}

const trustOf = (declared: readonly ManifestReleaseKey[]) => {
  const trust: Record<string, string> = {};
  for (const k of declared) trust[k.kid] = k.publicKey;
  return trust;
};

/** Verify a delegation against the manifest's declared release keys (never a product key). */
export async function checkDelegation(
  jws: string,
  sha256: string,
  product: string,
  declared: readonly ManifestReleaseKey[],
): Promise<VerifiedDelegation> {
  const v = await verifyDelegation(jws, {
    releaseKeys: trustOf(declared),
    productTrust: {},
    expectedAud: product,
    expectedHash: sha256,
  });
  if (!v.ok)
    throw new Error(
      `The delegation ${sha256.slice(0, 12)}… does not verify against .pkey/release's releaseKeys (step ${v.step}); nothing was signed.`,
    );
  return v.delegation;
}

/** The delegation record's own `version` (display), read from its payload. */
export function delegationVersion(jws: string): string {
  const payload = JSON.parse(
    Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as { version?: unknown };
  if (typeof payload.version !== "string")
    throw new Error("The delegation names no version.");
  return payload.version;
}

// ── pkey release delegate ────────────────────────────────────────────────────

export interface DelegateOptions {
  cwd: string;
  product: string;
  prefix: string;
  /** Comma-separated, or already split. */
  types: string | readonly string[];
  publicKey: string;
  expiresInDays?: number;
  notes?: string;
  dryRun?: boolean;
  releaseKeyPem?: string;
  /** Epoch seconds (tests); defaults to now. */
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

export interface DelegateResult {
  record: DelegationRecordDoc;
  jws: string | null;
  sha256: string | null;
  kid: string | null;
  server: Record<string, unknown> | null;
  /** Where a signed delegation was kept after a failed submit. */
  savedTo?: string;
}

/** `--types`: 1–`MAX_DELEGATION_TYPES` unique pack types, every one delegable. */
export function parseDelegationTypes(
  types: string | readonly string[],
): string[] {
  const list = (
    typeof types === "string" ? types.split(/[\s,]+/) : [...types]
  ).filter(Boolean);
  if (list.length < 1 || list.length > MAX_DELEGATION_TYPES)
    throw new Error(
      `--types lists 1–${MAX_DELEGATION_TYPES} pack types (got ${list.length}).`,
    );
  if (new Set(list).size !== list.length)
    throw new Error("--types lists a type twice.");
  for (const t of list) {
    if (!PACK_TYPE_PATTERN.test(t))
      throw new Error(`--types: ${JSON.stringify(t)} is not a pack type.`);
    if (!(DELEGABLE_PACK_TYPES as readonly string[]).includes(t))
      throw new Error(
        `--types: ${t} can never be delegated; a content key signs only ${DELEGABLE_PACK_TYPES.join(", ")} (godot.pck, godot.zip, audio.bank, ml.model and custom types can load code).`,
      );
  }
  return list;
}

/** Write a signed delegation beside the run, never over an existing file. */
async function keepSignedDelegation(
  cwd: string,
  jws: string,
  sha256: string,
): Promise<string> {
  const file = path.join(cwd, `pkey-delegation-${sha256}.jws`);
  await writeFile(file, `${jws}\n`, { mode: 0o600, flag: "wx" });
  return file;
}

export async function delegateContentKey(
  opts: DelegateOptions,
): Promise<DelegateResult> {
  const out = opts.stdout;
  if (!isPackId(opts.prefix))
    throw new Error(
      `--prefix must be a pack id (the scope root, never app; got ${JSON.stringify(opts.prefix)}).\n${DELEGATE_USAGE}`,
    );
  const types = parseDelegationTypes(opts.types);
  if (!KEY_B64URL_RE.test(opts.publicKey))
    throw new Error(
      "--public-key must be base64url of 32 raw Ed25519 bytes (as pkey release keys generate --content prints it).",
    );
  const days = opts.expiresInDays ?? DEFAULT_DELEGATION_DAYS;
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DELEGATION_DAYS)
    throw new Error(
      `--expires-in must be a whole number of days from 1 to ${MAX_DELEGATION_DAYS} (got ${String(opts.expiresInDays)}).`,
    );

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
  const fingerprint = fingerprintOf(opts.publicKey);
  if (ctx.releaseKeys.some((k) => k.publicKey === opts.publicKey))
    throw new Error(
      "--public-key is a declared release key; a content key is a separate key (pkey release keys generate --content).",
    );

  // The signer first: nothing reaches the network without the release key (a dry run signs nothing).
  let sign: ((record: ReleaseRecordDoc) => Promise<string>) | null = null;
  if (!opts.dryRun) {
    const pem = opts.releaseKeyPem ?? opts.env[RELEASE_KEY_ENV] ?? undefined;
    sign = opts.signRecord ?? (pem ? recordSigner(pem, ctx.releaseKeys) : null);
    if (!sign)
      throw new Error(
        `A delegation is a signed release record: set ${RELEASE_KEY_ENV} (the release key) or --release-key-file.`,
      );
  }

  let client: CiClient | null = null;
  try {
    const token = await resolveCiToken({
      baseUrl: opts.baseUrl,
      product: opts.product,
      env: opts.env,
      out,
      log: opts.stderr,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
    });
    client = ciClient({
      baseUrl: opts.baseUrl,
      product: opts.product,
      token,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      log: opts.stderr,
    });
  } catch (e) {
    if (!opts.dryRun || e instanceof CiRequestError) throw e;
    out.write(`Server checks: skipped (${(e as Error).message})\n`);
  }

  let seq = 1;
  if (client) {
    await requireDelegationsDiscovery(client, opts.fetchImpl);
    const listed = await listDelegations(client, opts.prefix);
    const reused = listed.delegations.find(
      (d) => d.keyFingerprint === fingerprint,
    );
    if (reused)
      throw new Error(
        `The key ${fingerprint.slice(0, 12)}… is already named by delegation ${reused.sha256.slice(0, 12)}… (${reused.deliverable}, seq ${reused.seq}${reused.revoked ? ", revoked" : ""}): one content key, one delegation. Generate a new key to rotate.`,
      );
    if (listed.nextSeq === undefined)
      throw new Error(
        `${client.url("release/publish/delegations")} answered no nextSeq for ${opts.prefix}.`,
      );
    seq = listed.nextSeq;
  }

  const issuedAt = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  const provenance = provenanceFrom(opts.env);
  const record: DelegationRecordDoc = {
    schemaVersion: 1,
    aud: opts.product,
    deliverable: opts.prefix,
    kind: "delegation",
    version: String(seq),
    seq,
    issuedAt,
    expiresAt: issuedAt + days * SECONDS_PER_DAY,
    delegate: { publicKey: opts.publicKey },
    types,
    ...(opts.notes?.trim() ? { notes: opts.notes.trim() } : {}),
    ...(provenance ? { provenance } : {}),
  };
  if (
    !releaseRecordClaims(record, { expectedAud: opts.product }) ||
    delegationOf(record) === null
  )
    throw new Error(
      "Self-check: the delegation fails the record claims or the delegation body (plans/P4-19.md §2.2); nothing was signed.",
    );
  const summary =
    `Delegation of ${opts.prefix} (seq ${seq}) for ${types.join(", ")} to key ${fingerprint.slice(0, 12)}…\n` +
    `Window: ${iso(record.issuedAt)} to ${iso(record.expiresAt)} (${days} days)\n`;
  out.write(summary);

  if (opts.dryRun) {
    out.write(
      `Checks: the key is no declared release key${client ? " and no delegation names it" : ""}; ` +
        `the types are delegable; the window is at most ${MAX_DELEGATION_DAYS} days.\n` +
        `\nDelegation record (unsigned; a dry run signs nothing):\n${JSON.stringify(record, null, 2)}\n` +
        "Dry run: nothing signed or submitted.\n",
    );
    return { record, jws: null, sha256: null, kid: null, server: null };
  }

  const jws = await sign!(record as unknown as ReleaseRecordDoc);
  const sha256 = sha256Hex(jws);
  if (!opts.signRecord) {
    const v = await verifyJws(jws, trustOf(ctx.releaseKeys), {
      typ: "pkey-release+jws",
    });
    if (
      !v ||
      canonicalDescriptorJson(v.payload) !== canonicalDescriptorJson(record)
    )
      throw new Error(
        "The signed delegation is not the record pkey built; nothing was submitted.",
      );
    await checkDelegation(jws, sha256, opts.product, ctx.releaseKeys);
  }
  const kid = delegatedKid(sha256);
  out.write(
    `Signed the delegation record (sha256 ${sha256})\nContent kid: ${kid}\n`,
  );
  let server: Record<string, unknown>;
  try {
    server = await client!.postJson<Record<string, unknown>>(
      "release/publish/submit",
      { what: "Submitting the delegation record", body: { record: jws } },
    );
  } catch (e) {
    let saved: string | null = null;
    try {
      saved = await keepSignedDelegation(opts.cwd, jws, sha256);
    } catch {
      saved = null;
    }
    throw new Error(
      `${(e as Error).message}\n` +
        (saved
          ? `The signed delegation was kept at ${saved} (public material only). Revoke it with pkey release revoke --delegation ${path.relative(opts.cwd, saved)} --reason <text> if it may have leaked, or retry.`
          : `The signed delegation could not be kept beside the run; its sha256 is ${sha256}.`),
    );
  }
  out.write(
    `Delegated ${opts.prefix} to ${kid} (${String(server.outcome ?? "submitted")})\n`,
  );
  return { record, jws, sha256, kid, server };
}

// ── The content-key half of a pack publish ──────────────────────────────────

export interface ContentKeyInput {
  pem: string;
  /** The delegation's record hash. */
  delegation: string;
}

/** Resolve the content key from `--content-key-file` or `PKEY_CONTENT_KEY`. */
export async function contentKeyPemFrom(
  cwd: string,
  file: string | undefined,
): Promise<string | undefined> {
  return file ? readFile(path.resolve(cwd, file), "utf8") : undefined;
}

/** Checks that need no network: the type, the layout, the binding and the data-only rule. */
export function localDelegatedChecks(
  pack: ManifestPackDeliverable,
  files: readonly { variant: string; path: string; data: Uint8Array }[],
): void {
  if (!(DELEGABLE_PACK_TYPES as readonly string[]).includes(pack.type))
    throw new Error(
      `${pack.id} is a ${pack.type} pack: a content key signs only ${DELEGABLE_PACK_TYPES.join(", ")}; publish it with the release key.`,
    );
  if (pack.binding !== "compatible" && pack.binding !== "standalone")
    throw new Error(
      `${pack.id}'s binding is ${pack.binding}: a content key publishes only compatible or standalone packs (a pinned release is the release key vouching for exact bytes).`,
    );
  const refused: string[] = [];
  for (const f of files) {
    const rule = dataOnlyFileRefusal(f.path, f.data);
    if (rule !== null)
      refused.push(
        `${f.variant}/${f.path}: ${rule === "extension" ? "its extension is not data-only (allowed: json, csv, tsv, po, txt, png, jpg, jpeg, webp, ogg, wav, mp3, ttf, otf)" : "its content carries a Godot resource, pack, script, archive or native-binary magic (if it is compressed media, re-encode it)"}`,
      );
  }
  if (refused.length)
    throw new Error(
      `The data-only rule refused ${refused.length} file${refused.length === 1 ? "" : "s"} (plans/P4-19.md §2.5); nothing was published:\n${refused.map((r) => `  ${r}`).join("\n")}`,
    );
}

export interface ContentSigner {
  delegation: VerifiedDelegation;
  delegationJws: string;
  kid: string;
  /** Sign a pack record under the derived kid. */
  sign(record: ReleaseRecordDoc): Promise<string>;
  /** Verify the signed record as a device would, through the delegation. */
  check(jws: string, record: ReleaseRecordDoc): Promise<void>;
}

/**
 * Fetch and verify the delegation, check the content key is its delegated key and the pack is in
 * its scope, types and window at `now`, then hand back the signer (plans/P4-19.md §6.4).
 */
export async function contentSigner(o: {
  client: CiClient;
  fetchImpl?: typeof fetch;
  product: string;
  pack: ManifestPackDeliverable;
  declared: readonly ManifestReleaseKey[];
  key: ContentKeyInput;
  now: number;
  warn: (w: string) => void;
}): Promise<ContentSigner> {
  if (!SHA256_RE.test(o.key.delegation))
    throw new Error(
      "--delegation must be the delegation record's sha256 (64 lowercase hex), as pkey release delegate prints it.",
    );
  const publicKey = publicKeyOfPem(o.key.pem).trim();
  await requireDelegationsDiscovery(o.client, o.fetchImpl);
  const jws = await fetchRecordByHash(o.client, o.key.delegation, o.fetchImpl);
  if (jws === null)
    throw new Error(
      `Polaris Key stores no record ${o.key.delegation.slice(0, 12)}…: delegate the key first (pkey release delegate).`,
    );
  const d = await checkDelegation(jws, o.key.delegation, o.product, o.declared);
  if (d.publicKey !== publicKey)
    throw new Error(
      `The content key (${fingerprintOf(publicKey).slice(0, 12)}…) is not the key delegation ${o.key.delegation.slice(0, 12)}… names (${fingerprintOf(d.publicKey).slice(0, 12)}…).`,
    );
  if (!coversPack(d.deliverable, o.pack.id))
    throw new Error(
      `${o.pack.id} is outside the delegation's scope ${d.deliverable} (whole segments).`,
    );
  if (!d.types.includes(o.pack.type))
    throw new Error(
      `The delegation covers ${d.types.join(", ")}, not ${o.pack.type}.`,
    );
  if (o.now < d.issuedAt || o.now > d.expiresAt)
    throw new Error(
      `The delegation's window (${iso(d.issuedAt)} to ${iso(d.expiresAt)}) does not hold now (${iso(o.now)}); renew it with a new key and delegation.`,
    );
  if (d.expiresAt - o.now < WINDOW_WARN_DAYS * SECONDS_PER_DAY)
    o.warn(
      `the delegation's window closes ${iso(d.expiresAt)}, within ${WINDOW_WARN_DAYS} days: rotate the content key (a new key and delegation) before then.`,
    );
  const kid = delegatedKid(o.key.delegation);
  const trust = trustOf(o.declared);
  return {
    delegation: d,
    delegationJws: jws,
    kid,
    sign: (record) => signJws(record, o.key.pem, kid, "pkey-release+jws"),
    async check(signed, record) {
      const r = record as unknown as {
        deliverable: string;
        version: string;
        seq: number;
      };
      const v = await verifyReleaseRecord(signed, {
        releaseKeys: trust,
        productTrust: {},
        expectedAud: o.product,
        expectedHash: sha256Hex(signed),
        pin: {
          kind: "pack",
          deliverable: r.deliverable,
          version: r.version,
          seq: r.seq,
        },
        delegation: jws,
      });
      if (!v.ok || v.delegation === null)
        throw new Error(
          `The content-key-signed pack record does not verify through its delegation${v.ok ? "" : ` (step ${v.step})`}; nothing was published.`,
        );
      if (canonicalDescriptorJson(v.record) !== canonicalDescriptorJson(record))
        throw new Error(
          "The signed pack record is not the record pkey built; nothing was published.",
        );
    },
  };
}
