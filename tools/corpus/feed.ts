// `cases.json#/feedCases`: the channel feed (V4 §2.3), its content members appended last.

import {
  ALT_KID,
  AUD_V3,
  CLOCK_SKEW,
  docOfExactBytes,
  FEED_EXPIRES,
  FEED_ISSUED,
  FEED_NOW,
  FEED_TTL_REF,
  headerText,
  MAX_FEED_TTL_REF,
  MAX_WIRE_INTEGER_REF,
  PIN_KID,
  pub,
  raw,
  rawJson,
  REL_KID,
  ROLLOUT_BUCKETS_REF,
  signRawSegments,
  type TypV3,
} from "./common.js";
import { appendContentFeedCases } from "./content.js";
import { BIG_OVER, placeNonWire } from "./nonwire.js";
import {
  APP_STORE_URL,
  feedPayload,
  leafDiff,
  LIVE,
  pinOf,
  ROLLOUT_SALT,
} from "./release-records.js";
import { type FeedCase, refVerifyFeedCase } from "./reference/feed.js";
import { refVerifyJws } from "./reference/jws.js";
import { REF_CHANNEL_RE } from "./reference/patterns.js";
import { refNonWire } from "./reference/tokens.js";

export async function buildFeedCases(): Promise<FeedCase[]> {
  const TRUST = { [PIN_KID]: pub(PIN_KID) };
  const cases: FeedCase[] = [];
  const base = feedPayload();
  type Patch = (d: Record<string, any>) => void;
  const mk = async (
    id: string,
    description: string,
    o: {
      patch?: Patch;
      doc?: Record<string, unknown>;
      text?: (d: Record<string, unknown>) => string;
      kid?: string;
      /** A header kid other than the signing key's (an unknown kid). */
      headerKid?: string;
      typ?: TypV3;
      trust?: Record<string, string>;
      channel?: string;
      now?: number;
      checkFreshness?: boolean;
      floors?: FeedCase["floors"];
      /** The one property under test (a pointer prefix); the twin is `FC` with it reverted. */
      prop?: string;
      withDoc?: boolean;
      expect: "ok" | Exclude<FeedCase["expect"], { verify: "ok" }>["reason"];
    },
  ): Promise<void> => {
    const doc = o.doc ?? structuredClone(base);
    o.patch?.(doc);
    const kid = o.kid ?? PIN_KID;
    const typ = o.typ ?? "pkey-feed+jws";
    const text = o.text ? o.text(doc) : JSON.stringify(doc);
    const jws = await signRawSegments(
      headerText(typ, o.headerKid ?? kid),
      text,
      kid,
    );
    const trust = o.trust ?? TRUST;
    const parsed = JSON.parse(text) as Record<string, number>;
    const c: FeedCase = {
      id,
      description,
      jws,
      trust,
      expectedAud: AUD_V3,
      channel: o.channel ?? "stable",
      platform: "macos",
      now: o.now ?? FEED_NOW,
      checkFreshness: o.checkFreshness ?? true,
      ...(o.floors ? { floors: o.floors } : {}),
      expect:
        o.expect === "ok"
          ? {
              verify: "ok",
              seq: parsed.seq!,
              issuedAt: parsed.issuedAt!,
              ...(o.withDoc ? { doc: JSON.parse(text) } : {}),
            }
          : { verify: "fail", reason: o.expect },
    };
    const v = refVerifyJws(jws, trust, "pkey-feed+jws");
    const nonWire = v ? refNonWire(v.text) : [];
    if (o.prop !== undefined) {
      const diff = leafDiff(base, doc);
      if (
        diff.length === 0 ||
        !diff.every((p) => p === o.prop || p.startsWith(`${o.prop}/`))
      )
        throw new Error(
          `feedCases ${id}: differs from FC outside ${o.prop}: ${diff.join(", ")}`,
        );
    }
    cases.push(
      placeNonWire(nonWire.length > 0 ? { ...c, nonWireIntegers: nonWire } : c),
    );
  };
  const t0 = (d: Record<string, any>): Record<string, any> => d.app.targets[0];
  const direct0 = (d: Record<string, any>): Record<string, any> =>
    t0(d).outlets.direct;
  const raws = (d: Record<string, unknown>): string => rawJson(d);

  // Left column of §4.4.
  await mk(
    "feed-valid",
    "The control: FC, signed by the product key, fresh, on its own channel.",
    { expect: "ok", withDoc: true },
  );
  await mk(
    "feed-valid-platform-selector",
    "A per-platform document (`selector: {platform: macos}`), which the Worker serves when the channel-wide one exceeds 65 536 bytes.",
    {
      patch: (d) => {
        d.selector = { platform: "macos" };
        d.app.targets = [d.app.targets[0]];
      },
      expect: "ok",
    },
  );
  await mk(
    "feed-valid-alias-channel",
    "A request for `latest` answered with the canonical `stable`: the claim is the canonical channel.",
    { channel: "latest", expect: "ok" },
  );
  await mk(
    "feed-valid-rotated-key",
    "Signed by `djdl-test-2026`, which the effective trust set holds (pins ∪ manifest keys).",
    {
      kid: ALT_KID,
      trust: { ...TRUST, [ALT_KID]: pub(ALT_KID) },
      expect: "ok",
    },
  );
  await mk(
    "feed-valid-reload-path-expired",
    "An expired feed on the reload path (`checkFreshness: false`): it still verifies, and keeps its floor.",
    {
      now: FEED_EXPIRES + CLOCK_SKEW + 1000,
      checkFreshness: false,
      expect: "ok",
    },
  );
  await mk(
    "feed-valid-unknown-fields-ignored",
    "Reserved `packSets` and unknown members at every level are ignored.",
    {
      patch: (d) => {
        d.packSets = [];
        d.extra = { any: true };
        d.app.extra = 1;
        t0(d).extra = "x";
        direct0(d).extra = null;
      },
      expect: "ok",
    },
  );
  await mk(
    "feed-valid-at-cap",
    "A feed payload of exactly 65 536 bytes (no `doc`).",
    { doc: docOfExactBytes(65536, base), expect: "ok" },
  );
  await mk(
    "feed-valid-semver-build",
    "`semver+build`, the pin `1.5.0+46` (RB).",
    {
      patch: (d) => {
        d.app.versionScheme = "semver+build";
        for (const t of d.app.targets) {
          t.release = pinOf("RB");
          for (const e of Object.values<Record<string, any>>(t.outlets))
            if (e.live?.version === "1.5.0") e.live = LIVE("1.5.0+46", 16);
        }
      },
      expect: "ok",
    },
  );
  const to4part = (d: Record<string, any>): void => {
    d.app.versionScheme = "4part";
    for (const t of d.app.targets) {
      t.release = pinOf("R4");
      for (const e of Object.values<Record<string, any>>(t.outlets))
        if (e.live) e.live = LIVE(`${e.live.version}.0`, e.live.seq);
    }
  };
  await mk("feed-valid-4part", "`4part`, the pin `1.5.0.0` (R4).", {
    patch: to4part,
    expect: "ok",
  });
  await mk(
    "feed-valid-unknown-kind-ignored",
    "An entry of kind `epic`, outside the 17: allowed, never matched, and its `listingUrl` is only type-checked.",
    {
      patch: (d) => {
        t0(d).outlets["epic-store"] = {
          kind: "epic",
          live: null,
          halted: false,
          listingUrl: "https://store.epicgames.com/p/diceroll",
        };
      },
      prop: "/app/targets/0/outlets/epic-store",
      expect: "ok",
    },
  );
  await mk(
    "feed-valid-floors-per-target",
    "Each target carries its own platform's floor: macOS `1.5.0`, Windows null.",
    {
      patch: (d) => {
        t0(d).floor = { minVersion: "1.5.0" };
      },
      prop: "/app/targets/0/floor",
      expect: "ok",
    },
  );
  const atMax = (d: Record<string, any>): void => {
    d.seq = MAX_WIRE_INTEGER_REF;
    t0(d).release = pinOf("R15max");
    direct0(d).live = LIVE("1.5.0", MAX_WIRE_INTEGER_REF);
  };
  await mk(
    "feed-valid-seq-at-max",
    "`seq`, the macOS pin's `seq` and its `direct` live `seq` all at 2^53 − 1.",
    { patch: atMax, expect: "ok" },
  );
  await mk(
    "feed-valid-seq-ceiling-recovery",
    "The `seq` ceiling recovery (V4 §4): a feed at 2^53 − 1 with a newer `issuedAt` than the committed one at the ceiling is accepted.",
    {
      patch: atMax,
      floors: {
        stable: { seq: MAX_WIRE_INTEGER_REF, issuedAt: FEED_ISSUED - 1000 },
      },
      expect: "ok",
    },
  );
  await mk(
    "feed-seq-equal-newer-issued",
    "Equal `seq`, newer `issuedAt`: a re-signing of the same content, accepted.",
    {
      floors: { stable: { seq: 7, issuedAt: FEED_ISSUED - 1000 } },
      expect: "ok",
    },
  );
  await mk(
    "feed-seq-higher-older-issued",
    "A higher `seq` with an older `issuedAt`: `seq` is primary.",
    {
      floors: { stable: { seq: 6, issuedAt: FEED_ISSUED + 500 } },
      expect: "ok",
    },
  );
  await mk(
    "feed-expires-within-skew",
    "`now = expiresAt + 299`: inside the skew, still fresh.",
    { now: FEED_EXPIRES + CLOCK_SKEW - 1, expect: "ok" },
  );
  await mk("feed-wrong-typ", "FC signed as `pkey-license+jws`.", {
    typ: "pkey-license+jws",
    expect: "jws",
  });
  await mk(
    "feed-signed-by-release-key",
    "FC signed by a RELEASE key: release keys are a separate input and never in a feed's trust set.",
    { kid: REL_KID, expect: "jws" },
  );
  await mk("feed-unknown-kid", "FC under a kid the trust set does not hold.", {
    headerKid: "pkey-test-unknown-2026",
    expect: "jws",
  });
  await mk(
    "feed-expired-network",
    "On the network path at `now = expiresAt + 300`: stale.",
    { now: FEED_EXPIRES + CLOCK_SKEW, expect: "freshness" },
  );
  await mk("feed-future-dated", "`issuedAt` 301 s ahead of `now`.", {
    patch: (d) => {
      d.issuedAt = FEED_NOW + CLOCK_SKEW + 1;
      d.expiresAt = d.issuedAt + FEED_TTL_REF;
    },
    expect: "freshness",
  });
  await mk(
    "feed-seq-equal-same-issued",
    "The committed feed again (equal `seq` and `issuedAt`): `not-newer`, kept silently.",
    {
      floors: { stable: { seq: 7, issuedAt: FEED_ISSUED } },
      expect: "not-newer",
    },
  );
  await mk(
    "feed-seq-equal-older-issued",
    "Equal `seq`, older `issuedAt`: an older signing from a cache, `not-newer`.",
    {
      floors: { stable: { seq: 7, issuedAt: FEED_ISSUED + 500 } },
      expect: "not-newer",
    },
  );
  await mk("feed-seq-rollback", "A lower `seq` than the floor: `rollback`.", {
    floors: { stable: { seq: 8, issuedAt: FEED_ISSUED - 1000 } },
    expect: "rollback",
  });
  await mk(
    "feed-wrong-channel",
    "A request for `stable` answered with `beta`.",
    {
      patch: (d) => void (d.channel = "beta"),
      prop: "/channel",
      expect: "channel",
    },
  );
  await mk(
    "feed-selector-other-platform",
    "A Windows document served to a macOS client.",
    {
      patch: (d) => {
        d.selector = { platform: "windows" };
        d.app.targets = [d.app.targets[1]];
      },
      expect: "selector",
    },
  );
  await mk(
    "feed-selector-unknown-key",
    "A selector key a v4 client does not know (P4 may add keys).",
    {
      patch: (d) => void (d.selector = { contentApi: "2" }),
      prop: "/selector",
      expect: "selector",
    },
  );
  await mk(
    "feed-schema-version-near-integer",
    'V4 §3: `"schemaVersion":1.0000000000000001`.',
    {
      patch: (d) => void (d.schemaVersion = raw("1.0000000000000001")),
      text: raws,
      prop: "/schemaVersion",
      expect: "claims",
    },
  );
  await mk(
    "feed-expires-at-near-integer",
    "V4 §3: the `expiresAt` token `1700000900.00000001`.",
    {
      patch: (d) => void (d.expiresAt = raw("1700000900.00000001")),
      text: raws,
      prop: "/expiresAt",
      expect: "claims",
    },
  );
  await mk(
    "feed-expires-at-over-max",
    "V4 §3: only `expiresAt` (9007199254740993) is above 2^53 − 1.",
    {
      patch: (d) => {
        d.issuedAt = 9007199254740000;
        d.expiresAt = raw(BIG_OVER);
      },
      text: raws,
      now: 9007199254740100,
      expect: "claims",
    },
  );
  await mk(
    "feed-outlet-live-missing",
    "V4 §3 presence: an entry with no `live` member (null is allowed, missing is not).",
    {
      patch: (d) => void delete direct0(d).live,
      prop: "/app/targets/0/outlets/direct/live",
      expect: "claims",
    },
  );
  await mk(
    "feed-listing-url-non-ascii",
    "An `app-store` `listingUrl` of 1 038 characters and 2 049 bytes: lengths count bytes, and the URL must be printable ASCII.",
    {
      patch: (d) =>
        void (t0(d).outlets["app-store"].listingUrl =
          `https://apps.apple.com/app/${"\u00e9".repeat(1011)}`),
      prop: "/app/targets/0/outlets/app-store/listingUrl",
      expect: "claims",
    },
  );
  await mk(
    "feed-target-version-trailing-newline",
    'Whole-string patterns: the pin\'s `version` `"1.5.0\\n"`.',
    {
      patch: (d) => void (t0(d).release.version = "1.5.0\n"),
      prop: "/app/targets/0/release/version",
      expect: "claims",
    },
  );
  await mk(
    "feed-channel-trailing-newline",
    'Whole-string patterns: `"channel":"stable\\n"` (a lenient match would fail at `channel` instead).',
    {
      patch: (d) => void (d.channel = "stable\n"),
      prop: "/channel",
      expect: "claims",
    },
  );
  await mk(
    "feed-rollout-salt-trailing-newline",
    "Whole-string patterns: the `direct` entry's rollout `salt` followed by `\\n`.",
    {
      patch: (d) =>
        void (direct0(d).rollout = { bp: 5000, salt: `${ROLLOUT_SALT}\n` }),
      prop: "/app/targets/0/outlets/direct/rollout",
      expect: "claims",
    },
  );
  await mk(
    "feed-alias-staging-beta-floor-applies",
    "A request for `staging` answered with the canonical `beta` meets `floors.beta`: the floor is keyed by the claim, never by the requested name.",
    {
      patch: (d) => void (d.channel = "beta"),
      channel: "staging",
      floors: { beta: { seq: 9, issuedAt: FEED_ISSUED } },
      expect: "rollback",
    },
  );
  await mk("feed-target-seq-zero", "V4 §3 minimums: the pin's `seq` 0.", {
    patch: (d) => void (t0(d).release.seq = 0),
    prop: "/app/targets/0/release/seq",
    expect: "claims",
  });
  await mk("feed-rollout-bp-negative", 'V4 §3 minimums: `"bp":-1`.', {
    patch: (d) => void (direct0(d).rollout = { bp: -1, salt: ROLLOUT_SALT }),
    prop: "/app/targets/0/outlets/direct/rollout",
    expect: "claims",
  });
  await mk(
    "feed-target-platform-non-ascii",
    "`FEED_PLATFORM_PATTERN` is ASCII: a second target whose platform is `macoś` (its twin `freebsd`, an unknown ASCII platform, verifies).",
    {
      patch: (d) =>
        void d.app.targets.push({
          ...structuredClone(t0(d)),
          platform: "maco\u015b",
        }),
      prop: "/app/targets/2",
      expect: "claims",
    },
  );
  // Right column of §4.4.
  await mk("feed-wrong-aud", "A feed scoped to another product.", {
    patch: (d) => void (d.aud = "other-product"),
    prop: "/aud",
    expect: "claims",
  });
  await mk("feed-wrong-iss", "A foreign `iss`.", {
    patch: (d) => void (d.iss = "https://evil.example"),
    prop: "/iss",
    expect: "claims",
  });
  await mk("feed-schema-version-2", "`schemaVersion: 2`.", {
    patch: (d) => void (d.schemaVersion = 2),
    prop: "/schemaVersion",
    expect: "claims",
  });
  await mk(
    "feed-ttl-over-max",
    "`expiresAt = issuedAt + 3601`, past `MAX_FEED_TTL_SECONDS`.",
    {
      patch: (d) => void (d.expiresAt = d.issuedAt + MAX_FEED_TTL_REF + 1),
      prop: "/expiresAt",
      expect: "claims",
    },
  );
  await mk("feed-expires-not-after-issued", "`expiresAt = issuedAt`.", {
    patch: (d) => void (d.expiresAt = d.issuedAt),
    prop: "/expiresAt",
    expect: "claims",
  });
  await mk("feed-target-bad-sha256", "A pin that is not 64 lowercase hex.", {
    patch: (d) => void (t0(d).release.sha256 = t0(d).release.sha256.slice(1)),
    prop: "/app/targets/0/release/sha256",
    expect: "claims",
  });
  await mk("feed-duplicate-platform-target", "Two targets for one platform.", {
    patch: (d) => void (d.app.targets[1].platform = "macos"),
    prop: "/app/targets/1/platform",
    expect: "claims",
  });
  await mk(
    "feed-target-outside-selector",
    "`selector.platform` is macOS but a target is Windows.",
    {
      patch: (d) => void (d.selector = { platform: "macos" }),
      prop: "/selector",
      expect: "claims",
    },
  );
  await mk("feed-rollout-bp-over-max", "`bp` 10 001, past 10 000.", {
    patch: (d) =>
      void (direct0(d).rollout = {
        bp: ROLLOUT_BUCKETS_REF + 1,
        salt: ROLLOUT_SALT,
      }),
    prop: "/app/targets/0/outlets/direct/rollout",
    expect: "claims",
  });
  await mk(
    "feed-floor-not-in-scheme",
    "A target floor `1.5` that does not parse under `semver`.",
    {
      patch: (d) => void (t0(d).floor = { minVersion: "1.5" }),
      prop: "/app/targets/0/floor",
      expect: "claims",
    },
  );
  await mk(
    "feed-floor-above-target",
    "A floor `1.6.0` above the pin `1.5.0`.",
    {
      patch: (d) => void (t0(d).floor = { minVersion: "1.6.0" }),
      prop: "/app/targets/0/floor",
      expect: "claims",
    },
  );
  await mk("feed-seq-zero", "V4 §3 minimums: `seq` 0.", {
    patch: (d) => void (d.seq = 0),
    prop: "/seq",
    expect: "claims",
  });
  await mk("feed-seq-fraction", 'V4 §3: `"seq":7.5`.', {
    patch: (d) => void (d.seq = 7.5),
    prop: "/seq",
    expect: "claims",
  });
  await mk(
    "feed-seq-integral-fraction",
    'V4 §3: `"seq":7.0`, an integer claim\'s token.',
    {
      patch: (d) => void (d.seq = raw("7.0")),
      text: raws,
      prop: "/seq",
      expect: "claims",
    },
  );
  await mk(
    "feed-seq-near-integer",
    'V4 §3: `"seq":7.0000000000000001`, which Node, Swift and Godot read as 7.',
    {
      patch: (d) => void (d.seq = raw("7.0000000000000001")),
      text: raws,
      prop: "/seq",
      expect: "claims",
    },
  );
  await mk(
    "feed-target-seq-near-integer",
    "V4 §3: the pin's `seq` token `15.0000000000000001`, at `/app/targets/0/release/seq`.",
    {
      patch: (d) => void (t0(d).release.seq = raw("15.0000000000000001")),
      text: raws,
      prop: "/app/targets/0/release/seq",
      expect: "claims",
    },
  );
  await mk(
    "feed-rollout-bp-exponent",
    'V4 §3: `"bp":25e2`, at `/app/targets/0/outlets/direct/rollout/bp`.',
    {
      patch: (d) =>
        void (direct0(d).rollout = { bp: raw("25e2"), salt: ROLLOUT_SALT }),
      text: raws,
      prop: "/app/targets/0/outlets/direct/rollout",
      expect: "claims",
    },
  );
  await mk("feed-seq-over-max", "V4 §3: `seq` 9007199254740992.", {
    patch: (d) => void (d.seq = 9007199254740992),
    prop: "/seq",
    expect: "claims",
  });
  await mk(
    "feed-target-seq-over-max",
    "V4 §3: the pin's `seq` 9007199254740993, which JavaScript reads as 2^53.",
    {
      patch: (d) => void (t0(d).release.seq = raw(BIG_OVER)),
      text: raws,
      prop: "/app/targets/0/release/seq",
      expect: "claims",
    },
  );
  await mk("feed-live-seq-over-max", "V4 §3: a live `seq` 18014398509481984.", {
    patch: (d) => void (direct0(d).live.seq = 18014398509481984),
    prop: "/app/targets/0/outlets/direct/live/seq",
    expect: "claims",
  });
  await mk("feed-version-scheme-unknown", "`versionScheme: calver`.", {
    patch: (d) => void (d.app.versionScheme = "calver"),
    prop: "/app/versionScheme",
    expect: "claims",
  });
  await mk(
    "feed-target-version-not-in-scheme",
    "`4part` with a pin `1.5.0` (every live version is four-part).",
    {
      patch: (d) => {
        to4part(d);
        t0(d).release.version = "1.5.0";
      },
      expect: "claims",
    },
  );
  await mk("feed-outlet-kind-missing", "An entry with no `kind`.", {
    patch: (d) => void delete direct0(d).kind,
    prop: "/app/targets/0/outlets/direct/kind",
    expect: "claims",
  });
  await mk(
    "feed-outlet-kind-literal-unknown",
    "An entry of kind `unknown`, a detection result that nothing can declare.",
    {
      patch: (d) => void (direct0(d).kind = "unknown"),
      prop: "/app/targets/0/outlets/direct/kind",
      expect: "claims",
    },
  );
  await mk(
    "feed-listing-url-foreign-host",
    "`https://apps.apple.com.example/…`: the prefix is compared byte for byte, `/` included.",
    {
      patch: (d) =>
        void (t0(d).outlets["app-store"].listingUrl =
          "https://apps.apple.com.example/app/id1234567890"),
      prop: "/app/targets/0/outlets/app-store/listingUrl",
      expect: "claims",
    },
  );
  await mk(
    "feed-listing-url-on-kind-without-prefixes",
    "An `altstore` entry carrying a `listingUrl`: AltStore sources are code-delivery paths, so the kind has no prefixes.",
    {
      patch: (d) =>
        void (t0(d).outlets.altstore = {
          kind: "altstore",
          live: null,
          halted: false,
          listingUrl: "https://apps.apple.com/app/id1234567890",
        }),
      prop: "/app/targets/0/outlets/altstore",
      expect: "claims",
    },
  );
  {
    const prefix = `${APP_STORE_URL}?x=`;
    await mk(
      "feed-valid-listing-url-at-max",
      "An `app-store` `listingUrl` of exactly 2 048 ASCII bytes.",
      {
        patch: (d) =>
          void (t0(d).outlets["app-store"].listingUrl =
            prefix + "a".repeat(2048 - prefix.length)),
        prop: "/app/targets/0/outlets/app-store/listingUrl",
        expect: "ok",
      },
    );
    await mk(
      "feed-listing-url-over-max",
      "2 049 ASCII bytes under the `app-store` prefix.",
      {
        patch: (d) =>
          void (t0(d).outlets["app-store"].listingUrl =
            prefix + "a".repeat(2049 - prefix.length)),
        prop: "/app/targets/0/outlets/app-store/listingUrl",
        expect: "claims",
      },
    );
  }
  await mk(
    "feed-issued-at-near-integer",
    "V4 §3: the `issuedAt` token `1700000000.00000001`.",
    {
      patch: (d) => void (d.issuedAt = raw("1700000000.00000001")),
      text: raws,
      prop: "/issuedAt",
      expect: "claims",
    },
  );
  await mk(
    "feed-live-seq-near-integer",
    "V4 §3: the first target's `direct` live `seq` token `15.0000000000000001`.",
    {
      patch: (d) => void (direct0(d).live.seq = raw("15.0000000000000001")),
      text: raws,
      prop: "/app/targets/0/outlets/direct/live/seq",
      expect: "claims",
    },
  );
  await mk(
    "feed-target-floor-missing",
    "V4 §3 presence: a target with no `floor` member.",
    {
      patch: (d) => void delete t0(d).floor,
      prop: "/app/targets/0/floor",
      expect: "claims",
    },
  );
  await mk(
    "feed-outlet-rollout-null",
    "V4 §3 presence: `rollout: null` (an optional member is absent or typed).",
    {
      patch: (d) => void (direct0(d).rollout = null),
      prop: "/app/targets/0/outlets/direct/rollout",
      expect: "claims",
    },
  );
  await mk(
    "feed-outlet-id-trailing-newline",
    'Whole-string patterns: an outlet key `"direct\\n"` of kind `direct`.',
    {
      patch: (d) => {
        const outlets = t0(d).outlets;
        t0(d).outlets = {
          "direct\n": outlets.direct,
          "app-store": outlets["app-store"],
        };
      },
      expect: "claims",
    },
  );
  await mk(
    "feed-target-sha256-trailing-newline",
    "Whole-string patterns: the pin's `sha256` followed by `\\n`.",
    {
      patch: (d) => void (t0(d).release.sha256 += "\n"),
      prop: "/app/targets/0/release/sha256",
      expect: "claims",
    },
  );
  await mk(
    "feed-valid-manual-staging-beta-floor-ignored",
    "A product with a manual `staging` channel: the claim is `staging`, so `floors.beta` does not apply (a runner that resolved `staging` itself would fail here).",
    {
      patch: (d) => void (d.channel = "staging"),
      channel: "staging",
      floors: { beta: { seq: 9, issuedAt: FEED_ISSUED } },
      expect: "ok",
    },
  );
  await mk(
    "feed-channel-latest-claim",
    "A request for `latest` answered with the claim `latest`, which is never canonical (it always resolves to `stable`).",
    {
      patch: (d) => void (d.channel = "latest"),
      channel: "latest",
      expect: "channel",
    },
  );
  await mk(
    "feed-live-seq-zero",
    "V4 §3 minimums: the first target's `direct` live `seq` 0.",
    {
      patch: (d) => void (direct0(d).live.seq = 0),
      prop: "/app/targets/0/outlets/direct/live/seq",
      expect: "claims",
    },
  );
  await mk(
    "feed-issued-at-negative",
    "V4 §3 minimums: `issuedAt` −1 (`expiresAt` 899) on the reload path; on the network path the freshness window refuses it first.",
    {
      patch: (d) => {
        d.issuedAt = -1;
        d.expiresAt = 899;
      },
      checkFreshness: false,
      expect: "claims",
    },
  );

  // plans/P4-13.md §4.2: three appended cases carrying the content members.
  await appendContentFeedCases(mk, base);

  if (cases.length !== 80) throw new Error(`feedCases: ${cases.length} != 80`);
  for (const c of cases) {
    const want = refVerifyFeedCase(c);
    const got = c.expect;
    if (
      want.verify !== got.verify ||
      (want.verify === "fail" &&
        got.verify === "fail" &&
        want.reason !== got.reason) ||
      (want.verify === "ok" &&
        got.verify === "ok" &&
        (want.seq !== got.seq || want.issuedAt !== got.issuedAt))
    )
      throw new Error(
        `feedCases: the reference answers ${JSON.stringify(want)} for ${c.id}`,
      );
    for (const k of Object.keys(c.floors ?? {}))
      if (!REF_CHANNEL_RE.test(k) || k === "latest")
        throw new Error(`feedCases ${c.id}: floor key ${k}`);
  }
  return cases;
}
