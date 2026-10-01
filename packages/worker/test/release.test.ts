import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, seedProduct } from "./seed.js";
import type { Db } from "../src/db/types.js";
import type { Product } from "../src/core/products.js";
import {
  DEFAULT_AUTO_ISSUE,
  DEFAULT_FINGERPRINT_POLICY,
} from "../src/fingerprint.js";
import { DEFAULT_SERVICES } from "../src/core/services.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import {
  classifyChannel,
  parseManualChannels,
  resolveChannel,
} from "../src/services/release/channels.js";
import type { Release, ReleaseAsset } from "../src/services/release/github.js";
import { findBinaryAsset, matchAsset } from "../src/services/release/assets.js";
import { entitledSelectorFor } from "../src/services/release/access.js";
import type { ReleaseConfigRow } from "../src/services/release/config.js";
import { extractSummary } from "../src/services/release/changelog.js";
import {
  applyInstallTemplate,
  defaultInstallScript,
} from "../src/services/release/install.js";
import { renderAppcast } from "../src/services/update/appcast.js";
import {
  handleReleaseSurface as handleRelease,
  seedDeliveryAccess,
} from "./releaseSurface.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { checkReleaseHealth } from "../src/services/release/health.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const SLUG = "djdl";

function asset(name: string, id = name.length, size = 1024): ReleaseAsset {
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

/** Seed the product + its release_config (release_config.product FKs to products). */
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
    manual_channels_json: JSON.stringify([
      { name: "nightly", regex: "v\\d+\\.\\d+\\.\\d+-nightly\\.\\d+" },
    ]),
    binary_name: "djdl",
    install_template: null as string | null,
    sparkle_ed25519_pub: "PUBKEY==",
    summary_marker: "pkey:summary",
    artifact_policy_json: null as string | null,
    metadata_access: "public",
    artifacts_access: "public",
    operator_policy_json: null as string | null,
    ...over,
  };
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker,
        artifact_policy_json, metadata_access, artifacts_access, operator_policy_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
    row.operator_policy_json,
  );  await seedDeliveryAccess(db, row.product, row.artifacts_access);
}

function makeProduct(): Product {
  return {
    slug: SLUG,
    name: "djdl",
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
    webOrigins: [],
  };
}

/**
 * A fetch stub. `routes` maps a URL substring -> a response builder. The GitHub App
 * token exchange is always answered so the engine can mint a token; everything else is
 * matched by substring (first hit wins).
 */
