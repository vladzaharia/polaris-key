// RED TEAM R3 — server-side licensing bypass, seat abuse, entitlement escalation.
//
// Every test in this file is an ATTACK proof, not a contract test: each `expect` documents
// what a network-only adversary can obtain today. Assertions are written against the CURRENT
// (vulnerable) behaviour so the file passes on an unpatched tree; each block names the
// finding id it belongs to in docs/security/findings/R3-licensing.md.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyJws } from "@plrs/jws";
import {
  FINGERPRINT_COMPONENT_LENGTH,
  type ManagedConfigDoc,
} from "@plrs/protocol";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  DJDL_CATALOG,
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
  TEST_KID,
  TEST_PUB,
} from "../seed.js";
import { loadProduct, type Product } from "../../src/product.js";
import {
  handleAccount,
  handleActivate,
  handleConfig,
  handleDevices,
  handleToken,
} from "../../src/licensing.js";
import { handleEnroll } from "../../src/enroll.js";
import { handleBrowserSessionLicense } from "../../src/browserSession.js";
import { activateFromIdentity } from "../../src/oidc.js";
import {
  channelForVersion,
  checkBuildGate,
  tighterMax,
  tighterMin,
} from "../../src/gate.js";
import { resolveEffective } from "../../src/licenseCore.js";
import {
  isSealedEnvelope,
  sealManagedValue,
} from "../../src/admin/lib/managedSecrets.js";
import {
  countActiveDevices,
  findFingerprintByHwid,
  getFingerprint,
  getLicense,
  listDevicesByLicense,
} from "../../src/repo.js";
import type { Env } from "../../src/env.js";
import type { SqliteDb } from "../../src/db/sqlite.js";

const TRUST = { [TEST_KID]: TEST_PUB };
const HERE = dirname(fileURLToPath(import.meta.url));

function hash(seed: string): string {
  return seed
    .padEnd(FINGERPRINT_COMPONENT_LENGTH, "x")
    .slice(0, FINGERPRINT_COMPONENT_LENGTH);
}

/** One physical machine's full component set. */
const MACHINE = {
  machineUuid: hash("uuid"),
  boardSerial: hash("board"),
  cpuModel: hash("cpu"),
  primaryMac: hash("mac"),
  bootVolumeUuid: hash("boot"),
  ramBucket: hash("ram"),
  machineModel: hash("model"),
};

interface Harness {
  db: SqliteDb;
  env: Env;
  product: Product;
}

async function harness(catalog?: unknown): Promise<Harness> {
  const db = makeTestDb();
  const env = makeEnv(new KvMock(), ["djdl"]);
  await seedProduct(db, "djdl", catalog ? { catalog } : {});
  const product = (await loadProduct(env, db, "djdl"))!;
  return { db, env, product };
}

function activateReq(
  key: string,
  device: string,
  components?: Record<string, string>,
): Request {
  return mkReq(
    "POST",
    { authorization: `Bearer ${key}`, "x-pkey-device": device },
    components ? { fingerprint: { components, hwid: "forged" } } : undefined,
  );
}

