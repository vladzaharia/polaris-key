// `feed-url-matrix.json` v1 (SP-00, plans/SP-00.md §4 and D5): the app-updater feed URLs out of
// discovery's `update.endpoints`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./common.js";
import {
  FEED_URL_KINDS,
  type FeedUrlExpect,
  type FeedUrlInput,
  refFeedUrl,
} from "./reference/feed-url.js";

// ── `feed-url-matrix.json` v1 (SP-00, plans/SP-00.md §4 and D5) ─────────────────────────────
// The app-updater feed URL a native updater is handed, built from discovery's `update.endpoints`
// rather than string-built by the caller. The templates are the Worker's own: the `everything`
// product of `packages/worker/test/fixtures/discovery-golden.json`, which discoveryGolden.test.ts
// holds byte-equal to what `updateService.discoveryFragment` serves
// (packages/worker/src/services/update/index.ts). (The transcripts' discovery fixture runs with
// Update off, so it carries no `update.endpoints`.) Reading the golden makes a Worker change to a
// template go stale here under `--check`.
//
// The expansion is the one the SDKs already ship (sdk-node `appcastUrlFrom`; Godot
// `PKeyDiscovery.appcast_url_from`, `PKeyUpdate._expand` and `PKeyUpdater.feed_url`, P3-10):
//
//   * channel: absent means `stable`; an alias is rewritten through CHANNEL_ALIASES first
//     (`staging` → `beta`, `latest` → `stable`). Validating a channel NAME is the caller's job
//     (gate-matrix's channel rows); this pins the expansion only.
//   * every `{channel}`, `{velopackChannel}` and `{buildId}` is replaced by the value encoded
//     as encodeURIComponent (UTF-8, unreserved `A-Za-z0-9-_.!~*'()` kept), in that order —
//     an encoded value cannot contain `{`, so no substitution sees another's output.
//   * `appcast` takes `endpoints.appcast` (the stable feed) and, for any other channel, makes
//     the channel a PATH segment before `/appcast.xml` — the stable feed's sibling.
//   * `velopack` with a `velopackChannel` is the releases file; without one it is the feed
//     DIRECTORY Velopack's UpdateManager is opened on (the template up to `releases.`, which
//     UpdateManager appends itself).
//   * `zsync` needs a `buildId` (the AppImage build's artifact-map id).
//   * a kind whose template the endpoints do not carry is `{unsupported: "product"}`.

const DISCOVERY_GOLDEN = join(
  REPO_ROOT,
  "packages",
  "worker",
  "test",
  "fixtures",
  "discovery-golden.json",
);

/** The keys P3-09 added after `feed` (discoveryGolden.test.ts's header names them). */
const APP_UPDATER_ENDPOINTS = [
  "winsparkle",
  "velopack",
  "appInstaller",
  "zsync",
] as const;

