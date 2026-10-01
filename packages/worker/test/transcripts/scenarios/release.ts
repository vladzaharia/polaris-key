/// <reference types="@cloudflare/workers-types" />
// release-changelog and release-changelog-entitled: the Release service's public face (P1b-07,
// PARITY §5.5 `release.changelog` and `release.download`).
//
// The changelog is a plain JSON GET; the install and download URLs are BUILT, never fetched (the
// caller streams the artifact itself), so their steps carry no exchange and pin only the URL each
// SDK must produce. The scenario proves the Worker serves both URLs by requesting them outside
// the recording.
//
// GitHub is the Release service's upstream. The recording stubs it at the global `fetch` the
// Worker's release surfaces default to, with a fixed release list, so the transcript pins what
// the Worker makes of it and not what GitHub happens to say today.
//
// ── THE REFUSALS ────────────────────────────────────────────────────────────────────────────
//
// Under the `entitled` access mode (D-13) a changelog read needs a usable licence: no token is a
// `401 unauthorized` in the nested v3 shape. A changelog read cannot be refused with a 403 —
// `/release/changelog` names no channel, which `entitledSelectorFor` classifies as stable, the
// channel every grant holds — so the 401 is the refusal these transcripts pin. Every SDK surfaces
// the refusal body's own code rather than inventing one.

import { vi, expect } from "vitest";
import {
  BASE_URL,
  TranscriptRecorder,
  type StepRecorder,
} from "../recorder.js";
import { DEVICE, T0, VERSION } from "../client.js";
import {
  activated,
  pinned,
  PRODUCT,
  productWorld,
  seedLicense,
  servicesOn,
  setup,
  type Scenario,
} from "../world.js";
import type { World } from "../recorder.js";
import type { ServicesMap } from "../../../src/core/services.js";
import { TEST_RSA_PKCS8 } from "../../releaseFixtures.js";

/** License + Config + Release. Update stays off: these conversations are Release's alone. */
const WITH_RELEASE: ServicesMap = servicesOn("license", "config", "release");

/** A fixed sha256 digest for the checksum sidecar. */
const DIGEST = "a".repeat(64);

/** The upstream release list, newest first: a curated summary, a release with no summary (the
 *  Worker answers `summary: null` — an SDK must not turn that into a string), and a draft the
 *  Worker never lists. */
const RELEASES = [
  {
    tag_name: "v1.3.0",
    name: "1.3.0",
    body: "Unpublished.",
    published_at: null,
    html_url: "https://github.com/acme/djdl/releases/tag/v1.3.0",
    prerelease: false,
    draft: true,
    assets: [],
  },
  {
    tag_name: "v1.2.0",
    name: "1.2.0",
    body: "<!-- pkey:summary -->Faster sync.<!-- /pkey:summary -->\n## Changes\n- sync",
    published_at: "2023-11-10T00:00:00Z",
    html_url: "https://github.com/acme/djdl/releases/tag/v1.2.0",
    prerelease: false,
    draft: false,
    assets: [
      {
        id: 101,
        name: "djdl-arm64",
        size: 1024,
        content_type: "application/octet-stream",
        browser_download_url:
          "https://github.com/acme/djdl/releases/download/v1.2.0/djdl-arm64",
      },
      {
        id: 102,
        name: "djdl-arm64.sha256",
        size: 76,
        content_type: "text/plain",
        browser_download_url:
          "https://github.com/acme/djdl/releases/download/v1.2.0/djdl-arm64.sha256",
      },
    ],
  },
  {
    tag_name: "v1.1.0",
    name: "1.1.0",
    body: null,
    published_at: "2023-11-01T00:00:00Z",
    html_url: "https://github.com/acme/djdl/releases/tag/v1.1.0",
    prerelease: false,
    draft: false,
    assets: [],
  },
];

/** The fake GitHub: the App token exchange, the release list, one tag lookup, one sidecar. */
function fakeGitHub(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  if (url.includes("/access_tokens"))
    return Promise.resolve(json({ token: "ghs_transcript_installation" }));
  if (url.includes("/releases/tags/v1.2.0"))
    return Promise.resolve(json(RELEASES[1]));
  if (url.includes("/releases/assets/102"))
    return Promise.resolve(new Response(`${DIGEST}  djdl-arm64\n`));
  if (url.includes("/releases?per_page"))
    return Promise.resolve(json(RELEASES));
  return Promise.resolve(new Response("not found", { status: 404 }));
}

/** A world running Release against `acme/djdl`, with the given metadata access mode. */
async function releaseWorld(metadataAccess: string): Promise<World> {
  const world = await productWorld(WITH_RELEASE);
  world.env.GITHUB_APP_ID = "12345";
  world.env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  await world.db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker,
        artifact_policy_json, metadata_access, artifacts_access, operator_policy_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    PRODUCT,
    "acme",
    "djdl",
    42,
    null,
    "main",
    "[]",
    "djdl",
    null,
    null,
    "pkey:summary",
    null,
    metadataAccess,
    "public",
    null,
  );
  return world;
}

