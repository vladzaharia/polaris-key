// `cases.json#/delegationCases` (plans/P4-19.md §4.2).

import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  importSigningKey,
} from "@polaris-key/jws";
import {
  ALT_KID,
  AUD_V3,
  FEED_NOW,
  headerText,
  pem,
  PIN_KID,
  pub,
  raw,
  rawJson,
  REL_KID,
  REL2_KID,
  sha256Hex,
  signAs,
  signRawSegments,
  signText,
  type TypV3,
  utf8Bytes,
} from "./common.js";
import { p13Hash, p13RevRecord } from "./content-fixture.js";
import {
  objRef,
  PACK_PAYLOADS,
  packDoc,
  packRecordDocs,
} from "./pack-records.js";
import { feedPayload, RECORD_ISSUED, recordDoc } from "./release-records.js";
import { ctxOf } from "./reference/claims.js";
import { refFeedContent } from "./reference/content.js";
import {
  type DelegationPin,
  P19_KID_RE,
  P19_MAX_TTL,
  p19Kid,
  type P19Step,
  refRecordRevoked,
  refVerifyDelegatedRecord,
} from "./reference/delegation.js";
import { refFeedClaims } from "./reference/feed.js";
import { refVerifyJws } from "./reference/jws.js";
import {
  refVerifyRevocationCase,
  type RevocationCase,
} from "./reference/revocation.js";
import { payloadTextOf, refNonWire } from "./reference/tokens.js";

// ── `delegationCases` (plans/P4-19.md §4.2) ──────────────────────────────────────────────────
// Content-key delegation: a CI-signed `kind: delegation` record lets one content key sign
// tree-layout pack records of the data-only types under a pack-id scope, inside a signing window.
// The reference below restates §2.2's `delegationOf`, §2.3's delegated path of steps 12–16 and
// `recordRevoked` from first principles; every case is checked against it at its exact step.

/** The content keys: deterministic TEST keys from fixed seeds (never a real key). Their public
 *  halves appear only inside the cases' delegations, so the top-level `keys` array is unchanged. */
interface ContentKey {
  pem: string;
  pub: string;
}
function contentKey(label: string): ContentKey {
  const seed = createHash("sha256")
    .update(`pkey-corpus-content-key:${label}`)
    .digest();
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { x: string };
  return {
    pem: key.export({ format: "pem", type: "pkcs8" }).toString().trim(),
    pub: jwk.x,
  };
}
const P19_COUNTS = { delegationCases: 46 };

interface DelegationCase {
  id: string;
  description: string;
  mode: "record" | "release-only" | "revocation" | "feed";
  jws: string;
  /** `record` mode: the delegation's compact JWS the caller supplies; null otherwise. */
  delegation?: string | null;
  releaseKeys?: Record<string, string>;
  productTrust?: Record<string, string>;
  expectedAud: string;
  expectedHash?: string;
  pin?: DelegationPin | null;
  /** `record` mode: the revoked target hashes `recordRevoked` reads. */
  revoked?: string[];
  /** `revocation` mode: the feed entry. */
  entry?: Record<string, unknown>;
  /** `feed` mode. */
  trust?: Record<string, string>;
  channel?: string;
  platform?: string;
  now?: number;
  checkFreshness?: boolean;
  expect: Record<string, unknown>;
}

