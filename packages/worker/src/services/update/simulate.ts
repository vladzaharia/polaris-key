/// <reference types="@cloudflare/workers-types" />

/**
 * "What does this device get?" (P4-15, CONTENT §6.6 last paragraph, §6.7 item 13, §6.9 console):
 * `GET /manage/api/products/<slug>/update/simulate?appRelease=&platform=&outlet=&variant=…`.
 *
 * THERE IS NO SECOND IMPLEMENTATION. The simulator runs the code a device and the feed route run:
 *
 *   1. the feed: `composeChannelFeed` and `documentFor` (P3-03, P4-12's stored sets, P4-13's
 *      floors, narrowing and revocations, P4-14's gates) build the document the feed route would
 *      sign for this channel and platform. It is signed with an EPHEMERAL Ed25519 key generated
 *      for this request (WebCrypto), never the product key: this module never reads the product's
 *      signing secret, so the console cannot be turned into a product-key signing oracle (it
 *      gets no `env`: only the `LAZY_DELTAS` switch string crosses, so the document lists P4-29's
 *      delta menu as the route's would, ranked as on the sign path). The
 *      simulated device trusts that ephemeral public key in place of the product key; the feed
 *      signature itself is therefore not under test here (the conformance corpus covers it). The
 *      product's PUBLIC keys stay in the device's trust set, so a release key equal to one is still
 *      refused as on a device (V4 §3.5 step 13). Then…
 *   2. the device: client-core's `runUpdateCheck` verifies it, fetches and verifies the target's
 *      record and every revocation and replacement by hash from Release's records (what the record
 *      route serves), computes the rollout buckets from the device id, and runs `decideUpdate`
 *      (P4-13 §2.6: pins, holds, floors, revocations, gates, `selectPackRows`) — exactly as an SDK
 *      does on a FRESH device: no cache, no stored revocations, its active set the build's embedded
 *      baselines (the record's pins for the packs the build `embeds`).
 *
 * The set a device runs after this check is its active set with the decision applied (`packs`:
 * the installs added and the revokes removed; any other answer leaves it as it is), and its
 * `packSetId` is client-core's over that set: the value an SDK reports, so support can compare a
 * device's reported (appRelease, packSetId) with `packSetId` here (`reported`).
 *
 * Around the decision, for the operator: each pack's declared and effective binding with the reason
 * (`effectivePackBindings`: a transport that cannot float pins it; the app record's pin or hold),
 * its feed target after the outlet's gates (client-core's `selectPackRows`), the floor that
 * applies, P4-12's `unsatisfied` markers for the selector, and the revocations that name it.
 *
 * P4-19 (delegated content keys) applies through `runUpdateCheck`: a delegated record is verified
 * with its delegation, and a delegation's revocation in the feed is applied with client-core's
 * `recordRevoked`, with no code here.
 *
 * Read-only: one ephemeral signature in memory, no write, no audit. Update reads Distribution only through
 * Core's `delivery` hook; the one service import is `update → release`.
 */

import { RELEASE_PLATFORMS } from "@polaris-key/manifest";
import {
  OUTLET_KINDS,
  type OutletKind,
} from "@polaris-key/protocol/distribution";
import {
  BINARY_METHODS,
  type BinaryMethod,
  type ChannelFeedDoc,
  type ReleasePin,
  type UpdateDecision,
} from "@polaris-key/protocol/update";
import type { AppContent } from "@polaris-key/protocol/packs";
import type { ReleaseRecordDoc } from "@polaris-key/protocol/release";
import { base64UrlDecode } from "@polaris-key/jws";
import { runUpdateCheck } from "@polaris-key/client-core/check";
import { rolloutBucket, selectPackRows } from "@polaris-key/client-core/decide";
import { holdsOf, packSetId } from "@polaris-key/client-core/packs";
import type { ServiceContext } from "../../core/registry.js";
import { signDoc } from "../../core/signing.js";
import { getReleaseConfig } from "../release/config.js";
import {
  getRecordByHash,
  productSigningKeyBytes,
  recordsByRelease,
  releaseKeyTrustSet,
} from "../release/records.js";
import { readPackDeliverables } from "../release/packs/deliverables.js";
import { readStoredSets } from "../release/packs/sets.js";
import { readAllRevocations } from "../release/packs/revocations.js";
import {
  canonicalFeedChannel,
  composeChannelFeed,
  effectivePackBindings,
} from "./compose.js";
import {
  documentFor,
  feedSelfCheck,
  startingFeedSeq,
  withRankedMenu,
} from "./feedDoc.js";
import { variantOfKey } from "./packParts.js";