function stubFetch(routes: Array<[string, () => Response]>): {
  fetchImpl: FetchImpl;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
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

function envFor(): { env: Env; kv: KvMock } {
  const kv = new KvMock();
  const env = makeEnv(kv, [SLUG]);
  env.GITHUB_APP_ID = "12345";
  // A throwaway 2048-bit RSA key so the App-JWT signer actually runs (WebCrypto imports
  // it); the fetch stub then shortcuts the installation-token exchange. Never a prod key.
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return { env, kv };
}

// ── Pure unit tests ─────────────────────────────────────────────────────────

describe("channels", () => {
  const manual = parseManualChannels(
    JSON.stringify([
      { name: "nightly", regex: "v\\d+\\.\\d+\\.\\d+-nightly\\.\\d+" },
    ]),
  );

  it("classifies stable / beta / pr / manual selectors", () => {
    expect(classifyChannel("latest", manual)?.kind).toBe("stable");
    expect(classifyChannel("1.2.3", manual)?.kind).toBe("stable");
    expect(classifyChannel("beta", manual)?.kind).toBe("beta");
    const pr = classifyChannel("pr-42", manual);
    expect(pr?.kind).toBe("pr");
    expect(pr?.pr).toBe(42);
    expect(classifyChannel("nightly", manual)?.kind).toBe("manual");
    expect(classifyChannel("bogus", manual)).toBeNull();
  });

  it("resolves stable latest to the newest non-prerelease", () => {
    const releases = [
      release({ tag_name: "v2.0.0-rc.1", prerelease: true }),
      release({ tag_name: "v1.9.0", prerelease: false }),
    ];
    const sel = classifyChannel("latest", manual)!;
    expect(resolveChannel(sel, releases)?.tag_name).toBe("v1.9.0");
  });

  it("resolves a pinned tag exactly", () => {
    const releases = [
      release({ tag_name: "v1.2.3" }),
      release({ tag_name: "v1.0.0" }),
    ];
    const sel = classifyChannel("1.0.0", manual)!;
    expect(resolveChannel(sel, releases)?.tag_name).toBe("v1.0.0");
  });

  it("resolves a manual regex channel to the newest matching tag", () => {
    const releases = [
      release({ tag_name: "v1.3.0" }),
      release({ tag_name: "v1.3.0-nightly.7", prerelease: true }),
      release({ tag_name: "v1.3.0-nightly.5", prerelease: true }),
    ];
    const sel = classifyChannel("nightly", manual)!;
    expect(resolveChannel(sel, releases)?.tag_name).toBe("v1.3.0-nightly.7");
  });

  it("resolves beta via channel tags, else falls back to newest prerelease", () => {
    const releases = [
      release({ tag_name: "v2.0.0-beta.2", prerelease: true }),
      release({ tag_name: "v2.0.0-beta.1", prerelease: true }),
    ];
    const sel = classifyChannel("beta", manual)!;
    expect(
      resolveChannel(sel, releases, new Set(["v2.0.0-beta.1"]))?.tag_name,
    ).toBe("v2.0.0-beta.1");
    expect(resolveChannel(sel, releases)?.tag_name).toBe("v2.0.0-beta.2");
  });

  it("classifies staging as the beta alias, after the manual names (P0-04 §5.1 rule 6)", () => {
    // No manual `staging`: the alias resolves by kind, keeping the requested spelling (D8).
    expect(classifyChannel("staging", manual)).toEqual({
      kind: "beta",
      raw: "staging",
    });
    const releases = [
      release({ tag_name: "v2.0.0-beta.2", prerelease: true }),
      release({ tag_name: "v2.0.0-beta.1", prerelease: true }),
    ];
    expect(
      resolveChannel(classifyChannel("staging", manual)!, releases)?.tag_name,
    ).toBe(
      resolveChannel(classifyChannel("beta", manual)!, releases)?.tag_name,
    );

    // A declared manual `staging` wins over the alias.
    const withStaging = parseManualChannels(
      JSON.stringify([
        { name: "staging", regex: "v\\d+\\.\\d+\\.\\d+-rc\\.\\d+" },
      ]),
    );
    expect(classifyChannel("staging", withStaging)?.kind).toBe("manual");
    // `latest` is still the stable alias; nothing else is aliased.
    expect(classifyChannel("latest", [])?.kind).toBe("stable");
    expect(classifyChannel("Staging", [])).toBeNull();
  });

  it("entitledSelectorFor sends the canonical channel (P0-04)", () => {
    const cfg = (manualJson: string | null): ReleaseConfigRow => ({
      product: SLUG,
      gh_owner: null,
      gh_repo: null,
      gh_installation_id: null,
      channel_workflow: null,
      beta_branch: "main",
      manual_channels_json: manualJson,
      binary_name: null,
      install_template: null,
      sparkle_ed25519_pub: null,
      summary_marker: "",
      artifact_policy_json: null,
    });
    const plain = cfg(null);
    const nightly = cfg(
      JSON.stringify([{ name: "nightly", regex: "v\\d+-nightly" }]),
    );
    const staging = cfg(
      JSON.stringify([{ name: "staging", regex: "v\\d+-rc" }]),
    );
    expect(entitledSelectorFor(plain, "dmg", { version: "latest" })).toEqual({
      channel: "stable",
      version: null,
    });
    expect(entitledSelectorFor(plain, "dmg", { version: "1.2.3" })).toEqual({
      channel: "stable",
      version: "1.2.3",
    });
    expect(
      entitledSelectorFor(plain, "channelAppcast", { channel: "beta" }),
    ).toEqual({ channel: "beta", version: null });
    expect(
      entitledSelectorFor(plain, "channelAppcast", { channel: "staging" }),
    ).toEqual({ channel: "beta", version: null });
    expect(
      entitledSelectorFor(staging, "channelAppcast", { channel: "staging" }),
    ).toEqual({ channel: "staging", version: null });
    expect(entitledSelectorFor(plain, "dmg", { version: "pr-42" })).toEqual({
      channel: "pr-42",
      version: null,
    });
    expect(
      entitledSelectorFor(nightly, "channelAppcast", { channel: "nightly" }),
    ).toEqual({ channel: "nightly", version: null });
    expect(entitledSelectorFor(plain, "dmg", { version: "bogus" })).toEqual({
      channel: "bogus",
      version: null,
    });
  });

  it("entitledSelectorFor pins a fixed release's stored version, whatever it spells (P2-05)", () => {
    const nightly: ReleaseConfigRow = {
      product: SLUG,
      gh_owner: null,
      gh_repo: null,
      gh_installation_id: null,
      channel_workflow: null,
      beta_branch: "main",
      manual_channels_json: JSON.stringify([
        { name: "nightly", regex: "nightly" },
      ]),
      binary_name: null,
      install_template: null,
      sparkle_ed25519_pub: null,
      summary_marker: "",
      artifact_policy_json: null,
    };
    // A stored version that spells a moving selector is still one fixed release: pinned, so the
    // window applies (and refuses it when bounded, since it is not semver).
    for (const stored of [
      "latest",
      "stable",
      "beta",
      "staging",
      "pr-5",
      "nightly",
      "",
    ]) {
      for (const kind of ["file", "blob"] as const) {
        expect(
          entitledSelectorFor(nightly, kind, { fixedVersion: stored }),
          `${kind} ${stored}`,
        ).toEqual({ channel: "stable", version: stored });
      }
    }
    expect(
      entitledSelectorFor(nightly, "file", {
        fixedVersion: "v1.2.0",
        version: "latest",
        channel: "beta",
      }),
    ).toEqual({ channel: "stable", version: "1.2.0" });
  });

  it("rejects an over-long / unsafe manual regex", () => {
    const bad = parseManualChannels(
      JSON.stringify([{ name: "x", regex: "a".repeat(200) }]),
    );
    expect(bad).toHaveLength(0);
    const broken = parseManualChannels(
      JSON.stringify([{ name: "x", regex: "(" }]),
    );
    expect(broken).toHaveLength(0);
  });
});

describe("assets", () => {
  it("matches the correct arch + extension", () => {
    const assets = [
      asset("djdl-arm64.dmg"),
      asset("djdl-x86_64.dmg"),
      asset("djdl-arm64"),
      asset("djdl-x86_64"),
    ];
    expect(
      matchAsset(assets, { arch: "arm64", ext: "dmg", binaryName: "djdl" })
        ?.name,
    ).toBe("djdl-arm64.dmg");
    expect(
      matchAsset(assets, { arch: "x86_64", ext: "dmg", binaryName: "djdl" })
        ?.name,
    ).toBe("djdl-x86_64.dmg");
    expect(findBinaryAsset(assets, "djdl", "arm64")?.name).toBe("djdl-arm64");
  });

  it("accepts arch aliases (aarch64 / amd64)", () => {
    const assets = [
      asset("MyApp-1.2.3-aarch64.dmg"),
      asset("MyApp-1.2.3-amd64.dmg"),
    ];
    expect(matchAsset(assets, { arch: "arm64", ext: "dmg" })?.name).toBe(
      "MyApp-1.2.3-aarch64.dmg",
    );
    expect(matchAsset(assets, { arch: "x86_64", ext: "dmg" })?.name).toBe(
      "MyApp-1.2.3-amd64.dmg",
    );
  });

  it("returns null when ambiguous", () => {
    // Two arm64 dmgs with no distinguishing binary/channel token -> ambiguous.
    const assets = [asset("build-one-arm64.dmg"), asset("build-two-arm64.dmg")];
    expect(matchAsset(assets, { arch: "arm64", ext: "dmg" })).toBeNull();
  });

  it("disambiguates a channel build by suffix", () => {
    const assets = [asset("djdl-arm64"), asset("djdl-staging-arm64")];
    expect(findBinaryAsset(assets, "djdl", "arm64", "staging")?.name).toBe(
      "djdl-staging-arm64",
    );
    expect(findBinaryAsset(assets, "djdl", "arm64")?.name).toBe("djdl-arm64");
  });

  it("a request naming no channel passes over beta-tagged assets too (P0-04)", () => {
    // Was a tie (both score 0 for the channel half), so a stable DMG request returned null.
    const assets = [
      asset("djdl-1.0.0-arm64.dmg"),
      asset("djdl-beta-1.0.0-arm64.dmg"),
    ];
    expect(
      matchAsset(assets, { arch: "arm64", ext: "dmg", binaryName: "djdl" })
        ?.name,
    ).toBe("djdl-1.0.0-arm64.dmg");
    expect(
      matchAsset(assets, {
        arch: "arm64",
        ext: "dmg",
        binaryName: "djdl",
        channelSuffix: "beta",
      })?.name,
    ).toBe("djdl-beta-1.0.0-arm64.dmg");
  });
});

describe("changelog", () => {
  it("extracts the marker block", () => {
    const body =
      "Intro line.\n\n<!-- pkey:summary -->\n**New:** thing\n<!-- /pkey:summary -->\n\n## Changes\n- detail";
    expect(extractSummary(body)).toBe("New: thing");
  });

  it("honors a custom marker token", () => {
    const body =
      "<!-- co:notes -->Custom summary<!-- /co:notes -->\n## Changes";
    expect(extractSummary(body, "co:notes")).toBe("Custom summary");
  });

  it("falls back to the first paragraph above the first heading", () => {
    const body =
      "A friendly summary paragraph that users see.\n\n## Detailed changes\n- nerdy detail";
    expect(extractSummary(body)).toBe(
      "A friendly summary paragraph that users see.",
    );
  });

  it("returns null with no usable prose", () => {
    expect(extractSummary("## Only headings\n## More")).toBeNull();
    expect(extractSummary(null)).toBeNull();
  });
});

describe("install templating", () => {
  it("substitutes the supported placeholders", () => {
    const out = applyInstallTemplate(
      "install {{binaryName}} from {{origin}} channels={{channels}}",
      {
        origin: "https://key.plrs.im",
        cliBase: "/djdl/release/dl",
        installPath: "/djdl/release/install.sh",
        binaryName: "djdl",
        channels: ["staging", "beta"],
        versionEnv: "DJDL_VERSION",
      },
    );
    expect(out).toBe(
      "install djdl from https://key.plrs.im channels=staging beta",
    );
  });

  it("ports arch detection in the default script", () => {
    const script = defaultInstallScript({
      origin: "https://key.plrs.im",
      cliBase: "/djdl/release/dl",
      installPath: "/djdl/release/install.sh",
      binaryName: "djdl",
      channels: ["staging"],
      versionEnv: "DJDL_VERSION",
    });
    expect(script).toContain('arm64|aarch64) ARCH="arm64"');
    expect(script).toContain('x86_64|amd64)  ARCH="x86_64"');
    expect(script).toContain("$ORIGIN$CLI_BASE/$VERSION/djdl-$ARCH");
  });
});

describe("appcast XML", () => {
  it("renders a stable Sparkle feed (snapshot)", () => {
    const xml = renderAppcast({
      channelTitle: "djdl",
      link: "https://key.plrs.im",
      items: [
        {
          title: "djdl 1.2.3",
          shortVersion: "1.2.3",
          build: "1.2.3",
          url: "https://key.plrs.im/djdl/release/dl/1.2.3/djdl-arm64.dmg",
          length: 12345,
          pubDate: "Thu, 02 Jan 2026 03:04:05 GMT",
          edSignature: "ABCDEF==",
          minimumSystemVersion: "13.0",
        },
      ],
    });
    expect(xml).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="utf-8"?>
      <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel>
          <title>djdl</title>
          <link>https://key.plrs.im</link>
          <item>
            <title>djdl 1.2.3</title>
            <pubDate>Thu, 02 Jan 2026 03:04:05 GMT</pubDate>
            <sparkle:version>1.2.3</sparkle:version>
            <sparkle:shortVersionString>1.2.3</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>
            <enclosure url="https://key.plrs.im/djdl/release/dl/1.2.3/djdl-arm64.dmg" type="application/octet-stream" length="12345" sparkle:edSignature="ABCDEF==" />
          </item>
        </channel>
      </rss>
      "
    `);
  });
});

// ── End-to-end handler tests (injected fetch, no network) ────────────────────

describe("handleRelease", () => {
  it("404s when the product has no release config", async () => {
    const db = makeTestDb();
    const { env } = envFor();
    const { fetchImpl } = stubFetch([]);
    const res = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "version",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(404);
  });

  it("serves /version for latest via the App token", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const { env } = envFor();
    const releases = [
      release({ tag_name: "v1.9.0" }),
      release({ tag_name: "v1.0.0" }),
    ];
    const { fetchImpl, calls } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify(releases), { status: 200 }),
      ],
    ]);
    const res = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "version",
      { version: "latest" },
      fetchImpl,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; tag: string };
    expect(body.version).toBe("1.9.0");
    expect(calls.some((u) => u.includes("/access_tokens"))).toBe(true);
  });

  it("renders /changelog with curated summaries", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const { env } = envFor();
    const releases = [
      release({
        tag_name: "v1.1.0",
        body: "<!-- pkey:summary -->Faster sync<!-- /pkey:summary -->\n## Changes",
      }),
      release({
        tag_name: "v1.0.0",
        body: "Initial public release.\n\n## Changes",
      }),
    ];
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify(releases), { status: 200 }),
      ],
    ]);
    const res = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "changelog",
      {},
      fetchImpl,
    );
    const body = (await res.json()) as {
      entries: Array<{ version: string; summary: string | null }>;
    };
    expect(body.entries[0]).toMatchObject({
      version: "1.1.0",
      summary: "Faster sync",
    });
    expect(body.entries[1]?.summary).toBe("Initial public release.");
  });

  it("serves the install script with the product binary name", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const { env } = envFor();
    const { fetchImpl } = stubFetch([]);
    const res = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "install",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("djdl installer");
    // Shell-quoted literals, not double-quoted interpolations (R6-01).
    expect(text).toContain("CLI_BASE='/djdl/release/dl'");
    expect(text).toContain("$ORIGIN$CLI_BASE/$VERSION/djdl-$ARCH");
  });

  it("streams a cli binary asset", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const { env } = envFor();
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
          new Response("BINARY", {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          }),
      ],
    ]);
    const res = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "cli",
      { version: "1.2.3", arch: "arm64" },
      fetchImpl,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("BINARY");
  });

  it("can gate artifact downloads by entitlement policy while metadata stays public", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, {
      artifacts_access: "licensed",
    });
    const { env } = envFor();
    const { fetchImpl, calls } = stubFetch([
      [
        "/releases?per_page",
        () =>
          new Response(JSON.stringify([release({ tag_name: "v1.2.3" })]), {
            status: 200,
          }),
      ],
    ]);

    const version = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "version",
      { version: "latest" },
      fetchImpl,
    );
    expect(version.status).not.toBe(401);

    const binary = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "cli",
      { version: "1.2.3", arch: "arm64" },
      fetchImpl,
    );
    expect(binary.status).toBe(401);
    expect(await binary.json()).toMatchObject({
      error: "download_auth_required",
    });
    expect(calls.some((url) => url.includes("/releases/tags"))).toBe(false);
  });

  it("generates an appcast reading the sibling .sig asset", async () => {
    const db = makeTestDb();
    // The gateway now Ed25519-verifies the sidecar against `sparkle_ed25519_pub` over the
    // DMG's own bytes (R6-03), so the fixture carries a real keypair and a real signature.
    const dmgBytes = new TextEncoder().encode("DMG-BYTES");
    const { publicKeyB64, signatureB64 } = await signFixture(dmgBytes);
    await seedReleaseConfig(db, { sparkle_ed25519_pub: publicKeyB64 });
    const { env } = envFor();
    const rel = release({
      tag_name: "v1.2.3",
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
      ["/releases/assets/101", () => new Response(signatureB64)],
      [
        "/releases/assets/100",
        () => new Response(dmgBytes as unknown as BodyInit),
      ],
    ]);
    const res = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "appcast",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`sparkle:edSignature="${signatureB64}"`);
    expect(xml).toContain("/djdl/release/dl/1.2.3/djdl-arm64.dmg");
    expect(xml).toContain(
      "<sparkle:shortVersionString>1.2.3</sparkle:shortVersionString>",
    );
  });

  // ── P4 regression: unsigned-appcast fallback gating ───────────────────────────
  // A product that expects signed updates fails closed if the matched DMG has no sibling
  // `.sig`, rather than shipping an unsigned appcast.
  it("404s when sparkle_ed25519_pub is set but the .sig asset is missing (fail closed)", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db); // sparkle_ed25519_pub = "PUBKEY==" by default
    const { env } = envFor();
    // The DMG exists but its sibling `<dmg>.sig` does NOT.
    const rel = release({
      tag_name: "v1.2.3",
      assets: [asset("djdl-arm64.dmg", 100, 4096)],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
    ]);
    const res = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "appcast",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(404);
  });

  it("renders an unsigned appcast only when artifact policy explicitly opts out", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, {
      sparkle_ed25519_pub: null,
      // The opt-out is operator policy: it lives in `operator_policy_json` (P0-01).
      operator_policy_json: JSON.stringify({ requireSparkleSignature: false }),
    });
    const { env } = envFor();
    // No `.sig` asset, and that's fine: an unsigned-pubkey product may ship without a signature.
    const rel = release({
      tag_name: "v1.2.3",
      assets: [asset("djdl-arm64.dmg", 100, 4096)],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
    ]);
    const res = await handleRelease(
      req(),
      env,
      db,
      makeProduct(),
      "appcast",
      {},
      fetchImpl,
    );
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).not.toContain("sparkle:edSignature");
    expect(xml).toContain("/djdl/release/dl/1.2.3/djdl-arm64.dmg");
    expect(xml).toContain(
      "<sparkle:shortVersionString>1.2.3</sparkle:shortVersionString>",
    );
  });
});

describe("release health", () => {
  it("reports healthy release setup when required assets and signatures exist", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const { env } = envFor();
    const rel = release({
      assets: [
        asset("djdl-arm64.dmg"),
        asset("djdl-arm64.dmg.sig"),
        asset("djdl-x86_64.dmg"),
        asset("djdl-arm64"),
        asset("djdl-x86_64"),
      ],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
    ]);

    const health = await checkReleaseHealth(
      env,
      db,
      SLUG,
      1_700_000_100,
      fetchImpl,
    );
    expect(health.status).toBe("healthy");
    expect(health.release?.tag).toBe("v1.2.3");
    expect(
      health.checks.find((c) => c.id === "sparkle-signature")?.status,
    ).toBe("ok");
  });

  it("reports missing Sparkle signature when a public key is configured", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const { env } = envFor();
    const rel = release({
      assets: [
        asset("djdl-arm64.dmg"),
        asset("djdl-arm64"),
        asset("djdl-x86_64"),
      ],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
    ]);

    const health = await checkReleaseHealth(
      env,
      db,
      SLUG,
      1_700_000_100,
      fetchImpl,
    );
    expect(health.status).toBe("needs-setup");
    expect(health.missing).toContain("djdl-arm64.dmg.sig");
  });

  it("is healthy with no DMG and no Sparkle key when the policy requires no DMG", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, {
      sparkle_ed25519_pub: null,
      artifact_policy_json: JSON.stringify({ requireDmg: false }),
    });
    const { env } = envFor();
    const rel = release({
      assets: [asset("djdl-linux-x86_64.tar.gz"), asset("djdl-arm64")],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
    ]);

    const health = await checkReleaseHealth(
      env,
      db,
      SLUG,
      1_700_000_100,
      fetchImpl,
    );
    expect(health.status).toBe("healthy");
    const ids = health.checks.map((c) => c.id);
    expect(ids).not.toContain("dmg-arm64");
    expect(ids).not.toContain("dmg-x86_64");
    expect(ids).not.toContain("sparkle-signature");
    expect(ids).not.toContain("sparkle-key");
  });

  it("still checks DMGs when requireDmg is false but the latest release ships one", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, {
      artifact_policy_json: JSON.stringify({ requireDmg: false }),
    });
    const { env } = envFor();
    const rel = release({
      assets: [asset("djdl-arm64.dmg"), asset("djdl-arm64.dmg.sig")],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
    ]);

    const health = await checkReleaseHealth(
      env,
      db,
      SLUG,
      1_700_000_100,
      fetchImpl,
    );
    expect(health.status).toBe("healthy");
    expect(health.checks.find((c) => c.id === "dmg-arm64")?.status).toBe("ok");
    // The missing Intel DMG is advisory, honouring requireDmg: false like the arm64 check.
    expect(health.checks.find((c) => c.id === "dmg-x86_64")?.status).toBe(
      "warning",
    );
    expect(
      health.checks.find((c) => c.id === "sparkle-signature")?.status,
    ).toBe("ok");
  });

  it("keeps a missing arm64 DMG as needs-setup for djdl-shaped products (no policy)", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db);
    const { env } = envFor();
    const rel = release({
      assets: [asset("djdl-arm64"), asset("djdl-x86_64")],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
    ]);

    const health = await checkReleaseHealth(
      env,
      db,
      SLUG,
      1_700_000_100,
      fetchImpl,
    );
    expect(health.status).toBe("needs-setup");
    expect(health.checks.find((c) => c.id === "dmg-arm64")?.status).toBe(
      "missing",
    );
    expect(health.missing).toContain("arm64 DMG asset");
  });

  it("requires a Sparkle key by default so appcasts fail closed", async () => {
    const db = makeTestDb();
    await seedReleaseConfig(db, { sparkle_ed25519_pub: null });
    const { env } = envFor();
    const rel = release({
      assets: [
        asset("djdl-arm64.dmg"),
        asset("djdl-arm64"),
        asset("djdl-x86_64"),
      ],
    });
    const { fetchImpl } = stubFetch([
      [
        "/releases?per_page",
        () => new Response(JSON.stringify([rel]), { status: 200 }),
      ],
    ]);

    const health = await checkReleaseHealth(
      env,
      db,
      SLUG,
      1_700_000_100,
      fetchImpl,
    );
    expect(health.status).toBe("needs-setup");
    expect(health.checks.find((c) => c.id === "sparkle-key")?.status).toBe(
      "warning",
    );
    expect(
      health.checks.find((c) => c.id === "sparkle-signature")?.status,
    ).toBe("missing");
    expect(health.missing).toContain("Sparkle public key");
  });
});

function req(url = "https://key.plrs.im/djdl/version"): Request {
  return new Request(url) as unknown as Request;
}

/** Mint a throwaway Ed25519 keypair and sign `data`, both base64 — a real Sparkle sidecar. */
async function signFixture(
  data: Uint8Array,
): Promise<{ publicKeyB64: string; signatureB64: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      pair.privateKey,
      data as BufferSource,
    ),
  );
  const b64 = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes));
  return { publicKeyB64: b64(raw), signatureB64: b64(sig) };
}