export function buildFeedUrlMatrixV1(): unknown {
  const golden = JSON.parse(readFileSync(DISCOVERY_GOLDEN, "utf8")) as {
    everything: { services: { update: { endpoints: Record<string, string> } } };
  };
  const everything = golden.everything.services.update.endpoints;
  for (const key of [...Object.values(FEED_URL_KINDS), "channelAppcast"])
    if (typeof everything[key] !== "string")
      throw new Error(
        `feed-url-matrix: the golden has no update.endpoints.${key}`,
      );
  // The same Worker before P3-09: the four app-updater templates are absent.
  const withoutAppUpdaterFeeds = Object.fromEntries(
    Object.entries(everything).filter(
      ([k]) => !(APP_UPDATER_ENDPOINTS as readonly string[]).includes(k),
    ),
  );
  const endpointSets: Record<string, Record<string, string>> = {
    everything,
    withoutAppUpdaterFeeds,
    // A product with Update off advertises no endpoints (`{"enabled": false}`).
    updateOff: {},
  };
  const B = "https://key.plrs.im/full/update";
  const ENC = "qa%20build%2F%C3%BC~*";
  const row = (
    name: string,
    endpoints: string,
    input: FeedUrlInput,
    expect: FeedUrlExpect,
  ) => ({ name, endpoints, input, expect });
  const no = { unsupported: "product" } as const;
  const rows = [
    row(
      "appcast — no channel is the stable feed",
      "everything",
      { kind: "appcast" },
      { url: `${B}/appcast.xml` },
    ),
    row(
      "appcast — stable",
      "everything",
      { kind: "appcast", channel: "stable" },
      { url: `${B}/appcast.xml` },
    ),
    row(
      "appcast — beta is a path segment",
      "everything",
      { kind: "appcast", channel: "beta" },
      { url: `${B}/beta/appcast.xml` },
    ),
    row(
      "appcast — staging is the beta alias",
      "everything",
      { kind: "appcast", channel: "staging" },
      { url: `${B}/beta/appcast.xml` },
    ),
    row(
      "appcast — latest is the stable alias",
      "everything",
      { kind: "appcast", channel: "latest" },
      { url: `${B}/appcast.xml` },
    ),
    row(
      "appcast — a manual channel",
      "everything",
      { kind: "appcast", channel: "nightly" },
      { url: `${B}/nightly/appcast.xml` },
    ),
    row(
      "appcast — a channel is percent-encoded",
      "everything",
      { kind: "appcast", channel: "qa build/ü~*" },
      { url: `${B}/${ENC}/appcast.xml` },
    ),
    row(
      "winsparkle — no channel is stable",
      "everything",
      { kind: "winsparkle" },
      { url: `${B}/stable/winsparkle.xml` },
    ),
    row(
      "winsparkle — beta",
      "everything",
      { kind: "winsparkle", channel: "beta" },
      { url: `${B}/beta/winsparkle.xml` },
    ),
    row(
      "winsparkle — staging is the beta alias",
      "everything",
      { kind: "winsparkle", channel: "staging" },
      { url: `${B}/beta/winsparkle.xml` },
    ),
    row(
      "winsparkle — a channel is percent-encoded",
      "everything",
      { kind: "winsparkle", channel: "qa build/ü~*" },
      { url: `${B}/${ENC}/winsparkle.xml` },
    ),
    row(
      "velopack — beta, win-x64 releases file",
      "everything",
      { kind: "velopack", channel: "beta", velopackChannel: "win-x64" },
      { url: `${B}/beta/velopack/releases.win-x64.json` },
    ),
    row(
      "velopack — staging is the beta alias",
      "everything",
      { kind: "velopack", channel: "staging", velopackChannel: "linux" },
      { url: `${B}/beta/velopack/releases.linux.json` },
    ),
    row(
      "velopack — no velopackChannel is the UpdateManager feed directory",
      "everything",
      { kind: "velopack", channel: "stable" },
      { url: `${B}/stable/velopack/` },
    ),
    row(
      "velopack — a velopackChannel is percent-encoded",
      "everything",
      { kind: "velopack", channel: "stable", velopackChannel: "win x64" },
      { url: `${B}/stable/velopack/releases.win%20x64.json` },
    ),
    row(
      "appInstaller — stable",
      "everything",
      { kind: "appInstaller", channel: "stable" },
      { url: `${B}/stable/app.appinstaller` },
    ),
    row(
      "appInstaller — latest is the stable alias",
      "everything",
      { kind: "appInstaller", channel: "latest" },
      { url: `${B}/stable/app.appinstaller` },
    ),
    row(
      "appInstaller — a pr channel",
      "everything",
      { kind: "appInstaller", channel: "pr-42" },
      { url: `${B}/pr-42/app.appinstaller` },
    ),
    row(
      "zsync — beta build",
      "everything",
      { kind: "zsync", channel: "beta", buildId: "linux-x64.appimage" },
      { url: `${B}/beta/linux-x64.appimage.AppImage.zsync` },
    ),
    row(
      "zsync — no channel is stable",
      "everything",
      { kind: "zsync", buildId: "linux-arm64" },
      { url: `${B}/stable/linux-arm64.AppImage.zsync` },
    ),
    row(
      "zsync — a channel is percent-encoded",
      "everything",
      { kind: "zsync", channel: "qa build/ü~*", buildId: "linux-arm64" },
      { url: `${B}/${ENC}/linux-arm64.AppImage.zsync` },
    ),
    row(
      "appcast — a Worker before P3-09 still serves it",
      "withoutAppUpdaterFeeds",
      { kind: "appcast", channel: "beta" },
      { url: `${B}/beta/appcast.xml` },
    ),
    row(
      "winsparkle — unsupported without the template",
      "withoutAppUpdaterFeeds",
      { kind: "winsparkle", channel: "beta" },
      no,
    ),
    row(
      "velopack — unsupported without the template",
      "withoutAppUpdaterFeeds",
      { kind: "velopack", channel: "beta", velopackChannel: "win" },
      no,
    ),
    row(
      "appInstaller — unsupported without the template",
      "withoutAppUpdaterFeeds",
      { kind: "appInstaller" },
      no,
    ),
    row(
      "zsync — unsupported without the template",
      "withoutAppUpdaterFeeds",
      { kind: "zsync", buildId: "linux-arm64" },
      no,
    ),
    row(
      "appcast — unsupported with Update off",
      "updateOff",
      { kind: "appcast" },
      no,
    ),
    row(
      "winsparkle — unsupported with Update off",
      "updateOff",
      { kind: "winsparkle", channel: "beta" },
      no,
    ),
  ];
  const names = new Set<string>();
  const kinds = new Set<string>();
  for (const r of rows) {
    if (names.has(r.name))
      throw new Error(`feed-url-matrix: two rows named ${r.name}`);
    names.add(r.name);
    kinds.add(r.input.kind);
    const set = endpointSets[r.endpoints];
    if (!set)
      throw new Error(`feed-url-matrix: ${r.name} names no endpoint set`);
    const got = refFeedUrl(set, r.input);
    if (JSON.stringify(got) !== JSON.stringify(r.expect))
      throw new Error(
        `feed-url-matrix: ${r.name} expands to ${JSON.stringify(got)}, the row says ${JSON.stringify(r.expect)}`,
      );
  }
  for (const k of Object.keys(FEED_URL_KINDS))
    if (!kinds.has(k)) throw new Error(`feed-url-matrix: no row for ${k}`);
  return {
    feedUrlMatrixVersion: 1,
    description:
      "App-updater feed URLs from discovery's `update.endpoints` (plans/SP-00.md D5; proof of `update.feeds`). `endpointSets` holds the Worker's templates — `everything` is the `everything` product of the Worker's byte-checked discovery golden, `withoutAppUpdaterFeeds` the same Worker before P3-09 added `winsparkle`, `velopack`, `appInstaller` and `zsync`, and `updateOff` a product with Update off — and `kinds` maps each feed kind to the endpoints key it reads. Each row names an endpoint set and an input `{kind, channel?, velopackChannel?, buildId?}`; `expect` is `{url}`, or `{unsupported: \"product\"}` when the set carries no template for the kind. The expansion: an absent channel is `stable`, and an alias is rewritten through CHANNEL_ALIASES (`staging` → `beta`, `latest` → `stable`) first; `{channel}`, `{velopackChannel}` and `{buildId}` are each replaced by the value encoded as encodeURIComponent. `appcast` reads `endpoints.appcast` (the stable feed) and, for any other channel, inserts the channel as a path segment before `/appcast.xml`. `velopack` without a `velopackChannel` is the feed directory Velopack's UpdateManager opens (the template up to `releases.`). A `zsync` input always carries a `buildId`. Channel-name validity is not pinned here (gate-matrix's channel rows pin it): the percent-encoded rows use a value outside the channel alphabet only to pin the encoding.",
    kinds: FEED_URL_KINDS,
    endpointSets,
    rows,
  };
}