/** Run `body` with GitHub faked at the global `fetch`, always restoring it. */
async function withFakeGitHub<T>(body: () => Promise<T>): Promise<T> {
  vi.stubGlobal("fetch", fakeGitHub);
  try {
    return await body();
  } finally {
    vi.unstubAllGlobals();
  }
}

/** `GET /<p>/release/changelog`, with the bearer when the client holds one. */
function changelog(s: StepRecorder, bearer: boolean): Promise<Response> {
  return s.send({
    method: "GET",
    path: `/${PRODUCT}/release/changelog`,
    metadata: false,
    ...(bearer ? { bearer: "token" as const } : {}),
  });
}

/** The entries the Worker derives from RELEASES. */
const ENTRIES = [
  {
    version: "1.2.0",
    tag: "v1.2.0",
    date: "2023-11-10T00:00:00Z",
    summary: "Faster sync.",
    url: "https://github.com/acme/djdl/releases/tag/v1.2.0",
  },
  {
    version: "1.1.0",
    tag: "v1.1.0",
    date: "2023-11-01T00:00:00Z",
    summary: null,
    url: "https://github.com/acme/djdl/releases/tag/v1.1.0",
  },
];

const INSTALL_PATH = `/${PRODUCT}/release/install.sh`;
const DOWNLOAD_PATH = `/${PRODUCT}/release/dl/1.2.0/djdl-arm64?checksum=sha256`;

export const releaseChangelog: Scenario = {
  id: "release-changelog",
  record: () =>
    pinned("release-changelog", (pin) =>
      withFakeGitHub(async () => {
        const world = await releaseWorld("public");
        const r = new TranscriptRecorder({
          id: "release-changelog",
          description:
            "The Release client (D-05): the changelog, the install URL and the download URL, for a client holding no device token. changelog() is a plain GET returning the Worker's entries verbatim (a null summary stays null); installUrl() and downloadUrl() BUILD their URLs without a request. When the operator then moves the product's release metadata to the entitled access mode (D-13), the unauthenticated changelog read is refused 401, and the SDK raises the refusal body's own code.",
          features: ["release.changelog", "release.download"],
          requires: [],
          product: PRODUCT,
          now: T0,
          world,
          pinned: pin,
          initial: {
            deviceId: DEVICE,
            version: VERSION,
            services: ["license", "config", "release"],
          },
        });
        await r.step(
          { action: "changelog" },
          async (s) => {
            const res = await changelog(s, false);
            expect(res.status).toBe(200);
            expect(
              ((await res.json()) as { entries: unknown }).entries,
            ).toEqual(ENTRIES);
          },
          { result: "ok", entries: ENTRIES },
        );

        await r.step(
          {
            action: "installUrl",
            note: "Built, not fetched: no request.",
          },
          async () => {
            const res = await setup(world, "GET", INSTALL_PATH, {});
            expect(res.status).toBe(200);
          },
          { url: `${BASE_URL}${INSTALL_PATH}` },
        );

        await r.step(
          {
            action: "downloadUrl",
            args: {
              version: "1.2.0",
              binary: "djdl",
              arch: "arm64",
              checksum: true,
            },
            note: "Built, not fetched: no request. The Worker serves the sidecar's digest there.",
          },
          async () => {
            const res = await setup(world, "GET", DOWNLOAD_PATH, {});
            expect(res.status).toBe(200);
            expect(await res.text()).toBe(`${DIGEST}\n`);
          },
          { url: `${BASE_URL}${DOWNLOAD_PATH}` },
        );

        await world.db.run(
          "UPDATE release_config SET metadata_access = 'entitled' WHERE product = ?",
          PRODUCT,
        );
        await r.step(
          {
            action: "changelog",
            now: T0 + 60,
            note: "Release metadata is now entitled: no token is a 401, surfaced by its code.",
          },
          async (s) => {
            const res = await changelog(s, false);
            expect(res.status).toBe(401);
            expect(await res.json()).toEqual({
              error: { code: "unauthorized" },
            });
          },
          { result: "error", code: "unauthorized" },
        );
        return r.transcript();
      }),
    ),
};

export const releaseChangelogEntitled: Scenario = {
  id: "release-changelog-entitled",
  record: () =>
    pinned("release-changelog-entitled", (pin) =>
      withFakeGitHub(async () => {
        const world = await releaseWorld("entitled");
        const { key } = await seedLicense(world);
        const token = await activated(world, key);
        const r = new TranscriptRecorder({
          id: "release-changelog-entitled",
          description:
            "The changelog under the entitled access mode (D-13), for an activated client. The client forwards the device token it holds as a bearer on the changelog read, and the Worker serves the entries because the licence is usable.",
          features: ["release.changelog"],
          requires: ["core.store"],
          product: PRODUCT,
          now: T0,
          world,
          pinned: pin,
          initial: {
            deviceId: DEVICE,
            token,
            version: VERSION,
            services: ["license", "config", "release"],
          },
        });
        await r.step(
          { action: "changelog" },
          async (s) => {
            const res = await changelog(s, true);
            expect(res.status).toBe(200);
            expect(
              ((await res.json()) as { entries: unknown }).entries,
            ).toEqual(ENTRIES);
          },
          { result: "ok", entries: ENTRIES },
        );
        return r.transcript();
      }),
    ),
};