/** A query that names no valid selector: the route's 400, with the field and why. */
export class SimulateInputError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "SimulateInputError";
  }
}

/** A selector naming something that does not exist (the route's 404). */
export class SimulateNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulateNotFound";
  }
}

export interface SimulateQuery {
  appRelease: string;
  platform: string;
  /** Outlet id, or null for a device that detected none (`unknown`). */
  outlet: string | null;
  /** Axis → preference list, best first. */
  axes: Record<string, string[]>;
  channel: string;
  /** The device id (`X-PKey-Device`): the rollout buckets' install id. Null: out of every
   *  client-evaluated rollout, as an SDK without one is. */
  device: string | null;
  methods: BinaryMethod[];
  /** A device's reported `packSetId`, compared with the simulated one. */
  packSetId: string | null;
}

const MAX_DEVICE_ID = 128;
const AXIS_RE = /^[a-z][a-z0-9-]{0,15}$/;
const VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,34}$/;

/** Parse and validate the query. Throws `SimulateInputError`. */
export function parseSimulateQuery(params: URLSearchParams): SimulateQuery {
  const appRelease = params.get("appRelease") ?? "";
  if (appRelease === "" || appRelease.length > 256)
    throw new SimulateInputError(
      "appRelease",
      "appRelease names an app release id",
    );
  const platform = params.get("platform") ?? "";
  if (!(RELEASE_PLATFORMS as readonly string[]).includes(platform))
    throw new SimulateInputError(
      "platform",
      `platform is one of ${RELEASE_PLATFORMS.join(", ")}`,
    );
  const rawOutlet = params.get("outlet");
  const outlet = rawOutlet === null || rawOutlet === "" ? null : rawOutlet;
  if (outlet !== null && outlet.length > 64)
    throw new SimulateInputError("outlet", "outlet names an outlet id");
  // `variant`: `axis=value;axis=value`, a value list (`a,b`) giving preferences in order.
  const axes: Record<string, string[]> = {};
  const rawVariant = params.get("variant") ?? "";
  if (rawVariant !== "") {
    for (const [axis, list] of Object.entries(variantOfKey(rawVariant))) {
      const values = list.split(",");
      if (!AXIS_RE.test(axis) || !values.every((v) => VALUE_RE.test(v)))
        throw new SimulateInputError(
          "variant",
          "variant is axis=value pairs separated by ';' (a value may be a ',' preference list)",
        );
      axes[axis] = values;
    }
    if (
      Object.keys(axes).length === 0 ||
      rawVariant.split(";").length !== Object.keys(axes).length
    )
      throw new SimulateInputError(
        "variant",
        "variant is axis=value pairs separated by ';' (a value may be a ',' preference list)",
      );
  }
  const channel = params.get("channel") || "stable";
  const rawDevice = params.get("device");
  const device = rawDevice === null || rawDevice === "" ? null : rawDevice;
  if (
    device !== null &&
    (device.length > MAX_DEVICE_ID || !/^[\x21-\x7e]+$/.test(device))
  )
    throw new SimulateInputError(
      "device",
      `device is the device id an SDK sends (printable ASCII, at most ${MAX_DEVICE_ID})`,
    );
  const rawMethods = params.get("methods");
  const methods = (
    rawMethods === null || rawMethods === "" ? "download" : rawMethods
  ).split(",");
  if (!methods.every((m) => (BINARY_METHODS as readonly string[]).includes(m)))
    throw new SimulateInputError(
      "methods",
      `methods is a ',' list of ${BINARY_METHODS.join(", ")}`,
    );
  const reported = params.get("packSetId");
  if (reported !== null && reported !== "" && !/^[0-9a-f]{64}$/.test(reported))
    throw new SimulateInputError("packSetId", "packSetId is 64 lowercase hex");
  return {
    appRelease,
    platform,
    outlet,
    axes,
    channel,
    device,
    methods: [...new Set(methods)] as BinaryMethod[],
    packSetId: reported ? reported : null,
  };
}