export async function buildDelegationCases(): Promise<DelegationCase[]> {
  const CK = contentKey("djdl-events-2026");
  const CK2 = contentKey("djdl-events-other");
  const RK: Record<string, string> = { [REL_KID]: pub(REL_KID) };
  const RK2: Record<string, string> = { ...RK, [REL2_KID]: pub(REL2_KID) };
  const PT: Record<string, string> = {
    [PIN_KID]: pub(PIN_KID),
    [ALT_KID]: pub(ALT_KID),
  };
  const DI = RECORD_ISSUED + 2_000;
  const DE = DI + 180 * 86400;
  const PI = DI + 3_000;
  const ROOT = "djdl.events";
  const TYP: TypV3 = "pkey-release+jws";

  const delDoc = (over: Record<string, unknown> = {}): Record<string, any> => ({
    schemaVersion: 1,
    aud: AUD_V3,
    deliverable: ROOT,
    kind: "delegation",
    version: "1",
    seq: 1,
    issuedAt: DI,
    expiresAt: DE,
    delegate: { publicKey: CK.pub },
    types: ["files.tree", "data.json"],
    notes: "Events team, corpus",
    ...over,
  });
  const signWith = async (
    payloadText: string,
    pemText: string,
    kid: string,
  ): Promise<string> => {
    const header = headerText(TYP, kid);
    const input = `${base64UrlEncodeBytes(utf8Bytes(header))}.${base64UrlEncodeBytes(utf8Bytes(payloadText))}`;
    const key = await importSigningKey(pemText);
    const sig = await crypto.subtle.sign(
      { name: "Ed25519" },
      key,
      utf8Bytes(input),
    );
    return `${input}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
  };
  const signDel = (
    doc: Record<string, unknown>,
    kid = REL_KID,
  ): Promise<string> => signAs(doc, kid, TYP);
  const treeVariant = (
    sel: Record<string, string> = {},
  ): Record<string, unknown> => ({
    variant: sel,
    payload: { ...PACK_PAYLOADS.t1 },
    full: objRef("tree/t1.full.zst"),
    files: {
      format: "pkey-files/1",
      layout: "tree",
      ...objRef("tree/t1.files.zst"),
    },
  });
  const packRec = (
    over: Record<string, unknown> = {},
    deliverable = `${ROOT}.halloween`,
  ): Record<string, any> => ({
    ...packDoc(deliverable, "1.0.0", 1, {
      type: "files.tree",
      formatVersion: 1,
      variants: [treeVariant()],
    }),
    issuedAt: PI,
    ...over,
  });
  /** A record signed by a content key under the delegation `delJws`. */
  const signUnder = (
    doc: Record<string, unknown>,
    delJws: string,
    key: ContentKey = CK,
  ): Promise<string> =>
    signWith(JSON.stringify(doc), key.pem, `pkd1-${sha256Hex(delJws)}`);
  const pinOfDoc = (d: Record<string, any>): DelegationPin => ({
    kind: d.kind,
    deliverable: d.deliverable,
    version: d.version,
    seq: d.seq,
  });

  const D = await signDel(delDoc());
  const cases: DelegationCase[] = [];
  const ids = new Set<string>();
  const push = (c: DelegationCase): void => {
    if (ids.has(c.id)) throw new Error(`delegationCases: duplicate ${c.id}`);
    ids.add(c.id);
    cases.push(c);
  };

  /** A `record` or `release-only` case, checked against the reference at its step. */
  const rec = async (
    id: string,
    description: string,
    o: {
      jws: string;
      delegation?: string | null;
      releaseOnly?: boolean;
      releaseKeys?: Record<string, string>;
      pin?: DelegationPin | null;
      revoked?: string[];
      expect: "ok" | P19Step;
      revokedExpect?: "record" | "delegation" | null;
    },
  ): Promise<void> => {
    const delegation = o.releaseOnly ? null : (o.delegation ?? D);
    const pin =
      o.pin === undefined ? pinOfDoc(JSON.parse(payloadTextOf(o.jws)!)) : o.pin;
    const c: DelegationCase = {
      id,
      description,
      mode: o.releaseOnly ? "release-only" : "record",
      jws: o.jws,
      delegation,
      releaseKeys: o.releaseKeys ?? RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      expectedHash: sha256Hex(o.jws),
      pin,
      ...(o.revoked ? { revoked: o.revoked } : {}),
      expect: {},
    };
    const r = refVerifyDelegatedRecord({
      jws: c.jws,
      delegation,
      releaseKeys: c.releaseKeys!,
      productTrust: PT,
      expectedAud: AUD_V3,
      expectedHash: c.expectedHash!,
      pin,
    });
    if (o.expect === "ok") {
      if (!r.ok)
        throw new Error(
          `delegationCases ${id}: the reference refuses it at ${r.step}`,
        );
      const del =
        r.delegation === null
          ? null
          : {
              sha256: r.delegation.sha256,
              deliverable: r.delegation.deliverable,
              types: r.delegation.types,
              issuedAt: r.delegation.issuedAt,
              expiresAt: r.delegation.expiresAt,
            };
      c.expect = { verify: "ok", kind: r.doc.kind, delegation: del };
      if (o.revoked) {
        const got = refRecordRevoked(
          c.expectedHash!,
          del === null ? null : del.sha256,
          o.revoked,
        );
        if (got !== (o.revokedExpect ?? null))
          throw new Error(`delegationCases ${id}: recordRevoked is ${got}`);
        c.expect.revoked = got;
      }
    } else {
      if (r.ok || r.step !== o.expect)
        throw new Error(
          `delegationCases ${id}: the reference answers ${r.ok ? "ok" : r.step}, not ${o.expect}`,
        );
      c.expect = { verify: "fail", step: o.expect };
    }
    // Every delegated kid is `pkd1-` and its supplied delegation's hash, except the cases
    // built to break that.
    const kid = p19Kid(c.jws) as string;
    if (
      P19_KID_RE.test(kid) &&
      delegation !== null &&
      kid.slice(5) !== sha256Hex(delegation) &&
      !["delegation-hash-mismatch"].includes(id)
    )
      throw new Error(`delegationCases ${id}: kid names another delegation`);
    push(c);
  };

  // ── ok ──
  const base = packRec();
  await rec(
    "delegated-valid-files-tree",
    "The control: djdl.events.halloween (files.tree, tree layout) signed by the content key under a delegation of djdl.events for [files.tree, data.json], issued inside the window; the delegation is signed by the pinned 2026 release key.",
    { jws: await signUnder(base, D), expect: "ok" },
  );
  await rec(
    "delegated-valid-data-json",
    "A `data.json` pack (djdl.events.lore) under the same delegation.",
    {
      jws: await signUnder(packRec({ type: "data.json" }, `${ROOT}.lore`), D),
      expect: "ok",
    },
  );
  await rec(
    "delegated-valid-prefix-is-pack-id",
    "The record's pack id IS the scope root (djdl.events): whole-segment matching covers the root itself.",
    { jws: await signUnder(packRec({}, ROOT), D), expect: "ok" },
  );
  {
    const D27 = await signDel(delDoc(), REL2_KID);
    await rec(
      "delegated-valid-delegation-by-2027-key",
      "The delegation is signed by the second pinned release key (2027), during a rotation.",
      {
        jws: await signUnder(base, D27),
        delegation: D27,
        releaseKeys: RK2,
        expect: "ok",
      },
    );
  }
  await rec(
    "delegated-valid-window-start",
    "The record's `issuedAt` equals the delegation's `issuedAt` (the window is closed at both ends).",
    { jws: await signUnder(packRec({ issuedAt: DI }), D), expect: "ok" },
  );
  await rec(
    "delegated-valid-window-end",
    "The record's `issuedAt` equals the delegation's `expiresAt`.",
    { jws: await signUnder(packRec({ issuedAt: DE }), D), expect: "ok" },
  );
  const DU = await signDel(
    delDoc({ types: ["files.tree", "godot.pck", "future.type"] }),
  );
  await rec(
    "delegated-valid-unknown-types-ignored",
    "The delegation lists [files.tree, godot.pck, future.type]: godot.pck is never delegable and future.type is unknown, so both are ignored and the effective types are [files.tree].",
    { jws: await signUnder(base, DU), delegation: DU, expect: "ok" },
  );
  {
    const relSigned = await signAs(base, REL_KID, TYP);
    await rec(
      "release-kid-ignores-delegation",
      "A pack record signed by the pinned release key itself, with a delegation supplied: today's path, the delegation is ignored and the result's `delegation` is null.",
      { jws: relSigned, expect: "ok" },
    );
  }
  await rec(
    "delegation-record-verify-only",
    "The delegation record verified as a record with no pin and no delegation: `kind: delegation` verifies (steps 12–14) and is never acted on as a record.",
    { jws: D, releaseOnly: true, pin: null, expect: "ok" },
  );

  // ── delegation ──
  const viaDel = async (
    id: string,
    description: string,
    del: string,
    o: {
      releaseKeys?: Record<string, string>;
      key?: ContentKey;
      doc?: Record<string, unknown>;
    } = {},
  ): Promise<void> =>
    rec(id, description, {
      jws: await signUnder(o.doc ?? base, del, o.key),
      delegation: del,
      releaseKeys: o.releaseKeys,
      expect: "delegation",
    });
  await viaDel(
    "delegation-unpinned-signer",
    "The delegation is signed by the 2027 release key, which this app does not pin.",
    await signDel(delDoc(), REL2_KID),
  );
  await viaDel(
    "delegation-signed-by-product-key",
    "The delegation is signed by the product key; even listed among the release keys, a key in the product trust set is refused (step 13's product-key rule).",
    await signDel(delDoc(), PIN_KID),
    { releaseKeys: { ...RK, [PIN_KID]: pub(PIN_KID) } },
  );
  {
    const D2 = await signDel(delDoc({ notes: "Another delegation" }));
    await rec(
      "delegation-hash-mismatch",
      "The record's kid names the base delegation, but the caller supplies a different (valid) delegation: its hash is not the kid's.",
      { jws: await signUnder(base, D), delegation: D2, expect: "delegation" },
    );
  }
  {
    const app = await signAs(recordDoc(), REL_KID, TYP);
    await viaDel(
      "delegation-not-a-delegation",
      "The kid names an app record signed by the release key: it verifies as a record but is not `kind: delegation`.",
      app,
    );
  }
  {
    const inner = await signWith(
      JSON.stringify(delDoc({ notes: "Re-delegated" })),
      CK.pem,
      `pkd1-${sha256Hex(D)}`,
    );
    await viaDel(
      "delegation-signed-by-content-key",
      "The delegation is itself signed by a content key (under the base delegation): a delegation verifies against pinned release keys only, so a content key can never re-delegate (one level only).",
      inner,
    );
  }
  {
    const d = delDoc();
    delete d.types;
    await viaDel(
      "delegation-types-missing",
      "The delegation has no `types`.",
      await signDel(d),
    );
  }
  await viaDel(
    "delegation-types-none-effective",
    "`types` is [godot.pck]: no listed type is delegable, so there are no effective types.",
    await signDel(delDoc({ types: ["godot.pck"] })),
  );
  await viaDel(
    "delegation-types-too-many",
    "`types` has 9 entries (the bound is 8).",
    await signDel(
      delDoc({
        types: [
          "files.tree",
          "data.json",
          "l10n.table",
          "a.one",
          "a.two",
          "a.three",
          "a.four",
          "a.five",
          "a.six",
        ],
      }),
    ),
  );
  await viaDel(
    "delegation-types-duplicate",
    "`types` lists files.tree twice.",
    await signDel(delDoc({ types: ["files.tree", "files.tree"] })),
  );
  await viaDel(
    "delegation-ttl-over-max",
    "`expiresAt − issuedAt` is 31,622,401 seconds, one over the 366-day bound.",
    await signDel(delDoc({ expiresAt: DI + P19_MAX_TTL + 1 })),
  );
  await viaDel(
    "delegation-expires-before-issued",
    "`expiresAt` is one second before `issuedAt`.",
    await signDel(delDoc({ expiresAt: DI - 1 })),
  );
  {
    const text = rawJson(delDoc({ expiresAt: raw("1.8e9") }));
    await viaDel(
      "delegation-expiresat-token",
      "`expiresAt` is the token 1.8e9: an exponent is never an integer claim (V4 §3.1), so the delegation is unusable.",
      await signText(text, REL_KID, TYP),
    );
  }
  await viaDel(
    "delegation-public-key-malformed",
    "`delegate.publicKey` is base64url of 31 bytes, not 32.",
    await signDel(
      delDoc({
        delegate: {
          publicKey: base64UrlEncodeBytes(
            base64UrlDecode(CK.pub).subarray(0, 31),
          ),
        },
      }),
    ),
  );
  {
    const relPem = pem(REL_KID);
    const dRel = await signDel(
      delDoc({ delegate: { publicKey: pub(REL_KID) } }),
    );
    await rec(
      "delegation-key-is-release-key",
      "The delegated key is the pinned release key itself (the record is signed by it under a pkd1- kid): refused, a delegated key is never a release key.",
      {
        jws: await signWith(
          JSON.stringify(base),
          relPem,
          `pkd1-${sha256Hex(dRel)}`,
        ),
        delegation: dRel,
        expect: "delegation",
      },
    );
    const dPk = await signDel(
      delDoc({ delegate: { publicKey: pub(PIN_KID) } }),
    );
    await rec(
      "delegation-key-is-product-key",
      "The delegated key is a product signing key (the record is signed by it under a pkd1- kid): refused, a delegated key is never a product key.",
      {
        jws: await signWith(
          JSON.stringify(base),
          pem(PIN_KID),
          `pkd1-${sha256Hex(dPk)}`,
        ),
        delegation: dPk,
        expect: "delegation",
      },
    );
  }
  await viaDel(
    "delegation-deliverable-app",
    "The delegation's `deliverable` is `app`, not a pack id.",
    await signDel(delDoc({ deliverable: "app" })),
  );

  // ── jws ──
  await rec(
    "delegated-no-delegation-supplied",
    "A delegated record verified without its delegation (a pre-P4-19 caller, or an app path): the kid is not a pinned release key, so step 13 refuses it at `jws`.",
    { jws: await signUnder(base, D), releaseOnly: true, expect: "jws" },
  );
  await rec(
    "delegated-wrong-signer",
    "The record names the base delegation but is signed by another content key.",
    { jws: await signUnder(base, D, CK2), expect: "jws" },
  );
  await rec(
    "delegated-kid-malformed",
    "The kid is `pkd1-` and 63 hex digits: not the delegated pattern, so no delegation is consulted.",
    {
      jws: await signWith(
        JSON.stringify(base),
        CK.pem,
        `pkd1-${sha256Hex(D).slice(0, 63)}`,
      ),
      expect: "jws",
    },
  );
  {
    const baseHash = sha256Hex(await signUnder(base, D));
    const revDocC = {
      schemaVersion: 1,
      aud: AUD_V3,
      deliverable: `${ROOT}.halloween`,
      kind: "revocation",
      version: "1.0.0",
      seq: 1,
      issuedAt: PI + 100,
      revokes: baseHash,
      reason: "Signed by a content key.",
    };
    const jws = await signUnder(revDocC, D);
    const entry = {
      record: sha256Hex(jws),
      pack: `${ROOT}.halloween`,
      target: baseHash,
      version: "1.0.0",
      seq: 1,
    };
    const r = refVerifyRevocationCase({
      id: "",
      description: "",
      mode: "revocation",
      jws,
      releaseKeys: RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      entry,
      expect: { verify: "ok" },
    });
    if (r.verify !== "fail" || r.step !== "jws")
      throw new Error("delegationCases revocation-signed-by-content-key");
    push({
      id: "revocation-signed-by-content-key",
      description:
        "A revocation signed by the content key under a pkd1- kid: `verifyRevocation` never passes a delegation, so it is refused at `jws` (only release keys revoke).",
      mode: "revocation",
      jws,
      delegation: null,
      releaseKeys: RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      entry,
      expect: { verify: "fail", step: "jws" },
    });
  }
  const appDoc = recordDoc({ issuedAt: PI });
  await rec(
    "app-record-by-content-key-release-only",
    "An app record signed by the content key, verified on an app path (no delegation passed): `jws`.",
    {
      jws: await signUnder(appDoc, D),
      releaseOnly: true,
      expect: "jws",
    },
  );

  // ── scope ──
  {
    const levels = packRecordDocs()["djdl.levels@1.0.0"]!;
    await rec(
      "delegated-godot-pck",
      "A `godot.pck` (container) pack under a delegation that even lists godot.pck: never an effective type, so `scope`.",
      {
        jws: await signUnder(
          {
            ...levels,
            deliverable: `${ROOT}.halloween`,
            tag: "djdl.events.halloween-v1.0.0",
            issuedAt: PI,
          },
          DU,
        ),
        delegation: DU,
        expect: "scope",
      },
    );
  }
  await rec(
    "delegated-type-not-delegated",
    "An `l10n.table` pack: a delegable type, but not one this delegation lists.",
    {
      jws: await signUnder(packRec({ type: "l10n.table" }), D),
      expect: "scope",
    },
  );
  {
    const c = packRecordDocs()["djdl.levels@1.0.0"]!;
    const container = structuredClone(
      (c.variants as Record<string, unknown>[])[0]!,
    );
    delete container.requires;
    container.variant = { texture: "etc2" };
    await rec(
      "delegated-container-layout",
      "A `files.tree`-typed record with a second, `container`-layout variant: a container is never delegable, whatever the type.",
      {
        jws: await signUnder(
          packRec({ variants: [treeVariant({ texture: "s3tc" }), container] }),
          D,
        ),
        expect: "scope",
      },
    );
  }
  await rec(
    "delegated-outside-prefix",
    "A pack outside the scope (djdl.levels).",
    { jws: await signUnder(packRec({}, "djdl.levels"), D), expect: "scope" },
  );
  await rec(
    "delegated-prefix-not-segment",
    "djdl.eventsx shares the scope root's characters but not its segment: whole-segment matching refuses it.",
    { jws: await signUnder(packRec({}, "djdl.eventsx"), D), expect: "scope" },
  );
  await rec(
    "delegated-after-window",
    "The record's `issuedAt` is one second after the delegation's `expiresAt` (the brief's expired delegation): devices check the record against the signing window, never their clock.",
    {
      jws: await signUnder(packRec({ issuedAt: DE + 1 }), D),
      expect: "scope",
    },
  );
  await rec(
    "delegated-before-window",
    "The record's `issuedAt` is one second before the delegation's `issuedAt`.",
    {
      jws: await signUnder(packRec({ issuedAt: DI - 1 }), D),
      expect: "scope",
    },
  );
  await rec(
    "app-record-by-content-key",
    "An app record signed by the content key with its delegation supplied (a runner passing one on an app path): steps 13–15 pass, step 16 refuses `kind: app`.",
    { jws: await signUnder(appDoc, D), expect: "scope" },
  );
  await rec(
    "delegation-by-content-key-as-record",
    "A delegation signed by the content key, verified as a record with the base delegation supplied: step 16 refuses `kind: delegation`.",
    {
      jws: await signUnder(delDoc({ issuedAt: PI, expiresAt: PI + 86400 }), D),
      pin: null,
      expect: "scope",
    },
  );

  // ── revocation and recordRevoked ──
  const rev = async (
    id: string,
    description: string,
    over: Record<string, unknown>,
  ): Promise<void> => {
    const doc = {
      schemaVersion: 1,
      aud: AUD_V3,
      deliverable: ROOT,
      kind: "revocation",
      version: "1",
      seq: 1,
      issuedAt: PI + 500,
      revokes: sha256Hex(D),
      reason: "Content key retired.",
      ...over,
    };
    const jws = await signAs(doc, REL_KID, TYP);
    const entry = {
      record: sha256Hex(jws),
      pack: ROOT,
      target: sha256Hex(D),
      version: "1",
      seq: 1,
      kind: "delegation",
    };
    const c: RevocationCase = {
      id,
      description,
      mode: "revocation",
      jws,
      releaseKeys: RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      entry,
      expect: { verify: "ok" },
    };
    const r = refVerifyRevocationCase(c);
    if (r.verify !== "ok")
      throw new Error(`delegationCases ${id}: the reference refuses it`);
    push({
      id,
      description,
      mode: "revocation",
      jws,
      delegation: null,
      releaseKeys: RK,
      productTrust: PT,
      expectedAud: AUD_V3,
      entry,
      expect: r as Record<string, unknown>,
    });
  };
  await rev(
    "revocation-of-delegation-valid",
    "P4-13's revocation record unchanged, naming the delegation: `deliverable`, `version` and `seq` are the delegation's and `revokes` its hash; the feed entry carries `kind: delegation`.",
    {},
  );
  const baseJws = await signUnder(base, D);
  await rec(
    "delegated-revoked-delegation",
    "The control record with the delegation's hash revoked: it verifies, and `recordRevoked` answers `delegation` (pack-revoked, detail delegation).",
    {
      jws: baseJws,
      revoked: [sha256Hex(D)],
      revokedExpect: "delegation",
      expect: "ok",
    },
  );
  await rec(
    "delegated-revoked-record",
    "The control record with its own hash revoked: `recordRevoked` answers `record` first.",
    {
      jws: baseJws,
      revoked: [sha256Hex(baseJws), sha256Hex(D)],
      revokedExpect: "record",
      expect: "ok",
    },
  );
  await rev(
    "revocation-of-delegation-replacement-ignored",
    "A delegation revocation carrying a `replacement`: `verifyRevocation` is unchanged and parses it, but ingest refuses it and a device ignores it for a delegation target (no release replaces a delegation).",
    {
      replacement: {
        sha256: sha256Hex(baseJws),
        seq: 1,
        version: "1.0.0",
      },
    },
  );

  // ── feed ──
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const feedCase = async (
    id: string,
    description: string,
    entries: Record<string, unknown>[],
    rawText = false,
  ): Promise<void> => {
    const doc = { ...feedPayload(), revocations: entries };
    const text = rawText ? rawJson(doc) : JSON.stringify(doc);
    const jws = await signRawSegments(
      headerText("pkey-feed+jws", PIN_KID),
      text,
      PIN_KID,
    );
    const v = refVerifyJws(jws, TRUST, "pkey-feed+jws");
    if (!v) throw new Error(`delegationCases ${id}: does not verify`);
    if (
      refFeedClaims(v.payload, ctxOf(v.text), {
        aud: AUD_V3,
        channel: "stable",
        platform: "macos",
      }) !== null
    )
      throw new Error(`delegationCases ${id}: fails the feed claims`);
    const content = refFeedContent(v.payload, ctxOf(v.text));
    if (refNonWire(v.text).length > 0)
      throw new Error(`delegationCases ${id}: non-wire integers`);
    push({
      id,
      description,
      mode: "feed",
      jws,
      trust: TRUST,
      expectedAud: AUD_V3,
      channel: "stable",
      platform: "macos",
      now: FEED_NOW,
      checkFreshness: true,
      expect: { verify: "ok", content },
    });
  };
  const packEntry = {
    record: p13RevRecord("foes@1.3.3"),
    pack: "diceroll.foes",
    target: p13Hash("foes@1.3.3"),
    version: "1.3.3",
    seq: 10,
  };
  const delEntry = (kind: unknown): Record<string, unknown> => ({
    record: sha256Hex("pkey-corpus-revocation:delegation:1"),
    pack: "diceroll.events",
    target: sha256Hex("pkey-corpus-delegation:diceroll.events:1"),
    version: "1",
    seq: 1,
    kind,
  });
  await feedCase(
    "feed-revocation-kind-delegation",
    "A feed whose `revocations` hold a pack-record entry (no `kind`) and a delegation entry (`kind: delegation`, `pack` the scope root): both are kept, `kind` carried as present.",
    [packEntry, delEntry("delegation")],
  );
  await feedCase(
    "feed-revocation-kind-unknown-dropped",
    "An entry whose `kind` is a forward vocabulary token (`future`): that entry alone is dropped.",
    [packEntry, delEntry("future")],
  );
  await feedCase(
    "feed-revocation-kind-not-string",
    "An entry whose `kind` is null: the `revocations` member is unusable (null), never the feed.",
    [packEntry, delEntry(null)],
  );

  // Self-checks: the counts; every step and mode the plan lists is present.
  if (cases.length !== P19_COUNTS.delegationCases)
    throw new Error(
      `delegationCases: ${cases.length} != ${P19_COUNTS.delegationCases}`,
    );
  const steps = new Set(
    cases.map((c) =>
      c.expect.verify === "ok" ? "ok" : (c.expect.step as string),
    ),
  );
  for (const s of ["ok", "delegation", "jws", "scope"])
    if (!steps.has(s)) throw new Error(`delegationCases: no ${s} case`);
  return cases;
}