async function activate(
  h: Harness,
  key: string,
  device: string,
  components?: Record<string, string>,
): Promise<string> {
  const res = await handleActivate(
    activateReq(key, device, components),
    h.env,
    h.db,
    h.product,
    NOW,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

function configReq(
  token: string,
  headers: Record<string, string> = {},
): Request {
  return mkReq("GET", { authorization: `Bearer ${token}`, ...headers });
}

async function config(
  h: Harness,
  token: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handleConfig(configReq(token, headers), h.env, h.db, h.product, NOW);
}

async function docOf(res: Response): Promise<ManagedConfigDoc> {
  const verified = await verifyJws<ManagedConfigDoc>(await res.text(), TRUST);
  expect(verified).not.toBeNull();
  return verified!.payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// R3-01 — the build gate is driven entirely by client-supplied headers.
// ─────────────────────────────────────────────────────────────────────────────
describe("R3-01 build gate is attacker-controlled", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  it("FIXED (R3-01): X-PKey-Version: 0.0.0-dev no longer defeats the version window", async () => {
    // An operator pins this license to >= 5.0.0 (the remote re-licensing / forced-upgrade
    // control). gate.ts short-circuited on isDevBuild BEFORE the window was evaluated, so the
    // control was defeated by a header any caller can type. The bypass is now opt-in.
    await seedTier(h.db, "djdl", "pro", { minVersion: "5.0.0" });
    const { key } = await seedLicenseWithKey(h.db, "djdl", { tierId: "pro" });
    const token = await activate(h, key, "dev-1");

    const honest = await config(h, token, { "x-pkey-version": "1.0.0" });
    expect(honest.status).toBe(403);
    expect(await honest.json()).toMatchObject({ reason: "version-too-old" });

    const bypass = await config(h, token, {
      "x-pkey-version": "0.0.0-dev+abc",
    });
    expect(bypass.status).toBe(403);
    expect(await bypass.json()).toMatchObject({ reason: "version-too-old" });
  });

  it("FIXED (R3-01): the dev bypass is available only to a dev-entitled license", async () => {
    const { key } = await seedLicenseWithKey(h.db, "djdl", {
      channels: ["stable"],
    });
    const token = await activate(h, key, "dev-1");

    const honest = await config(h, token, {
      "x-pkey-version": "9.9.9",
      "x-pkey-channel": "staging",
    });
    expect(honest.status).toBe(403);
    expect(await honest.json()).toMatchObject({
      reason: "channel-not-entitled",
    });

    const bypass = await config(h, token, {
      "x-pkey-version": "0.0.0-dev",
      "x-pkey-channel": "staging",
    });
    expect(bypass.status).toBe(403);

    // An operator who wants local dev unblocked grants the `dev` channel like any other.
    const { key: devKey } = await seedLicenseWithKey(h.db, "djdl", {
      id: "lic_djdl_dev",
      channels: ["stable", "dev"],
    });
    const devToken = await activate(h, devKey, "dev-2");
    expect(
      (
        await config(h, devToken, {
          "x-pkey-version": "0.0.0-dev",
          "x-pkey-channel": "staging",
        })
      ).status,
    ).toBe(200);
  });

  it("FIXED (R3-01): an unrecognised channel header no longer normalises to stable", async () => {
    const { key } = await seedLicenseWithKey(h.db, "djdl", {
      channels: ["stable"],
    });
    const token = await activate(h, key, "dev-1");

    // Was: every one of these normalised to `stable`, the one channel that is never
    // entitlement-checked, so a genuine staging build just declared a word nobody parsed.
    for (const claimed of ["staging-2", "STAGING", "beta"]) {
      const res = await config(h, token, {
        "x-pkey-version": "9.9.9",
        "x-pkey-channel": claimed,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        reason: "channel-not-entitled",
      });
    }
    // A stable build declaring `stable` is of course still fine. Declaring `stable` no longer
    // LAUNDERS a pre-release build, though — see the pr-N case below.
    expect(
      (
        await config(h, token, {
          "x-pkey-version": "9.9.9",
          "x-pkey-channel": "stable",
        })
      ).status,
    ).toBe(200);
  });

  it("FIXED (R3-07): 0.0.0-pr-N is the pr channel to the worker, as it already was to the SDK", async () => {
    // Was: gate.ts  /^0\.0\.0-pr\d+/     → "0.0.0-pr-42" is "stable"
    //      sdk semver.ts:56 /^0\.0\.0-pr-?\d+/ → "0.0.0-pr-42" is "pr"
    // The SDK's form is pinned by sdk-node/test/semver.test.ts:92, so the WORKER moved.
    const sdkSource = readFileSync(
      join(HERE, "..", "..", "..", "sdk-node", "src", "semver.ts"),
      "utf8",
    );
    expect(sdkSource).toContain("/^0\\.0\\.0-pr-?\\d+/");
    expect(channelForVersion("0.0.0-pr-42+abc")).toBe("pr");
    expect(channelForVersion("0.0.0-pr42+abc")).toBe("pr");
    expect(channelForVersion("0.0.0-prfoo")).toBe("stable"); // still needs a digit

    // End to end: both spellings are now channel-checked, and declaring `stable` does not
    // launder either of them.
    await h.db.run("UPDATE products SET compat_min = '' WHERE slug = 'djdl'");
    const product = (await loadProduct(h.env, h.db, "djdl"))!;
    const { key } = await seedLicenseWithKey(h.db, "djdl", {
      channels: ["stable"],
    });
    const res0 = await handleActivate(
      activateReq(key, "dev-pr"),
      h.env,
      h.db,
      product,
      NOW,
    );
    const token = ((await res0.json()) as { token: string }).token;

    for (const version of ["0.0.0-pr-42+sha", "0.0.0-pr42+sha"]) {
      const extras: Record<string, string>[] = [
        {},
        { "x-pkey-channel": "stable" },
      ];
      for (const extra of extras) {
        const res = await handleConfig(
          configReq(token, { "x-pkey-version": version, ...extra }),
          h.env,
          h.db,
          product,
          NOW,
        );
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({
          reason: "channel-not-entitled",
        });
      }
    }

    // A license entitled to `pr` gets both spellings.
    const { key: prKey } = await seedLicenseWithKey(h.db, "djdl", {
      id: "lic_djdl_pr",
      channels: ["stable", "pr"],
    });
    const res1 = await handleActivate(
      activateReq(prKey, "dev-pr2"),
      h.env,
      h.db,
      product,
      NOW,
    );
    const prToken = ((await res1.json()) as { token: string }).token;
    for (const version of ["0.0.0-pr-42+sha", "0.0.0-pr42+sha"]) {
      expect(
        (
          await handleConfig(
            configReq(prToken, { "x-pkey-version": version }),
            h.env,
            h.db,
            product,
            NOW,
          )
        ).status,
      ).toBe(200);
    }
  });

  it("FIXED (R3-13): ordinary words beginning with `pr` are no longer read as the pr channel", () => {
    // `prod`, `production`, `preview` matched the unanchored zero-or-more-digit pattern, so a
    // client that reasonably reported `prod` was refused as an unentitled PR build. They are
    // now simply unrecognised — still refused, but no longer misfiled into a real channel a
    // `pr` entitlement would have satisfied.
    const entitled = (channels: string[]) => ({
      channels: {
        state: "enforced" as const,
        value: channels,
        updatedAt: NOW,
      },
    });
    for (const header of ["prod", "production", "preview", "prerelease"]) {
      const asPr = checkBuildGate({
        version: "1.0.0",
        channelHeader: header,
        entitlements: entitled(["stable", "pr"]),
        compatMin: "0.0.0",
        compatMax: "99.0.0",
      });
      expect(asPr.ok).toBe(false);
      expect(asPr.reason).toBe("channel-not-entitled");
    }
    // Genuine pr spellings still resolve to `pr` and are satisfied by the entitlement.
    for (const header of ["pr", "pr42", "pr-42"]) {
      expect(
        checkBuildGate({
          version: "1.0.0",
          channelHeader: header,
          entitlements: entitled(["stable", "pr"]),
          compatMin: "0.0.0",
          compatMax: "99.0.0",
        }).ok,
      ).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R12-02 read half — `resolveEffective` must OPEN the envelopes that
// admin/lib/overrides.ts now seals, or a managed secret silently stops being
// delivered. Not an R3 attack: a cross-lane regression guard.
// ─────────────────────────────────────────────────────────────────────────────
describe("R12-02 sealed managed secrets survive the read path", () => {
  it("resolveEffective opens a sealed value when given env, and leaves it sealed without", async () => {
    const h = await harness();
    const sealed = await sealManagedValue(h.env, "djdl", "api.token", "s3cret");
    expect(isSealedEnvelope(sealed)).toBe(true);

    const { licenseId } = await seedLicenseWithKey(h.db, "djdl", {
      secrets: {
        "api.token": { state: "enforced", value: sealed, updatedAt: NOW },
      },
    });
    const license = (await getLicense(h.db, "djdl", licenseId))!;
    const policy = { tighterMin, tighterMax };

    // Without env the ciphertext survives — configDoc.validatePayload then prunes it as a
    // schema violation, which is fail-closed but silently drops the secret.
    const blind = await resolveEffective(
      h.db,
      "djdl",
      license,
      null,
      NOW,
      policy,
    );
    expect(blind.secrets["api.token"]!.value).toBe(sealed);

    // With env the plaintext is restored for signing.
    const opened = await resolveEffective(
      h.db,
      "djdl",
      license,
      null,
      NOW,
      policy,
      h.env,
    );
    expect(opened.secrets["api.token"]!.value).toBe("s3cret");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3-02 — seat count is a read-then-write with no transaction.
// ─────────────────────────────────────────────────────────────────────────────
describe("R3-02 seat-limit TOCTOU", () => {
  it("FIXED: concurrent activations are capped at deviceLimit by the DB", async () => {
    const h = await harness();
    await seedTier(h.db, "djdl", "solo", { deviceLimit: 2 });
    const { licenseId, key } = await seedLicenseWithKey(h.db, "djdl", {
      tierId: "solo",
    });

    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        handleActivate(
          activateReq(key, `race-${i}`),
          h.env,
          h.db,
          h.product,
          NOW,
        ),
      ),
    );
    const granted = burst.filter((r) => r.status === 200).length;
    const seats = await countActiveDevices(h.db, "djdl", licenseId);

    // FIXED (R3-02). Was: countActiveDevices() … await … upsertDevice() with no transaction,
    // so all ten racers read count === 0 and all ten committed (granted === seats === 10).
    // `claimDeviceSeat` now takes a seat ordinal arbitrated by `idx_devices_seat`, so a racer
    // that loses the UNIQUE race retries and eventually finds every ordinal taken.
    expect(granted).toBe(2);
    expect(seats).toBe(2);
  });

  it("the same activations serialised are correctly capped (control)", async () => {
    const h = await harness();
    await seedTier(h.db, "djdl", "solo", { deviceLimit: 2 });
    const { licenseId, key } = await seedLicenseWithKey(h.db, "djdl", {
      tierId: "solo",
    });

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await handleActivate(
        activateReq(key, `seq-${i}`),
        h.env,
        h.db,
        h.product,
        NOW,
      );
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 403, 403, 403]);
    expect(await countActiveDevices(h.db, "djdl", licenseId)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3-03 — free-license farming from one machine.
// ─────────────────────────────────────────────────────────────────────────────
describe("R3-03 free-license farming", () => {
  let h: Harness;

  async function setAutoIssue(mode: string, perHour = 10): Promise<void> {
    await h.db.run(
      "UPDATE products SET auto_issue_json = ? WHERE slug = ?",
      JSON.stringify({
        enabled: true,
        tierId: "free",
        mode,
        rateLimitPerHour: perHour,
      }),
      "djdl",
    );
    h.product = (await loadProduct(h.env, h.db, "djdl"))!;
  }

  async function enroll(
    components: Record<string, string>,
    device: string,
  ): Promise<Response> {
    return handleEnroll(
      mkReq(
        "POST",
        { "x-pkey-device": device },
        { fingerprint: { components, hwid: "forged" } },
      ),
      h.env,
      h.db,
      h.product,
      NOW,
    );
  }

  beforeEach(async () => {
    h = await harness();
    await seedTier(h.db, "djdl", "free", { deviceLimit: 2 });
  });

  it("FIXED (R3-03): varying the submitted component subset yields ONE license", async () => {
    // The seat limit is raised out of the way: now that every subset lands on ONE license,
    // the free tier's 2 seats would otherwise be what refuses the 3rd attempt, and this test
    // is about license identity, not seats.
    await h.db.run(
      "UPDATE tiers SET policy_device_limit = 20 WHERE product = 'djdl' AND id = 'free'",
    );
    await setAutoIssue("anonymous");

    // Same physical machine every time — only the *reported subset* changes. Was: computeHwid
    // digested only the present components and parseFingerprint accepted any non-empty subset,
    // so each subset was a brand-new "machine" and earned its own free license (7 here; 2^7-1
    // = 127 reachable in all). The dedupe key is now computed over the anchor alone, so every
    // subset that contains it collapses onto the same license.
    const keys = Object.keys(MACHINE) as (keyof typeof MACHINE)[];
    const licenses = new Set<string>();
    for (let i = 0; i < keys.length; i++) {
      const subset = { ...MACHINE };
      delete subset[keys[i]!];
      const res = await enroll(subset, `farm-${i}`);
      if (keys[i] === "machineUuid") {
        // Dropping the ANCHOR makes the submission undedupable, so it is refused outright
        // rather than minted a license.
        expect(res.status).toBe(403);
        continue;
      }
      expect(res.status).toBe(200);
      const body = (await res.json()) as { license: { id: string } };
      licenses.add(body.license.id);
    }
    expect(licenses.size).toBe(1);

    // The full set lands on that same license too.
    const full = await enroll(MACHINE, "farm-full");
    expect(full.status).toBe(200);
    expect(
      ((await full.json()) as { license: { id: string } }).license.id,
    ).toBe([...licenses][0]);

    // A DIFFERENT machine still gets its own license — the key discriminates, it is not
    // constant.
    const other = await enroll(
      { ...MACHINE, machineUuid: hash("other-uuid") },
      "farm-other",
    );
    expect(
      ((await other.json()) as { license: { id: string } }).license.id,
    ).not.toBe([...licenses][0]);
  });

  // FIXED (R3-05): neither `claimEnrolledLicense` nor the OIDC merge arm clears
  // `enroll_hwid` any more, so the retired/claimed row goes on occupying
  // `idx_licenses_enroll_hwid` — the only guard on "one free license per machine". The
  // enrol→sign-in→enrol loop that minted unbounded free licenses from one machine is closed
  // in both arms, and `/enroll` refuses rather than handing the anonymous caller a licence
  // that now carries somebody's identity.
  it("an OIDC sign-in no longer re-frees enroll_hwid; the machine cannot enroll again", async () => {
    await setAutoIssue("both");
    const identity = {
      sub: "user-1",
      email: "u1@example.com",
      name: "U One",
      groups: [] as string[],
      claims: {} as Record<string, unknown>,
    };

    const first = (await (await enroll(MACHINE, "dev-A")).json()) as {
      license: { id: string };
    };
    const claim = await activateFromIdentity(h.db, h.product, identity, NOW, {
      enrolledLicenseId: first.license.id,
    });
    expect(claim).toMatchObject({ merged: "claimed" });
    expect(
      (await getLicense(h.db, "djdl", first.license.id))?.enroll_hwid,
    ).toBeTruthy();

    // The claim arm: a second enrolment from the same machine is refused, and does NOT hand
    // back the now-identity-owned licence either.
    const second = await enroll(MACHINE, "dev-B");
    expect(second.status).toBe(403);
    expect(((await second.json()) as { error: string }).error).toBe(
      "enroll_claimed",
    );

    // The migrate arm: give the identity a second licence to merge INTO, retire the enrolled
    // row through the merge path, and confirm the machine still cannot enrol.
    const other = { ...identity, sub: "user-2", email: "u2@example.com" };
    await activateFromIdentity(h.db, h.product, other, NOW);
    const third = await enroll(MACHINE, "dev-C");
    expect(third.status).toBe(403);

    // Exactly ONE licence was ever auto-issued to this machine.
    const enrolled = await h.db.all<{ id: string }>(
      "SELECT id FROM licenses WHERE product = 'djdl' AND origin = 'enroll' OR enroll_hwid IS NOT NULL",
    );
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0]!.id).toBe(first.license.id);
  });

  it("FIXED (R3-06): auto-issued licenses honour the tier's expiry policy", async () => {
    await h.db.run(
      "UPDATE tiers SET policy_expiry_days = 7 WHERE product = 'djdl' AND id = 'free'",
    );
    await setAutoIssue("both");

    const res = await enroll(MACHINE, "trial-1");
    const body = (await res.json()) as { license: { id: string } };
    const enrolled = await getLicense(h.db, "djdl", body.license.id);
    // Was: enroll.ts hardcoded expires_at: null, so the 7-day trial never ended.
    expect(enrolled?.expires_at).toBe(NOW + 7 * 86400);

    // The OIDC path on the SAME tier agrees — the two paths no longer diverge.
    const viaOidc = await activateFromIdentity(
      h.db,
      h.product,
      {
        sub: "user-2",
        email: "u2@example.com",
        name: "U Two",
        groups: [],
        claims: {},
      },
      NOW,
      {},
    );
    const oidcLicense = await getLicense(
      h.db,
      "djdl",
      (viaOidc as { licenseId: string }).licenseId,
    );
    expect(oidcLicense?.expires_at).toBe(NOW + 7 * 86400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3-05 — hardware binding is never re-verified after activation.
// ─────────────────────────────────────────────────────────────────────────────
describe("R3-05 fingerprint is activation-only", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  it("an exfiltrated device token works from any machine, on every authenticated surface", async () => {
    const { key } = await seedLicenseWithKey(h.db, "djdl", {
      secrets: {},
      entitlements: {
        polarisVpn: { state: "enforced", value: true, updatedAt: NOW },
      },
    });
    const token = await activate(h, key, "victim-mac", MACHINE);
    const bound = await getFingerprint(h.db, "djdl", "victim-mac");
    expect(bound?.status).toBe("verified");

    // The attacker copies the token file onto an unrelated Windows box. No endpoint below
    // accepts, let alone checks, a fingerprint — matchFingerprint has exactly one call site
    // (licenseCore.ts:290), inside authorizeDevice.
    const alien = {
      "x-pkey-device": "victim-mac",
      "x-pkey-platform": "win32",
      "x-pkey-arch": "x64",
      "user-agent": "attacker/1.0",
    };

    const cfg = await config(h, token, alien);
    expect(cfg.status).toBe(200);
    expect((await docOf(cfg)).payload.entitlements).toHaveProperty(
      "polarisVpn",
    );

    expect(
      (
        await handleAccount(
          mkReq("GET", { authorization: `Bearer ${token}`, ...alien }),
          h.env,
          h.db,
          h.product,
          NOW,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleDevices(
          mkReq("GET", { authorization: `Bearer ${token}`, ...alien }),
          h.env,
          h.db,
          h.product,
          NOW,
        )
      ).status,
    ).toBe(200);

    // Rotation keeps the stolen session alive indefinitely, still with no hardware check.
    const rot = await handleToken(
      mkReq("POST", { authorization: `Bearer ${token}`, ...alien }),
      h.env,
      h.db,
      h.product,
      NOW,
    );
    expect(rot.status).toBe(200);
    const rotated = ((await rot.json()) as { token: string }).token;
    expect((await config(h, rotated, alien)).status).toBe(200);

    // The stored binding is byte-identical: nothing ever looked at it.
    const after = await getFingerprint(h.db, "djdl", "victim-mac");
    expect(after?.components_json).toBe(bound?.components_json);
  });

  it("FIXED (R3-11): one machine holds ONE seat however many device ids it invents", async () => {
    await seedTier(h.db, "djdl", "team", { deviceLimit: 5 });
    const { licenseId, key } = await seedLicenseWithKey(h.db, "djdl", {
      tierId: "team",
    });

    // Was: five activations from ONE machine took five of the five seats, because the seat
    // check keys on `X-PKey-Device` — a client-chosen string — and `findFingerprintByHwid`,
    // the only query that would have noticed the five identical server-computed hwids, had
    // zero callers in src/. It is now called: the newest device id wins and the stale ones
    // are retired, so the machine converges on a single seat.
    for (let i = 0; i < 5; i++) {
      await activate(h, key, `clone-${i}`, MACHINE);
    }
    expect(await countActiveDevices(h.db, "djdl", licenseId)).toBe(1);

    const live = await listDevicesByLicense(h.db, "djdl", licenseId);
    expect(
      live.filter((d) => d.status === "authorized").map((d) => d.device_id),
    ).toEqual(["clone-4"]);

    // The retired ids had their fingerprint rows purged along with their seats.
    expect(await getFingerprint(h.db, "djdl", "clone-0")).toBeNull();
    const survivor = (await getFingerprint(h.db, "djdl", "clone-4"))!;
    expect(
      await findFingerprintByHwid(h.db, "djdl", survivor.hwid),
    ).not.toBeNull();

    // Genuinely different hardware still takes its own seats, up to the limit.
    for (let i = 0; i < 4; i++) {
      await activate(h, key, `real-${i}`, {
        ...MACHINE,
        machineUuid: hash(`uuid-${i}`),
        boardSerial: hash(`board-${i}`),
      });
    }
    expect(await countActiveDevices(h.db, "djdl", licenseId)).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3-06 / R3-07 — the entitlement layer is never pruned, and the seat check uses
// a different layer stack than /config.
// ─────────────────────────────────────────────────────────────────────────────
describe("R3-06 entitlement layer is unpruned and self-authoritative", () => {
  it("a stored deviceLimit entitlement overrides the product cap when no tier policy exists", async () => {
    const h = await harness();
    // No tier → injectAdminPolicy (licenseCore.ts:126) never overwrites deviceLimit, so the
    // merged override is authoritative for the seat check.
    const { licenseId, key } = await seedLicenseWithKey(h.db, "djdl", {
      entitlements: {
        deviceLimit: { state: "enforced", value: 99, updatedAt: NOW },
      },
    });
    for (let i = 0; i < 8; i++) {
      await activate(h, key, `over-${i}`);
    }
    // product.default_device_limit is 5.
    expect(h.product.defaultDeviceLimit).toBe(5);
    expect(await countActiveDevices(h.db, "djdl", licenseId)).toBe(8);
  });

  it("a stored channels entitlement grants pre-release access with no tier or license policy", async () => {
    const h = await harness();
    const { key } = await seedLicenseWithKey(h.db, "djdl", {
      entitlements: {
        channels: { state: "enforced", value: ["staging"], updatedAt: NOW },
      },
    });
    const token = await activate(h, key, "chan-1");
    const res = await config(h, token, {
      "x-pkey-version": "9.9.9",
      "x-pkey-channel": "staging",
    });
    expect(res.status).toBe(200);
  });

  it("undeclared entitlement keys survive validatePayload into the signed doc", async () => {
    const h = await harness(DJDL_CATALOG);
    const { key } = await seedLicenseWithKey(h.db, "djdl", {
      config: {
        "not.in.catalog": { state: "enforced", value: "x", updatedAt: NOW },
        "quality.floor": { state: "enforced", value: "flac", updatedAt: NOW },
      },
      entitlements: {
        "not.in.catalog.either": {
          state: "enforced",
          value: { arbitrary: "json" },
          updatedAt: NOW,
        },
      },
    });
    const token = await activate(h, key, "cat-1");
    const doc = await docOf(
      await config(h, token, { "x-pkey-version": "1.0.0" }),
    );

    // configDoc.ts:53 — config is pruned against the catalog, entitlements are not.
    expect(doc.payload.config).not.toHaveProperty("not.in.catalog");
    expect(doc.payload.config["quality.floor"]).toBeTruthy();
    expect(doc.payload.entitlements["not.in.catalog.either"]).toEqual({
      state: "enforced",
      value: { arbitrary: "json" },
      updatedAt: NOW,
    });
  });

  it("R3-07 the seat check ignores the device layer that /config merges", async () => {
    const h = await harness();
    const { licenseId, key } = await seedLicenseWithKey(h.db, "djdl");
    const token = await activate(h, key, "layer-1");
    await h.db.run(
      "UPDATE devices SET overrides_json = ? WHERE product = 'djdl' AND device_id = 'layer-1'",
      JSON.stringify({
        config: {},
        secrets: {},
        entitlements: {
          deviceLimit: { state: "enforced", value: 1, updatedAt: NOW },
        },
      }),
    );

    // /config merges the device layer (licensing.ts:497-504) and reports a limit of 1...
    const doc = await docOf(
      await config(h, token, { "x-pkey-version": "1.0.0" }),
    );
    expect(doc.payload.entitlements.deviceLimit).toMatchObject({ value: 1 });

    // ...while the seat check resolves with device = null (licenseCore.ts:341) and lets more
    // devices on.
    await activate(h, key, "layer-2");
    expect(await countActiveDevices(h.db, "djdl", licenseId)).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3-08 — unthrottled license-key oracle.
// ─────────────────────────────────────────────────────────────────────────────
describe("R3-08 POST /<product>/session/license rate limit", () => {
  it("FIXED: the key oracle is now capped at the same 30/min budget as /activate", async () => {
    const h = await harness();

    // FIXED (R3-08). This endpoint takes an attacker-suppliable license key and reports
    // whether it is valid — the same key→credential exchange `/activate` performs — but it
    // had no limiter at all, so it was an unthrottled guessing oracle for the whole key
    // space. It now shares `/activate`'s 30/min per-IP budget.
    const sessionStatuses: number[] = [];
    for (let i = 0; i < 120; i++) {
      const res = await handleBrowserSessionLicense(
        mkReq("POST", {}, { key: `pkey_djdl_guess${i}` }),
        h.env,
        h.db,
        h.product,
        NOW,
      );
      sessionStatuses.push(res.status);
    }
    // The first 30 guesses are answered (401 — wrong key); the remaining 90 are refused
    // without the key ever being looked up.
    expect(sessionStatuses.filter((s) => s === 401).length).toBe(30);
    expect(sessionStatuses.filter((s) => s === 429).length).toBe(90);

    const activateStatuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await handleActivate(
        activateReq(`pkey_djdl_guess${i}`, "probe"),
        h.env,
        h.db,
        h.product,
        NOW,
      );
      activateStatuses.push(res.status);
    }
    expect(activateStatuses.filter((s) => s === 429).length).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3-09 — any device token can evict every sibling seat on the license.
// ─────────────────────────────────────────────────────────────────────────────
describe("R3-09 sibling seat eviction", () => {
  // FIXED (R3-09): a device token authenticates ONE device, not the licence. `handleDevices`
  // used to resolve the target purely by "shares the licence", so any install could
  // deauthorize (and, via setDeviceStatus, purge the fingerprint of) every sibling, or
  // relabel it. Both mutating arms now require `deviceId === valid.device.device_id`.
  it("a device token can no longer deauthorize or relabel a sibling", async () => {
    const h = await harness();
    const { licenseId, key } = await seedLicenseWithKey(h.db, "djdl");
    const mine = await activate(h, key, "attacker");
    const theirs = await activate(h, key, "colleague");
    expect(await countActiveDevices(h.db, "djdl", licenseId)).toBe(2);

    const kill = await handleDevices(
      mkReq("DELETE", { authorization: `Bearer ${mine}` }),
      h.env,
      h.db,
      h.product,
      NOW,
      "colleague",
    );
    expect(kill.status).toBe(403);

    // The victim is untouched: still authorized, still holding its seat.
    expect((await config(h, theirs)).status).toBe(200);
    expect(await countActiveDevices(h.db, "djdl", licenseId)).toBe(2);

    const relabel = await handleDevices(
      mkReq(
        "PATCH",
        { authorization: `Bearer ${mine}` },
        { label: "pwned-by-attacker" },
      ),
      h.env,
      h.db,
      h.product,
      NOW,
      "colleague",
    );
    expect(relabel.status).toBe(403);
    const rows = await listDevicesByLicense(h.db, "djdl", licenseId);
    expect(rows.find((r) => r.device_id === "colleague")?.label).toBeNull();
  });

  it("self-service on the caller's OWN device still works, and GET still lists siblings", async () => {
    const h = await harness();
    const { licenseId, key } = await seedLicenseWithKey(h.db, "djdl");
    const mine = await activate(h, key, "attacker");
    await activate(h, key, "colleague");

    const list = await handleDevices(
      mkReq("GET", { authorization: `Bearer ${mine}` }),
      h.env,
      h.db,
      h.product,
      NOW,
    );
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { devices: unknown[] }).devices,
    ).toHaveLength(2);

    const relabel = await handleDevices(
      mkReq("PATCH", { authorization: `Bearer ${mine}` }, { label: "laptop" }),
      h.env,
      h.db,
      h.product,
      NOW,
      "attacker",
    );
    expect(relabel.status).toBe(200);

    const bye = await handleDevices(
      mkReq("DELETE", { authorization: `Bearer ${mine}` }),
      h.env,
      h.db,
      h.product,
      NOW,
      "attacker",
    );
    expect(bye.status).toBe(200);
    expect(await countActiveDevices(h.db, "djdl", licenseId)).toBe(1);
  });
});