// ── The response (the contract later support tooling reads; see the brief's hand-off) ────────

export interface SimulatedRelease {
  sha256: string;
  version: string;
  seq: number;
}

export interface SimulatedGate {
  halted: boolean;
  rollout: { bp: number; salt: string } | null;
  /** The device's bucket for this gate's salt, or null without a device id. */
  bucket: number | null;
  /** Whether the device takes the target (inside the rollout and not halted). */
  takesTarget: boolean;
  fallback: SimulatedRelease | null;
}

export interface SimulatedPack {
  pack: string;
  /** The declaration, or null for a pack the stamp names that is no longer declared. */
  declared: { binding: string; required: boolean; delivery: string } | null;
  /** The stamp's `expects` entry, or null. */
  expected: { required: boolean; delivery: string } | null;
  effectiveBinding: string | null;
  reason: {
    kind: "app-pin" | "app-hold" | "transport" | "declared" | "undeclared";
    detail: string;
    transport?: string;
  };
  /** The feed target `selectPackRows` picks for the selector, before the outlet's narrowing. */
  feedTarget: SimulatedRelease | null;
  gate: SimulatedGate | null;
  floor: { minVersion: string; versionScheme: string } | null;
  unsatisfied: { reason: string; detail: string; variant: string }[];
  revocations: {
    /** `record` (P4-13) or `delegation` (P4-19: `target` is the delegation's hash). */
    kind: "record" | "delegation";
    record: string;
    target: string;
    version: string;
    replacement: { releaseId: string; sha256: string } | null;
    reason: string;
  }[];
  /** The fresh device's active install (an embedded baseline), or null. */
  active: SimulatedRelease | null;
  /** The decision's install for this pack, or null. */
  install: SimulatedRelease | null;
  revoke: boolean;
  /** What the device runs after the check, or null. */
  runs: SimulatedRelease | null;
}

export interface SimulateResult {
  selector: {
    appRelease: string;
    version: string;
    channel: string;
    platform: string;
    outlet: { id: string; kind: string; servesPlatform: boolean } | null;
    axes: Record<string, string[]>;
    engine: string | null;
    contentApi: number | null;
    build: { id: string; arch: string; format: string } | null;
    device: string | null;
    methods: BinaryMethod[];
  };
  feed: {
    composable: boolean;
    /** `{}` for the channel-wide document, else `{platform}`. */
    selector: Record<string, string>;
    /** Content members the size cap or a self-check left out of this document. */
    omitted: string[];
    /** Entries the document's delta menu lists (P4-29, ranked as the route signs it); 0: none. */
    deltas: number;
    target: SimulatedRelease | null;
    /** The app rollout on the device's outlet entry, with the device's bucket. */
    appRollout: {
      halted: boolean;
      rollout: { bp: number; salt: string } | null;
      bucket: number | null;
    } | null;
  };
  /** The decision a fresh device reaches (client-core `decideUpdate` via `runUpdateCheck`). */
  decision: UpdateDecision | null;
  boot: string | null;
  /** `UpdateCheck.errors` (a record that would not verify, …). */
  errors: { code: string; detail: string | null }[];
  /** The set the device runs after this check, by pack id, and its `packSetId`. */
  set: { pack: string; sha256: string; version: string; seq: number }[];
  packSetId: string | null;
  /** The set before the check (the embedded baselines). */
  activePackSetId: string | null;
  reported: { packSetId: string; matches: boolean } | null;
  block: string | null;
  packs: SimulatedPack[];
  notes: string[];
}

function payloadOf<T>(jws: string): T | null {
  try {
    return JSON.parse(
      new TextDecoder().decode(base64UrlDecode(jws.split(".")[1] ?? "")),
    ) as T;
  } catch {
    return null;
  }
}

const ARCH_RANK = (arch: string): number =>
  arch === "universal" ? 1 : arch === "any" ? 2 : 0;

function b64url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The kid of the per-request key: no product key carries it (product kids never use `sim-`). */
const EPHEMERAL_KID_PREFIX = "sim-";

/**
 * A fresh Ed25519 key pair for one simulation (WebCrypto): its PKCS#8 PEM (for `signDoc`), its raw
 * public key as base64url (a trust-set entry) and a random kid. Dropped when the request ends.
 */
export async function ephemeralSigner(): Promise<{
  pem: string;
  publicKey: string;
  kid: string;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey(
    "pkcs8",
    pair.privateKey,
  )) as ArrayBuffer;
  const raw = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey,
  )) as ArrayBuffer;
  const body = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const id = new Uint8Array(8);
  crypto.getRandomValues(id);
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
    publicKey: b64url(raw),
    kid: `${EPHEMERAL_KID_PREFIX}${[...id].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
  };
}

const cmpBytes = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export async function simulate(
  ctx: Pick<ServiceContext, "db" | "hooks" | "now"> & {
    /** Only the slug: this module never reads the product's signing key (see the header). */
    product: { readonly slug: string };
    /** Only the delta menu's deployment switch (P4-29), never the bindings: absent, no menu. */
    lazyDeltas?: string;
  },
  q: SimulateQuery,
): Promise<SimulateResult> {
  const { db, product, hooks, now } = ctx;
  const slug = product.slug;
  const cfg = await getReleaseConfig(db, slug);
  if (!cfg)
    throw new SimulateNotFound("the product has no release configuration");
  const channel = canonicalFeedChannel(q.channel, cfg);
  if (channel === null)
    throw new SimulateInputError("channel", `${q.channel} names no channel`);

  // ── the installed app release and its build for the platform ─────────────────────────────
  const records = await recordsByRelease(db, slug, "app");
  const appRow = records.get(q.appRelease);
  if (!appRow || appRow.kind !== "app")
    throw new SimulateNotFound(
      `${q.appRelease} is no app release with a stored signed record`,
    );
  const app = payloadOf<ReleaseRecordDoc>(appRow.jws);
  if (!app)
    throw new SimulateNotFound(`${q.appRelease}'s record does not read back`);
  const builds = (app.builds ?? [])
    .filter((b) => b.platform === q.platform)
    .sort(
      (a, b) => ARCH_RANK(a.arch) - ARCH_RANK(b.arch) || cmpBytes(a.id, b.id),
    );
  const build = builds[0] ?? null;
  const req =
    build && build.requires && typeof build.requires === "object"
      ? build.requires
      : {};
  const engine = typeof req.engine === "string" ? req.engine : null;
  const content: AppContent | null = app.content ?? null;
  const notes: string[] = [];
  if (!build)
    notes.push(
      `${q.appRelease} has no ${q.platform} build: the simulated device runs a build of it that is not in its record.`,
    );
  if (!content)
    notes.push(
      `${q.appRelease}'s record carries no content stamp: the device makes no content decision.`,
    );

  // The fresh device's active set: the embedded baselines (the record pins every embedded pack).
  const active: Record<string, ReleasePin> = {};
  if (content)
    for (const p of build?.embeds ?? []) {
      const pin = content.pins.find((x) => x.pack === p);
      if (pin) active[p] = pin.release;
    }

  // ── the outlet ────────────────────────────────────────────────────────────────────────────
  const delivery = hooks.delivery();
  const outlets = delivery ? await delivery.outlets() : [];
  let outletInfo: SimulateResult["selector"]["outlet"] = null;
  let outletKind: OutletKind | "unknown" = "unknown";
  if (q.outlet !== null) {
    const o = outlets.find((x) => x.outletId === q.outlet);
    if (!o)
      throw new SimulateNotFound(
        `${q.outlet} is no live outlet of this product`,
      );
    outletKind = (OUTLET_KINDS as readonly string[]).includes(o.kind)
      ? (o.kind as OutletKind)
      : "unknown";
    outletInfo = { id: o.outletId, kind: o.kind, servesPlatform: false };
  }

  // ── the feed document the route would sign ───────────────────────────────────────────────
  const composed = await composeChannelFeed(
    {
      db,
      product: slug,
      hooks,
      cfg,
      ...(ctx.lazyDeltas !== undefined
        ? { env: { LAZY_DELTAS: ctx.lazyDeltas } }
        : {}),
    },
    channel,
  );
  if (!composed)
    throw new SimulateInputError("channel", `${q.channel} names no channel`);
  const seqRow = await db.first<{ seq: number }>(
    "SELECT seq FROM update_feed_state WHERE product = ? AND channel = ?",
    slug,
    composed.channel,
  );
  const seq = seqRow?.seq ?? (await startingFeedSeq(db, slug));
  const probe = documentFor(
    slug,
    await withRankedMenu(hooks, composed),
    q.platform,
    seq,
    now,
  );
  const doc: ChannelFeedDoc = probe.doc;
  const composable = feedSelfCheck(doc, probe.platform);
  const omitted = [
    ...new Set(
      probe.audits
        .map((a) => a.action)
        .filter((a) => /_omitted$|_trimmed$|_truncated$/.test(a)),
    ),
  ];
  const target = doc.app.targets.find((t) => t.platform === q.platform) ?? null;
  const entryId =
    target && q.outlet !== null && Object.hasOwn(target.outlets, q.outlet)
      ? q.outlet
      : null;
  if (outletInfo) outletInfo.servesPlatform = entryId !== null;
  if (q.outlet !== null && entryId === null)
    notes.push(
      `The feed has no ${q.outlet} entry for ${q.platform}: the device finds no outlet entry (no offer, no narrowing, no gates).`,
    );
  const entry = entryId !== null ? target!.outlets[entryId]! : null;
  const bucketFor = async (salt: string): Promise<number | null> =>
    q.device === null ? null : rolloutBucket(salt, q.device);

  // ── the device's check ────────────────────────────────────────────────────────────────────
  const releaseKeys = releaseKeyTrustSet(cfg);
  let decision: UpdateDecision | null = null;
  let boot: string | null = null;
  let errors: SimulateResult["errors"] = [];
  if (!composable)
    notes.push(
      "The feed route would answer 500 feed_not_composable for this selector: every device keeps what it has.",
    );
  else if (Object.keys(releaseKeys).length === 0)
    notes.push(
      "The product pins no release keys: a device verifies no record, so it decides nothing.",
    );
  else {
    const signer = await ephemeralSigner();
    const jws = await signDoc(doc, signer.pem, signer.kid, "pkey-feed+jws");
    // The device's trust set: the ephemeral key (the only one that verifies the feed) beside every
    // PUBLIC key the product has had (public columns only), so the release-key-is-not-a-product-key
    // refusal still runs for real. Only the ephemeral kid can match the feed's header.
    const trust: Record<string, string> = {};
    for (const [i, bytes] of (await productSigningKeyBytes(db, slug)).entries())
      trust[`${EPHEMERAL_KID_PREFIX}product-${i}`] = b64url(
        bytes.slice().buffer,
      );
    trust[signer.kid] = signer.publicKey;
    const result = await runUpdateCheck({
      channel: composed.channel,
      expectedAud: slug,
      trust,
      releaseKeys,
      now,
      installId: q.device,
      installed: {
        version: app.version,
        buildNumber: build?.buildNumber ?? null,
        platform: q.platform,
        arch: build?.arch ?? "any",
        format: build?.format ?? null,
        engine,
      },
      outlet: { id: q.outlet, kind: outletKind },
      subkind: null,
      staged: null,
      skipVersion: null,
      methods: q.methods,
      cache: {},
      fetchFeed: async () => ({ ok: true, body: jws }),
      fetchRecord: async (sha256) => {
        const row = await getRecordByHash(db, slug, sha256);
        return row
          ? { ok: true, body: row.jws }
          : { ok: false, code: "not_found" };
      },
      ...(content
        ? {
            content: {
              stamp: content,
              holds: holdsOf(content),
              active,
              engine,
              axes: q.axes,
              revoked: {},
            },
          }
        : {}),
    });
    if (result.ok) {
      decision = result.check.decision;
      boot = result.boot;
      errors = result.check.errors;
    } else errors = [result.error];
  }

  // ── the set after the check ───────────────────────────────────────────────────────────────
  const after = new Map<string, ReleasePin>(Object.entries(active));
  if (decision?.action === "packs") {
    for (const p of decision.revoke) after.delete(p);
    for (const i of decision.install) after.set(i.pack, i.release);
  }
  const set = [...after.entries()]
    .sort(([a], [b]) => cmpBytes(a, b))
    .map(([pack, r]) => ({
      pack,
      sha256: r.sha256,
      version: r.version,
      seq: r.seq,
    }));
  const id = await packSetId(
    set.map((s) => ({ packId: s.pack, releaseSha256: s.sha256 })),
  );
  const activeId = await packSetId(
    Object.entries(active).map(([packId, r]) => ({
      packId,
      releaseSha256: r.sha256,
    })),
  );
  const block =
    decision === null
      ? null
      : decision.action === "blocked"
        ? decision.reason
        : "contentBlock" in decision && decision.contentBlock !== undefined
          ? decision.contentBlock
          : null;

  // ── per pack: bindings, targets, gates, floors, markers, revocations ─────────────────────
  const declared = (await readPackDeliverables(db, slug)).packs;
  const transports = delivery ? await delivery.transports() : [];
  const bindings =
    q.outlet !== null && delivery
      ? (effectivePackBindings(
          declared,
          [{ outletId: q.outlet }],
          transports,
          delivery.defaultTransport,
        )[q.outlet] ?? {})
      : {};
  const ps = doc.packSets ?? null;
  const level = content?.contentApi ?? null;
  const targets =
    ps && level !== null
      ? selectPackRows(ps, {
          contentApi: level,
          platform: q.platform,
          engine: engine ?? "",
          axes: q.axes,
        })
      : new Map<string, string>();
  const pinOf = (h: string | null): SimulatedRelease | null =>
    h !== null && ps && Object.hasOwn(ps.releases, h)
      ? {
          sha256: h,
          version: ps.releases[h]!.version,
          seq: ps.releases[h]!.seq,
        }
      : null;
  const outletPart =
    entryId !== null && ps?.outlets && Object.hasOwn(ps.outlets, entryId)
      ? ps.outlets[entryId]!
      : null;
  const stored =
    level === null
      ? []
      : (await readStoredSets(db, slug, composed.channel)).filter(
          (s) =>
            s.appDeliverable === "app" &&
            s.contentApi === level &&
            s.platform === q.platform &&
            s.engine === (engine ?? "") &&
            Object.entries(variantOfKey(s.variant)).every(
              ([axis, value]) => q.axes[axis]?.[0] === value,
            ),
        );
  const revocations = await readAllRevocations(db, slug);
  const listedRevocations = new Set(
    (doc.revocations ?? []).map((r) => r.record),
  );

  const known = new Set<string>([
    ...declared.map((d) => d.id),
    ...(content?.expects.map((e) => e.pack) ?? []),
    ...(content?.pins.map((p) => p.pack) ?? []),
    ...Object.keys(active),
    ...after.keys(),
  ]);
  const holds = content ? (holdsOf(content) ?? []) : [];
  const packs: SimulatedPack[] = [];
  for (const p of [...known].sort(cmpBytes)) {
    const d = declared.find((x) => x.id === p) ?? null;
    const e = content?.expects.find((x) => x.pack === p) ?? null;
    const pin = content?.pins.find((x) => x.pack === p) ?? null;
    const hold = holds.find((x) => x.pack === p) ?? null;
    let effectiveBinding: string | null = d?.binding ?? null;
    let reason: SimulatedPack["reason"];
    if (pin) {
      effectiveBinding = "pinned";
      reason = {
        kind: "app-pin",
        detail: `pinned by app release ${app.version} (${pin.release.version})`,
      };
    } else if (hold) {
      effectiveBinding = "pinned";
      reason = {
        kind: "app-hold",
        detail: `held by app release ${app.version} at ${hold.release.version}`,
      };
    } else if (!d) {
      reason = { kind: "undeclared", detail: "no longer declared" };
    } else if (bindings[p] === "pinned" && d.binding !== "pinned") {
      const t =
        transports.find((x) => x.deliverable === p && x.outlet === q.outlet)
          ?.transport ??
        delivery?.defaultTransport ??
        "";
      effectiveBinding = "pinned";
      reason = {
        kind: "transport",
        transport: t,
        detail: `${d.binding} (pinned by ${t} on ${q.outlet}: that transport cannot deliver content between app releases)`,
      };
    } else reason = { kind: "declared", detail: `${d.binding} (declared)` };

    const h = targets.get(p) ?? null;
    let gate: SimulatedGate | null = null;
    if (h !== null && outletPart?.gates && Object.hasOwn(outletPart.gates, h)) {
      const g = outletPart.gates[h]!;
      const bucket = g.rollout ? await bucketFor(g.rollout.salt) : null;
      gate = {
        halted: g.halted,
        rollout: g.rollout ?? null,
        bucket,
        takesTarget:
          !g.halted &&
          (g.rollout === undefined ||
            (bucket !== null && bucket < g.rollout.bp)),
        fallback: pinOf(g.fallback),
      };
    }
    const floor =
      level === null
        ? null
        : ((doc.packFloors ?? []).find(
            (f) => f.pack === p && f.contentApi === level,
          ) ?? null);
    const install =
      decision?.action === "packs"
        ? (decision.install.find((i) => i.pack === p)?.release ?? null)
        : null;
    const runs = after.get(p) ?? null;
    const mine = new Set([
      ...(pin ? [pin.release.sha256] : []),
      ...(hold ? [hold.release.sha256] : []),
      ...(h !== null ? [h] : []),
      ...(active[p] ? [active[p]!.sha256] : []),
    ]);
    packs.push({
      pack: p,
      declared: d
        ? { binding: d.binding, required: d.required, delivery: d.delivery }
        : null,
      expected: e ? { required: e.required, delivery: e.delivery } : null,
      effectiveBinding,
      reason,
      feedTarget: pinOf(h),
      gate,
      floor: floor
        ? { minVersion: floor.minVersion, versionScheme: floor.versionScheme }
        : null,
      unsatisfied: stored.flatMap((s) =>
        s.unsatisfied
          .filter((u) => u.pack === p)
          .map((u) => ({
            reason: u.reason,
            detail: u.detail,
            variant: s.variant,
          })),
      ),
      revocations: revocations
        .filter((r) => r.deliverableId === p)
        // A record revocation of a release this device holds or is offered, or any the feed lists
        // for the pack (a delegation's revocation names no release: it is always listed, P4-19).
        .filter(
          (r) =>
            ((r.kind ?? "record") === "record" && mine.has(r.targetSha256)) ||
            listedRevocations.has(r.recordSha256),
        )
        .map((r) => ({
          kind: r.kind ?? "record",
          record: r.recordSha256,
          target: r.targetSha256,
          version: r.version,
          replacement: r.replacement,
          reason: r.reason,
        })),
      active: active[p]
        ? {
            sha256: active[p]!.sha256,
            version: active[p]!.version,
            seq: active[p]!.seq,
          }
        : null,
      install: install
        ? { sha256: install.sha256, version: install.version, seq: install.seq }
        : null,
      revoke: decision?.action === "packs" && decision.revoke.includes(p),
      runs: runs
        ? { sha256: runs.sha256, version: runs.version, seq: runs.seq }
        : null,
    });
  }

  const appRollout =
    entry !== null
      ? {
          halted: entry.halted,
          rollout: entry.rollout ?? null,
          bucket: entry.rollout ? await bucketFor(entry.rollout.salt) : null,
        }
      : null;

  return {
    selector: {
      appRelease: q.appRelease,
      version: app.version,
      channel: composed.channel,
      platform: q.platform,
      outlet: outletInfo,
      axes: q.axes,
      engine,
      contentApi: level,
      build: build
        ? { id: build.id, arch: build.arch, format: build.format }
        : null,
      device: q.device,
      methods: q.methods,
    },
    feed: {
      composable,
      selector: doc.selector as Record<string, string>,
      omitted,
      deltas: Object.values(doc.deltas ?? {}).reduce(
        (n, list) => n + list.length,
        0,
      ),
      target: target
        ? {
            sha256: target.release.sha256,
            version: target.release.version,
            seq: target.release.seq,
          }
        : null,
      appRollout,
    },
    decision,
    boot,
    errors,
    set,
    packSetId: id,
    activePackSetId: activeId,
    reported:
      q.packSetId !== null
        ? { packSetId: q.packSetId, matches: q.packSetId === id }
        : null,
    block,
    packs,
    notes,
  };
}
